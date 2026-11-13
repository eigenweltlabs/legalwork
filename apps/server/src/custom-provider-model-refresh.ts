import { createEngineClient } from "./engine-client.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { readLegalworkWorkspaceConfig, writeLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
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
  pendingCatalogReload?: boolean;
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
    pendingCatalogReload: entry.pendingCatalogReload === true,
  }]]));
}

export function providerBaseURL(provider: unknown): string {
  if (!isRecord(provider)) return "";
  const settings = isRecord(provider.settings) ? provider.settings : {};
  return typeof settings.baseURL === "string" ? settings.baseURL.trim().replace(/\/+$/, "") : "";
}

/** Reuse an active native key only inside the server. A stale v1 auth.json must
 * never resurrect a disconnected credential. OAuth is owned by its integration. */
export async function readStoredProviderApiKey(config: ServerConfig, providerId: string, provider: unknown, workspace = config.workspaces[0]): Promise<string> {
  const settings = isRecord(provider) && isRecord(provider.settings) ? provider.settings : {};
  if (typeof settings.apiKey === "string") return settings.apiKey;
  if (!workspace || !resolveWorkspaceOpencodeConnection(config, workspace).baseUrl) return "";
  const credentials = await createEngineClient(config, workspace).credential.list();
  const active = credentials.find(credential => credential.integrationID === providerId && credential.active);
  return active?.value.type === "key" ? active.value.key : "";
}

export function createCustomProviderModelRefresh(input: {
  config: ServerConfig;
  readProviders: (workspace: WorkspaceInfo) => Promise<Record<string, unknown>>;
  readCatalogInventory?: (workspace: WorkspaceInfo, providerId: string, refresh: boolean) => Promise<string[]>;
  isBusy: (workspace: WorkspaceInfo) => Promise<boolean>;
  reload: (workspace: WorkspaceInfo) => Promise<void>;
  reloadCatalog?: (workspace: WorkspaceInfo) => Promise<boolean>;
  now?: () => number;
}) {
  const running = new Map<string, Promise<RefreshResult>>();
  // Serialize native configuration reloads while discovery runs per project.
  let reloadQueue = Promise.resolve();

  async function run(workspace: WorkspaceInfo, options: RefreshOptions) {
    const { config } = input;
    const now = input.now?.() ?? Date.now();
    const settings = readModelRefreshSettings((await readLegalworkWorkspaceConfig(config, workspace.id)).customProviderModelRefresh);
    if (!options.providerId && !Object.values(settings).some((status) => status.enabled || status.pendingReload)) return { providers: settings, reloaded: false };
    const providers = await input.readProviders(workspace);
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
        const models = fromCatalog
          ? await input.readCatalogInventory?.(workspace, id, true)
          : await discoverProviderModels(baseURL, await readStoredProviderApiKey(config, id, provider, workspace));
        if (!models) throw new Error("Model catalog refresh is unavailable on this worker.");
        // Do not restore a provider disconnected or edited while discovery was in flight.
        const latestProvider = (await input.readProviders(workspace))[id];
        if ((!fromCatalog && !isRecord(latestProvider)) || providerBaseURL(latestProvider) !== baseURL) continue;
        const latestSettings = readModelRefreshSettings((await readLegalworkWorkspaceConfig(config, workspace.id)).customProviderModelRefresh);
        if (latestSettings[id]?.disconnected) continue;
        // Discovery records inventory only. The native catalog owns built-in
        // definitions, and neither route changes a person's explicit overrides.
        settings[id] = { ...status, baseURL, availableModels: models, lastCheckedAt: now, lastUpdatedAt: now, lastError: null,
          pendingReload: status.pendingReload || fromCatalog, pendingCatalogReload: status.pendingCatalogReload || fromCatalog };
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
        pendingCatalogReload: latest[id]?.disconnected ? false : status.pendingCatalogReload,
      };
      return { ...current, customProviderModelRefresh: { ...latest, ...settings } };
    });

    let reloaded = false;
    const apply = async () => {
      if (!Object.values(settings).some((status) => status.pendingReload) || await input.isBusy(workspace)) return;
      try {
        const catalogPending = Object.entries(settings).filter(([, status]) => status.pendingCatalogReload && !status.disconnected);
        if (catalogPending.length) {
          // Native location reload affects every project. Keep this pending
          // until the host can hold admission and verify global idle.
          if (!input.reloadCatalog) return;
          if (!await input.reloadCatalog(workspace)) return;
          for (const [id, status] of catalogPending) {
            const models = await input.readCatalogInventory?.(workspace, id, false);
            if (!models) throw new Error("Native model inventory is unavailable after catalog reload.");
            settings[id] = { ...status, availableModels: models };
          }
        } else await input.reload(workspace);
        reloaded = true;
        await writeLegalworkWorkspaceConfig(config, workspace.id, (current) => {
          const latest = readModelRefreshSettings(current.customProviderModelRefresh);
          for (const [id, status] of Object.entries(settings)) {
            settings[id] = { ...status, pendingReload: false, pendingCatalogReload: false };
            if (latest[id]) latest[id] = { ...latest[id], availableModels: status.availableModels, pendingReload: false, pendingCatalogReload: false };
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
