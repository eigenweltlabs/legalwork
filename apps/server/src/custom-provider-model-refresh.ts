import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLegalworkWorkspaceConfig, writeLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { discoverProviderModels } from "./provider-model-discovery.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export const CUSTOM_PROVIDER_REFRESH_MS = 60 * 60 * 1000;
type RefreshOptions = { providerId?: string; force?: boolean; reloadRequired?: boolean; catalog?: boolean };
type RefreshResult = { providers: Record<string, CustomProviderModelRefreshStatus>; reloaded: boolean };

export type CustomProviderModelRefreshStatus = {
  enabled: boolean;
  disconnected?: boolean;
  baseURL?: string;
  availableModels?: string[];
  lastCheckedAt?: number;
  lastUpdatedAt?: number;
  lastError?: string | null;
  pendingReload?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readModelRefreshSettings(value: unknown): Record<string, CustomProviderModelRefreshStatus> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, entry]) => !isRecord(entry) ? [] : [[id, {
    enabled: entry.enabled === true,
    disconnected: entry.disconnected === true,
    baseURL: typeof entry.baseURL === "string" ? entry.baseURL : undefined,
    availableModels: Array.isArray(entry.availableModels) ? entry.availableModels.filter((id): id is string => typeof id === "string") : undefined,
    lastCheckedAt: typeof entry.lastCheckedAt === "number" ? entry.lastCheckedAt : undefined,
    lastUpdatedAt: typeof entry.lastUpdatedAt === "number" ? entry.lastUpdatedAt : undefined,
    lastError: typeof entry.lastError === "string" ? entry.lastError : null,
    pendingReload: entry.pendingReload === true,
  }]]));
}

export function providerBaseURL(provider: unknown): string {
  if (!isRecord(provider) || !isRecord(provider.options)) return "";
  return typeof provider.options.baseURL === "string" ? provider.options.baseURL.trim().replace(/\/+$/, "") : "";
}

/** Whether the engine keeps a key or sign-in of the member's for a provider. */
export async function hasStoredProviderAuth(providerId: string): Promise<boolean> {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  try {
    const auth: unknown = JSON.parse(await readFile(join(dataHome, "opencode", "auth.json"), "utf8"));
    return isRecord(auth) && isRecord(auth[providerId]);
  } catch {
    return false;
  }
}

/** Keys stay on the worker; callers can only reuse a key for its saved endpoint. */
export async function readStoredProviderApiKey(providerId: string, provider: unknown): Promise<string> {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  try {
    const auth: unknown = JSON.parse(await readFile(join(dataHome, "opencode", "auth.json"), "utf8"));
    const entry = isRecord(auth) ? auth[providerId] : null;
    if (isRecord(entry) && entry.type === "api" && typeof entry.key === "string") return entry.key.trim();
  } catch {
    // A local endpoint may not need authentication.
  }
  const options = isRecord(provider) && isRecord(provider.options) ? provider.options : {};
  return typeof options.apiKey === "string" ? options.apiKey : "";
}

export function createCustomProviderModelRefresh(input: {
  config: ServerConfig;
  readProviders: (workspace: WorkspaceInfo) => Promise<Record<string, unknown>>;
  readCatalogModels?: (workspace: WorkspaceInfo, providerId: string) => Promise<Record<string, unknown>>;
  isBusy: (workspace: WorkspaceInfo) => Promise<boolean>;
  reload: (workspace: WorkspaceInfo) => Promise<void>;
  now?: () => number;
}) {
  const running = new Map<string, Promise<RefreshResult>>();
  // The managed engine shares one derived config file across workspace instances.
  let reloadQueue = Promise.resolve();

  async function run(workspace: WorkspaceInfo, options: RefreshOptions) {
    const { config } = input;
    const now = input.now?.() ?? Date.now();
    const settings = readModelRefreshSettings((await readLegalworkWorkspaceConfig(config, workspace.id)).customProviderModelRefresh);
    if (!options.providerId && !Object.values(settings).some((status) => status.enabled || status.pendingReload)) return { providers: settings, reloaded: false };
    const providers = await input.readProviders(workspace);
    const originalRuntime = await readRuntimeOpencodeConfig(config, workspace.id);
    if (options.reloadRequired && options.providerId && isRecord(providers[options.providerId])) {
      settings[options.providerId] = { ...settings[options.providerId], enabled: settings[options.providerId]?.enabled === true, pendingReload: true };
    }
    const ids = options.providerId ? [options.providerId] : Object.keys(settings);
    const fromCatalog = options.catalog === true && options.force === true;
    for (const id of ids) {
      const provider = fromCatalog ? (isRecord(providers[id]) ? providers[id] : {}) : providers[id];
      const baseURL = providerBaseURL(provider);
      const status = settings[id] ?? { enabled: false };
      if ((!baseURL && !fromCatalog) || !isRecord(provider) || status.disconnected || (!status.enabled && !options.force)) continue;
      if (!options.force && status.baseURL === baseURL && now - (status.lastCheckedAt ?? 0) < CUSTOM_PROVIDER_REFRESH_MS) continue;
      try {
        const modelDefinitions = fromCatalog
          ? await input.readCatalogModels?.(workspace, id)
          : Object.fromEntries((await discoverProviderModels(baseURL, await readStoredProviderApiKey(id, provider))).map(model => [model, { name: model, tool_call: true }]));
        if (!modelDefinitions) throw new Error("Model catalog refresh is unavailable on this worker.");
        const models = Object.keys(modelDefinitions);
        // Do not restore a provider disconnected or edited while discovery was in flight.
        const latestProvider = (await input.readProviders(workspace))[id];
        if ((!fromCatalog && !isRecord(latestProvider)) || providerBaseURL(latestProvider) !== baseURL) continue;
        const latestSettings = readModelRefreshSettings((await readLegalworkWorkspaceConfig(config, workspace.id)).customProviderModelRefresh);
        if (latestSettings[id]?.disconnected) continue;
        let added = false;
        // Custom discovery is an inventory check, never a change to the user's selection.
        // Built-in catalog refresh still installs metadata for the engine's catalog.
        if (fromCatalog) await writeRuntimeOpencodeConfig(config, workspace.id, (current) => {
          const currentProviders = current.provider ?? {};
          if (Object.hasOwn(originalRuntime.provider ?? {}, id) && !Object.hasOwn(currentProviders, id)) return current;
          const currentProvider = isRecord(currentProviders[id]) ? currentProviders[id] : (isRecord(latestProvider) ? latestProvider : {});
          if (providerBaseURL(currentProvider) !== baseURL) return current;
          const currentModels = isRecord(currentProvider.models) ? currentProvider.models : {};
          const additions = Object.fromEntries(models.filter((model) => !Object.hasOwn(currentModels, model)).map((model) => [model, modelDefinitions[model]]));
          added = Object.keys(additions).length > 0;
          if (!added) return current;
          return { ...current, provider: { ...currentProviders, [id]: {
            ...currentProvider,
            models: { ...currentModels, ...additions },
          } } };
        });
        settings[id] = { ...status, baseURL, ...(!fromCatalog ? { availableModels: models } : {}), lastCheckedAt: now, lastUpdatedAt: now, lastError: null, pendingReload: status.pendingReload || added };
      } catch (error) {
        settings[id] = { ...status, baseURL, availableModels: status.baseURL === baseURL ? status.availableModels : undefined, lastCheckedAt: now, lastError: error instanceof Error ? error.message : "Could not refresh models." };
      }
    }

    // Keep opt-in changes made by another client while the endpoint was responding.
    await writeLegalworkWorkspaceConfig(config, workspace.id, (current) => {
      const latest = readModelRefreshSettings(current.customProviderModelRefresh);
      for (const [id, status] of Object.entries(settings)) settings[id] = {
        ...status,
        enabled: latest[id]?.enabled ?? status.enabled,
        disconnected: latest[id]?.disconnected ?? status.disconnected,
        pendingReload: latest[id]?.disconnected ? false : status.pendingReload,
      };
      return { ...current, customProviderModelRefresh: { ...latest, ...settings } };
    });

    let reloaded = false;
    const apply = async () => {
      if (!Object.values(settings).some((status) => status.pendingReload) || await input.isBusy(workspace)) return;
      try {
        await input.reload(workspace);
        reloaded = true;
        await writeLegalworkWorkspaceConfig(config, workspace.id, (current) => {
          const latest = readModelRefreshSettings(current.customProviderModelRefresh);
          for (const [id, status] of Object.entries(settings)) {
            settings[id] = { ...status, pendingReload: false };
            if (latest[id]) latest[id] = { ...latest[id], pendingReload: false };
          }
          return { ...current, customProviderModelRefresh: latest };
        });
      } catch {
        // Keep the inventory and retry applying it on the next foreground tick.
      }
    };
    reloadQueue = reloadQueue.then(apply, apply);
    await reloadQueue;
    return { providers: settings, reloaded };
  }

  return function refresh(workspace: WorkspaceInfo, options: RefreshOptions = {}): Promise<RefreshResult> {
    const existing = running.get(workspace.id);
    if (existing) return options.force || options.reloadRequired ? existing.then(() => refresh(workspace, options)) : existing;
    const promise = run(workspace, options).finally(() => running.delete(workspace.id));
    running.set(workspace.id, promise);
    return promise;
  };
}
