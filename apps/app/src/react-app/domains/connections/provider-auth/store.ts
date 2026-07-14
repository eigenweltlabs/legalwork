import { useSyncExternalStore } from "react";

import { applyEdits, modify, parse } from "jsonc-parser";
import type {
  ProviderAuthAuthorization,
  ProviderConfig,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client";

import { t } from "../../../../i18n";
import { unwrap, waitForHealthy } from "../../../../app/lib/opencode";
import {
  readOpencodeConfig,
  writeOpencodeConfig,
} from "../../../../app/lib/desktop";
import type {
  Client,
  ProviderListItem,
  WorkspaceDisplay,
} from "../../../../app/types";
import { isDesktopRuntime, safeStringify } from "../../../../app/utils";
import {
  compareProviders,
  filterProviderList,
} from "../../../../app/utils/providers";
import { getReactQueryClient } from "../../../infra/query-client";
import { ensureProviderListQuery } from "../../../infra/provider-list-query";
import type { LegalworkServerStoreSnapshot } from "../legalwork-server-store";
import type {
  EigenweltManifest,
  EigenweltManifestModel,
  EigenweltSignInPayload,
} from "../../../../app/lib/legalwork-server";

/**
 * The slice of the legalwork-server store this store actually consumes.
 * The settings route passes the full store; the session route passes a
 * lightweight endpoint-backed adapter (previously forced through `as never`).
 */
export type ProviderAuthLegalworkServer = {
  getSnapshot: () => Pick<
    LegalworkServerStoreSnapshot,
    "legalworkServerStatus" | "legalworkServerClient"
  > & {
    legalworkServerCapabilities: { config?: { read?: boolean; write?: boolean } } | null;
  };
};
import { dispatchNewProviders } from "../../../../app/lib/provider-events";

type ProviderReturnFocusTarget = "none" | "composer";

export type ProviderAuthMethod = {
  type: "oauth" | "api";
  label: string;
  methodIndex?: number;
};

export type ProviderAuthProvider = {
  id: string;
  name: string;
  env: string[];
};

export type ProviderOAuthStartResult = {
  methodIndex: number;
  authorization: ProviderAuthAuthorization;
};

/** A single model the user declares for a custom OpenAI-compatible provider. */
export type CustomProviderModelInput = {
  /** The exact model id sent on the wire (e.g. `deepseek-chat`). */
  id: string;
  /** Optional display name; defaults to the id. */
  name?: string;
  /** Whether the model supports tool/function calling (this app is tool-heavy). */
  toolCall?: boolean;
  /** Whether the model emits reasoning / accepts reasoning effort. */
  reasoning?: boolean;
  /** Optional context-window size used for truncation. */
  contextLimit?: number | null;
};

/**
 * Which OpenAI-spec endpoint the provider speaks. This selects the AI SDK
 * package opencode loads:
 *  - "chat"      → `@ai-sdk/openai-compatible` (POST /v1/chat/completions).
 *                  Broadest compatibility (vLLM, Ollama, Together, Groq,
 *                  LiteLLM, most proxies). OpenAI caps this at 128 tools.
 *  - "responses" → `@ai-sdk/openai` (POST /v1/responses). Use for OpenAI and
 *                  Azure OpenAI: full tool set (no 128-tool cap) and reasoning
 *                  effort, matching the built-in `openai` provider.
 * See https://opencode.ai/docs/providers/ ("use @ai-sdk/openai-compatible for
 * /v1/chat/completions; use @ai-sdk/openai if your provider uses /v1/responses").
 */
export type CustomProviderApiType = "chat" | "responses";

export const CUSTOM_PROVIDER_NPM: Record<CustomProviderApiType, string> = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
};

/** Provider id of the first-party Eigenwelt Model API connection. */
export const EIGENWELT_PROVIDER_ID = "eigenwelt";

export type { EigenweltManifestModel } from "../../../../app/lib/legalwork-server";

/**
 * Build the runtime-config provider block for the Eigenwelt Model API from a
 * platform manifest. Mirrors the server's buildEigenweltModelsMap — keep both
 * in sync. NOTE: `limit` MUST carry BOTH context and output — the engine
 * schema rejects the whole config otherwise (verified).
 */
export function buildEigenweltProviderBlock(
  baseURL: string,
  models: EigenweltManifestModel[],
): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Eigenwelt Model API",
    options: { baseURL },
    models: Object.fromEntries(
      models.map((model) => [
        model.id,
        {
          name: model.name ?? model.id,
          tool_call: model.toolCall ?? true,
          reasoning: model.reasoning ?? false,
          limit: { context: model.contextLength ?? 128000, output: 16384 },
        },
      ]),
    ),
  };
}

/**
 * Input for adding a user-defined provider that speaks the OpenAI API spec.
 * The provider is written to config with the npm package selected by
 * `apiType`, and the API key (when supplied) is stored in the engine auth
 * store rather than inline in config.
 */
export type CustomProviderInstallInput = {
  providerId: string;
  name: string;
  baseURL: string;
  apiKey: string;
  apiType: CustomProviderApiType;
  models: CustomProviderModelInput[];
};

/** A custom provider's current config, read back so the form can edit it. */
export type CustomProviderEditData = {
  providerId: string;
  name: string;
  baseURL: string;
  apiType: CustomProviderApiType;
  models: Array<{ id: string; toolCall: boolean; reasoning: boolean; contextLimit: number | null }>;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ProviderAuthStoreSnapshot = {
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthWorkerType: "local" | "remote";
  providerAuthProviders: ProviderAuthProvider[];
};

type CreateProviderAuthStoreOptions = {
  client: () => Client | null;
  providers: () => ProviderListItem[];
  providerDefaults: () => Record<string, string>;
  providerConnectedIds: () => string[];
  disabledProviders: () => string[];
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  selectedWorkspaceRoot: () => string;
  runtimeWorkspaceId: () => string | null;
  ensureRuntimeWorkspaceId?: () => Promise<string | null | undefined>;
  legalworkServer: ProviderAuthLegalworkServer;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setDisabledProviders: (value: string[]) => void;
  markOpencodeConfigReloadRequired: () => void;
  focusPromptSoon?: () => void;
};

type MutableState = {
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthReturnFocusTarget: ProviderReturnFocusTarget;
};

export type ProviderAuthStore = ReturnType<typeof createProviderAuthStore>;

export function createProviderAuthStore(options: CreateProviderAuthStoreOptions) {
  const listeners = new Set<() => void>();

  let snapshot: ProviderAuthStoreSnapshot;
  let disposed = false;
  let started = false;
  let lastWorkspaceKey = "";

  let state: MutableState = {
    providerAuthModalOpen: false,
    providerAuthBusy: false,
    providerAuthError: null,
    providerAuthMethods: {},
    providerAuthPreferredProviderId: null,
    providerAuthReturnFocusTarget: "none",
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getProviderAuthWorkerType = (): "local" | "remote" =>
    options.selectedWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local";

  const getProviderAuthProviders = (): ProviderAuthProvider[] => {
    const merged = new Map<string, ProviderAuthProvider>();

    for (const provider of options.providers()) {
      const id = provider.id?.trim();
      if (!id) continue;
      merged.set(id, {
        id,
        name: provider.name?.trim() || id,
        env: Array.isArray(provider.env) ? provider.env : [],
      });
    }

    return Array.from(merged.values()).toSorted(compareProviders);
  };

  const resolveLegalworkConfigTarget = async (mode: "read" | "write") => {
    const legalworkSnapshot = options.legalworkServer.getSnapshot();
    const legalworkClient = legalworkSnapshot.legalworkServerClient;
    let legalworkWorkspaceId = options.runtimeWorkspaceId()?.trim() || null;
    if (!legalworkWorkspaceId && legalworkSnapshot.legalworkServerStatus === "connected" && legalworkClient) {
      legalworkWorkspaceId = (await options.ensureRuntimeWorkspaceId?.())?.trim() || null;
    }
    const hasLegalworkTarget =
      legalworkSnapshot.legalworkServerStatus === "connected" &&
      Boolean(legalworkClient && legalworkWorkspaceId);
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.config?.[mode] !== false;
    return {
      legalworkClient,
      legalworkWorkspaceId,
      hasLegalworkTarget,
      canUseLegalworkServer,
    };
  };

  const refreshSnapshot = () => {
    snapshot = {
      providerAuthModalOpen: state.providerAuthModalOpen,
      providerAuthBusy: state.providerAuthBusy,
      providerAuthError: state.providerAuthError,
      providerAuthMethods: state.providerAuthMethods,
      providerAuthPreferredProviderId: state.providerAuthPreferredProviderId,
      providerAuthWorkerType: getProviderAuthWorkerType(),
      providerAuthProviders: getProviderAuthProviders(),
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(
    key: K,
    value: MutableState[K],
  ) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };


  const readProjectConfigFile = async () => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveLegalworkConfigTarget("read");

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      return await legalworkClient.readOpencodeConfigFile(legalworkWorkspaceId, "project");
    }

    if (hasLegalworkTarget) {
      throw new Error("LegalWork server config API is unavailable for this workspace.");
    }

    if (isLocalWorkspace && isDesktopRuntime() && root) {
      return await readOpencodeConfig("project", root);
    }

    return null;
  };

  const writeProjectConfigFile = async (content: string) => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveLegalworkConfigTarget("write");

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      const result = await legalworkClient.writeOpencodeConfigFile(
        legalworkWorkspaceId,
        "project",
        content,
      ) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to write opencode.jsonc");
      }
      return true;
    }

    if (hasLegalworkTarget) {
      throw new Error("LegalWork server config API is unavailable for this workspace.");
    }

    if (isLocalWorkspace && isDesktopRuntime() && root) {
      const result = await writeOpencodeConfig("project", root, content) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to write opencode.jsonc");
      }
      return true;
    }

    return false;
  };

  const updateProjectConfigFile = async (
    updater: (raw: string) => string,
    fallbackUpdate?: (config: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const configFile = await readProjectConfigFile() as { content?: string } | null;
    if (configFile) {
      const raw = configFile.content?.trim()
        ? configFile.content
        : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
      await writeProjectConfigFile(updater(raw));
      return true;
    }

    if (!fallbackUpdate) {
      return false;
    }

    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    const config = unwrap(await c.config.get());
    const next = fallbackUpdate(config);
    await c.config.update({ config: next });
    return true;
  };

  const normalizeDisabledProviders = (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        ]
      : [];

  const formatConfigWithProviderDisabledState = (
    raw: string,
    providerId: string,
    disabled: boolean,
  ) => {
    const resolvedProviderId = providerId.trim();
    let updated = raw.trim()
      ? raw
      : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    const parsed = parse(updated) as Record<string, unknown> | undefined;
    const currentDisabled = normalizeDisabledProviders(parsed?.disabled_providers);
    const nextDisabled = disabled
      ? [...currentDisabled.filter((entry) => entry !== resolvedProviderId), resolvedProviderId]
      : currentDisabled.filter((entry) => entry !== resolvedProviderId);

    const disabledEdits = modify(
      updated,
      ["disabled_providers"],
      nextDisabled.length ? nextDisabled : undefined,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } },
    );
    updated = applyEdits(updated, disabledEdits);
    return updated.endsWith("\n") ? updated : `${updated}\n`;
  };

  const ensureProjectProviderDisabledState = async (
    providerId: string,
    disabled: boolean,
  ) => {
    const resolvedProviderId = providerId.trim();
    if (!resolvedProviderId) {
      throw new Error(t("providers.provider_id_required"));
    }

    const currentDisabled = normalizeDisabledProviders(options.disabledProviders());
    const nextDisabled = disabled
      ? [...currentDisabled.filter((entry) => entry !== resolvedProviderId), resolvedProviderId]
      : currentDisabled.filter((entry) => entry !== resolvedProviderId);

    if (
      nextDisabled.length === currentDisabled.length &&
      nextDisabled.every((entry, index) => entry === currentDisabled[index])
    ) {
      return false;
    }

    const updatedConfig = await updateProjectConfigFile(
      (raw) => formatConfigWithProviderDisabledState(raw, resolvedProviderId, disabled),
      (config) => {
        const nextConfig = { ...config };
        if (nextDisabled.length) {
          nextConfig.disabled_providers = nextDisabled;
        } else {
          delete nextConfig.disabled_providers;
        }
        return nextConfig;
      },
    );

    if (!updatedConfig) {
      throw new Error("Could not update opencode.jsonc for this workspace.");
    }

    options.setDisabledProviders(nextDisabled);
    options.markOpencodeConfigReloadRequired();
    refreshSnapshot();
    emitChange();
    return true;
  };


  // Track whether the provider list has been loaded at least once.
  // The first load (app startup) populates the initial state — we don't
  // want to fire "new provider" events for providers that were already
  // there. After the first load, any new provider IS genuinely new.
  let providerListInitialized = false;

  const applyProviderListState = (value: ProviderListResponse, opts?: { suppressNewProviderEvent?: boolean }) => {
    const prevConnected = new Set(options.providerConnectedIds());
    const nextConnected = value.connected ?? [];
    const nextAll = value.all ?? [];
    options.setProviders(nextAll);
    options.setProviderDefaults(value.default ?? {});
    options.setProviderConnectedIds(nextConnected);
    refreshSnapshot();
    emitChange();

    if (!providerListInitialized) {
      providerListInitialized = true;
      return;
    }

    // Detect newly connected providers and fire a global event so
    // the NewProvidersListener records a notification — regardless of
    // which route is active.
    if (!opts?.suppressNewProviderEvent) {
      const newIds = nextConnected.filter((id) => !prevConnected.has(id));
      if (newIds.length > 0) {
        const infos = newIds.map((id) => {
          const provider = nextAll.find((p) => (p.id ?? "") === id);
          const models = provider?.models ?? {};
          const firstModelId = Object.keys(models)[0];
          return {
            id,
            name: provider?.name ?? id,
            providerId: id,
            firstModelId,
            firstModelName: firstModelId
              ? (models[firstModelId]?.name ?? firstModelId)
              : undefined,
          };
        });
        dispatchNewProviders({ providers: infos, source: "local_config" });
      }
    }
  };

  const removeProviderFromState = (providerId: string) => {
    const resolved = providerId.trim();
    if (!resolved) return;
    options.setProviders(options.providers().filter((provider) => provider.id !== resolved));
    options.setProviderConnectedIds(
      options.providerConnectedIds().filter((id) => id !== resolved),
    );
    options.setProviderDefaults(
      Object.fromEntries(
        Object.entries(options.providerDefaults()).filter(([id]) => id !== resolved),
      ),
    );
    refreshSnapshot();
    emitChange();
  };

  const assertNoClientError = (result: unknown) => {
    const maybe = result as { error?: unknown } | null | undefined;
    if (!maybe || maybe.error === undefined) return;
    throw new Error(describeProviderError(maybe.error, t("providers.request_failed")));
  };

  const removeProviderAuthCredentials = async (providerId: string) => {
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const authClient = c.auth as unknown as {
      remove?: (options: { providerID: string }) => Promise<unknown>;
      set?: (options: { providerID: string; auth: unknown }) => Promise<unknown>;
    };
    if (typeof authClient.remove === "function") {
      const result = await authClient.remove({ providerID: providerId });
      assertNoClientError(result);
      return;
    }

    const rawClient = (c as unknown as {
      client?: { delete?: (options: { url: string }) => Promise<unknown> };
    }).client;
    if (rawClient?.delete) {
      await rawClient.delete({ url: `/auth/${encodeURIComponent(providerId)}` });
      return;
    }

    if (typeof authClient.set === "function") {
      const result = await authClient.set({ providerID: providerId, auth: null });
      assertNoClientError(result);
      return;
    }

    throw new Error(t("providers.removal_unsupported"));
  };

  const describeProviderError = (error: unknown, fallback: string) => {
    const readString = (value: unknown, max = 700) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length <= max) return trimmed;
      return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
    };

    const records: Record<string, unknown>[] = [];
    const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    if (root) {
      records.push(root);
      if (root.data && typeof root.data === "object") {
        records.push(root.data as Record<string, unknown>);
      }
      if (root.cause && typeof root.cause === "object") {
        const cause = root.cause as Record<string, unknown>;
        records.push(cause);
        if (cause.data && typeof cause.data === "object") {
          records.push(cause.data as Record<string, unknown>);
        }
      }
    }

    const firstString = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = readString(record[key]);
          if (value) return value;
        }
      }
      return null;
    };

    const firstNumber = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
      }
      return null;
    };

    const status = firstNumber(["statusCode", "status"]);
    const provider = firstString(["providerID", "providerId", "provider"]);
    const code = firstString(["code", "errorCode"]);
    const response = firstString(["responseBody", "body", "response"]);
    const raw =
      (error instanceof Error ? readString(error.message) : null) ||
      firstString(["message", "detail", "reason", "error"]) ||
      (typeof error === "string" ? readString(error) : null);

    const generic = raw && /^unknown\s+error$/i.test(raw);
    const heading = (() => {
      if (status === 401 || status === 403) return t("providers.auth_failed");
      if (status === 429) return t("providers.rate_limit_exceeded");
      if (provider) return t("providers.provider_error", { provider });
      return fallback;
    })();

    const lines = [heading];
    if (raw && !generic && raw !== heading) lines.push(raw);
    if (status && !heading.includes(String(status))) lines.push(`Status: ${status}`);
    if (provider && !heading.includes(provider)) lines.push(`Provider: ${provider}`);
    if (code) lines.push(`Code: ${code}`);
    if (response) lines.push(`Response: ${response}`);
    if (lines.length > 1) return lines.join("\n");

    if (raw && !generic) return raw;
    if (error && typeof error === "object") {
      const serialized = safeStringify(error);
      if (serialized && serialized !== "{}") return serialized;
    }
    return fallback;
  };

  const buildProviderAuthMethods = (
    methods: Record<string, ProviderAuthMethod[]>,
    availableProviders: ProviderAuthProvider[],
    workerType: "local" | "remote",
  ) => {
    const merged = Object.fromEntries(
      Object.entries(methods ?? {}).map(([id, providerMethods]) => [
        id,
        (providerMethods ?? []).map((method, methodIndex) => ({
          ...method,
          methodIndex,
        })),
      ]),
    ) as Record<string, ProviderAuthMethod[]>;

    for (const provider of availableProviders ?? []) {
      const id = provider.id?.trim();
      if (!id) continue;
      if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
      const existing = merged[id] ?? [];
      if (existing.some((method) => method.type === "api")) continue;
      merged[id] = [...existing, { type: "api", label: t("providers.api_key_label") }];
    }

    const availableProvidersById = new Map((availableProviders ?? []).map((provider) => [provider.id, provider]));
    for (const [id, providerMethods] of Object.entries(merged)) {
      const provider = availableProvidersById.get(id);
      const normalizedId = id.trim().toLowerCase();
      const normalizedName = provider?.name?.trim().toLowerCase() ?? "";
      const isOpenAiProvider = normalizedId === "openai" || normalizedName === "openai";
      if (!isOpenAiProvider) continue;
      merged[id] = providerMethods.filter((method) => {
        if (method.type !== "oauth") return true;
        const label = method.label.toLowerCase();
        const isHeadless = /headless|device/.test(label);
        return workerType === "remote" ? isHeadless : !isHeadless;
      });
    }

    return merged;
  };

  const loadProviderAuthMethods = async (workerType: "local" | "remote") => {
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    const methods = unwrap(await c.provider.auth());
    return buildProviderAuthMethods(
      methods as Record<string, ProviderAuthMethod[]>,
      getProviderAuthProviders(),
      workerType,
    );
  };

  async function startProviderAuth(
    providerId?: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    try {
      const cachedMethods = state.providerAuthMethods;
      const authMethods = Object.keys(cachedMethods).length
        ? cachedMethods
        : await loadProviderAuthMethods(getProviderAuthWorkerType());
      const providerIds = Object.keys(authMethods).sort();
      if (!providerIds.length) {
        throw new Error(t("providers.no_providers_available"));
      }

      const resolved = providerId?.trim() ?? "";
      if (!resolved) {
        throw new Error(t("providers.provider_id_required"));
      }

      const methods = authMethods[resolved];
      if (!methods || !methods.length) {
        throw new Error(`${t("providers.unknown_provider")}: ${resolved}`);
      }

      const oauthIndex =
        methodIndex !== undefined
          ? methodIndex
          : methods.find((method) => method.type === "oauth")?.methodIndex ?? -1;
      if (oauthIndex === -1) {
        throw new Error(
          `${t("providers.no_oauth_prefix")} ${resolved}. ${t("providers.use_api_key_suffix")}`,
        );
      }

      const selectedMethod = methods.find((method) => method.methodIndex === oauthIndex);
      if (!selectedMethod || selectedMethod.type !== "oauth") {
        throw new Error(`${t("providers.not_oauth_flow_prefix")} ${resolved}.`);
      }

      const auth = unwrap(
        await c.provider.oauth.authorize({ providerID: resolved, method: oauthIndex }),
      );
      return { methodIndex: oauthIndex, authorization: auth };
    } catch (error) {
      const message = describeProviderError(error, t("providers.connect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function refreshProviders(optionsArg?: { dispose?: boolean }) {
    const c = options.client();
    if (!c) return null;

    if (optionsArg?.dispose) {
      // Prefer the LegalWork server engine reload: it disposes the engine AND
      // re-registers runtime-DB MCPs, so non-primary workspaces and pending
      // changes are picked up instead of silently dropping (toggles "turn
      // off").
      let reloaded = false;
      try {
        const legalworkSnapshot = options.legalworkServer.getSnapshot();
        const legalworkClient = legalworkSnapshot.legalworkServerClient;
        if (legalworkSnapshot.legalworkServerStatus === "connected" && legalworkClient) {
          const workspaceId =
            options.runtimeWorkspaceId()?.trim() ||
            (await options.ensureRuntimeWorkspaceId?.())?.trim() ||
            "";
          if (workspaceId) {
            await legalworkClient.reloadEngine(workspaceId);
            reloaded = true;
          }
        }
      } catch {
        // fall back to a direct engine dispose below
      }

      if (!reloaded) {
        try {
          unwrap(await c.instance.dispose());
        } catch {
          // ignore dispose failures and try reading current state anyway
        }
      }

      try {
        await waitForHealthy(options.client() ?? c, { timeoutMs: 8000, pollMs: 250 });
      } catch {
        // ignore health wait failures and still attempt provider reads
      }
    }

    const activeClient = options.client() ?? c;
    let disabledProviders = options.disabledProviders() ?? [];
    try {
      const config = unwrap(await activeClient.config.get());
      disabledProviders = Array.isArray(config.disabled_providers)
        ? config.disabled_providers
        : [];
      options.setDisabledProviders(disabledProviders);
      refreshSnapshot();
      emitChange();
    } catch {
      // ignore config read failures and continue with current store state
    }

    try {
      const updated = filterProviderList(
        await ensureProviderListQuery(getReactQueryClient(), {
          client: activeClient,
          directory: options.selectedWorkspaceRoot(),
          force: Boolean(optionsArg?.dispose),
        }),
        disabledProviders,
      );
      applyProviderListState(updated);
      return updated;
    } catch {
      return null;
    }
  }

  async function completeProviderAuthOAuth(
    providerId: string,
    methodIndex: number,
    code?: string,
  ) {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const resolved = providerId?.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }

    if (!Number.isInteger(methodIndex) || methodIndex < 0) {
      throw new Error(t("providers.oauth_method_required"));
    }

    const waitForProviderConnection = async (timeoutMs = 15000, pollMs = 2000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const updated = await refreshProviders({ dispose: true });
          const connected = new Set(updated?.connected ?? []);
          if (connected.has(resolved)) {
            return true;
          }
        } catch {
          // ignore and retry
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return false;
    };

    const isPendingOauthError = (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error ?? "");
      return /request timed out/i.test(text) || /ProviderAuthOauthMissing/i.test(text);
    };

    try {
      const trimmedCode = code?.trim();
      const result = await c.provider.oauth.callback({
        providerID: resolved,
        method: methodIndex,
        code: trimmedCode || undefined,
      });
      assertNoClientError(result);
      const updated = await refreshProviders({ dispose: true });
      const connectedNow = Array.isArray(updated?.connected) && updated.connected.includes(resolved);
      if (connectedNow) {
        return { connected: true, message: `${t("status.connected")} ${resolved}` };
      }
      const connected = await waitForProviderConnection();
      if (connected) {
        return { connected: true, message: `${t("status.connected")} ${resolved}` };
      }
      return { connected: false, pending: true };
    } catch (error) {
      if (isPendingOauthError(error)) {
        const updated = await refreshProviders({ dispose: true });
        if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
          return { connected: true, message: `${t("status.connected")} ${resolved}` };
        }
        const connected = await waitForProviderConnection();
        if (connected) {
          return { connected: true, message: `${t("status.connected")} ${resolved}` };
        }
        return { connected: false, pending: true };
      }
      const message = describeProviderError(error, t("providers.oauth_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function submitProviderApiKey(providerId: string, apiKey: string) {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error(t("providers.api_key_required"));
    }

    try {
      await c.auth.set({ providerID: providerId, auth: { type: "api", key: trimmed } });
      await refreshProviders({ dispose: true });
      return `${t("status.connected")} ${providerId}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.save_api_key_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  const writeCustomProviderConfig = async (
    providerId: string,
    providerConfig: Record<string, unknown>,
  ): Promise<boolean> => {
    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveLegalworkConfigTarget("write");

    // Preferred: persist into the LegalWork runtime config store, so the
    // provider is available across the server's workspaces (and survives a
    // matter folder that doesn't carry its own opencode.jsonc). This mirrors
    // the local-provider install path used elsewhere in settings.
    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      await legalworkClient.patchConfig(legalworkWorkspaceId, {
        opencode: { provider: { [providerId]: providerConfig } },
      });
      return true;
    }

    if (hasLegalworkTarget) {
      throw new Error("LegalWork server config API is unavailable for this workspace.");
    }

    // Desktop-local fallback: merge the provider into the project opencode.jsonc.
    return await updateProjectConfigFile(
      (raw) => {
        const base = raw.trim()
          ? raw
          : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
        const edits = modify(base, ["provider", providerId], providerConfig, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        });
        const updated = applyEdits(base, edits);
        return updated.endsWith("\n") ? updated : `${updated}\n`;
      },
      (config) => {
        const existingProviders =
          config.provider && typeof config.provider === "object"
            ? (config.provider as Record<string, unknown>)
            : {};
        return { ...config, provider: { ...existingProviders, [providerId]: providerConfig } };
      },
    );
  };

  /**
   * Remove a config/runtime-defined provider so it fully disconnects (mirrors
   * {@link writeCustomProviderConfig}). Custom providers are stored in the
   * LegalWork runtime config store or the project opencode.jsonc, so deleting
   * the auth credential alone leaves them connected — this deletes the
   * `provider.<id>` block itself. No-op when the provider isn't in config.
   */
  const removeCustomProviderFromConfig = async (providerId: string): Promise<void> => {
    const resolved = providerId.trim();
    if (!resolved) return;

    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveLegalworkConfigTarget("write");

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      // A `null` value tells the server to delete this key from the runtime
      // provider map (patch payloads can't carry `undefined` over JSON).
      await legalworkClient.patchConfig(legalworkWorkspaceId, {
        opencode: { provider: { [resolved]: null } },
      });
      return;
    }

    if (hasLegalworkTarget) {
      // Connected to a LegalWork server we can't write config to — nothing to
      // remove there; credential removal above is the best we can do.
      return;
    }

    // Desktop-local: delete the provider block from opencode.jsonc.
    await updateProjectConfigFile(
      (raw) => {
        const base = raw.trim()
          ? raw
          : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
        const edits = modify(base, ["provider", resolved], undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        });
        const updated = applyEdits(base, edits);
        return updated.endsWith("\n") ? updated : `${updated}\n`;
      },
      (config) => {
        if (!config.provider || typeof config.provider !== "object") return config;
        const nextProviders = { ...(config.provider as Record<string, unknown>) };
        delete nextProviders[resolved];
        return { ...config, provider: nextProviders };
      },
    );
  };

  /** True when the provider is defined in config (custom / has a base URL), so
   *  removing it requires deleting its config block, not just its credential. */
  const providerIsConfigDefined = (providerId: string): boolean => {
    const entry = options.providers().find((provider) => provider.id === providerId);
    if (!entry) return false;
    const source = (entry as { source?: unknown }).source;
    if (source === "custom" || source === "config") return true;
    const entryOptions = (entry as { options?: unknown }).options;
    const baseURL =
      entryOptions && typeof entryOptions === "object"
        ? (entryOptions as Record<string, unknown>).baseURL
        : undefined;
    return typeof baseURL === "string" && baseURL.trim().length > 0;
  };

  async function readCustomProviderForEdit(
    providerId: string,
  ): Promise<CustomProviderEditData | null> {
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    const resolvedId = providerId.trim();
    if (!resolvedId) return null;

    const config = unwrap(await c.config.get()) as Record<string, unknown>;
    const providers = isPlainRecord(config.provider) ? config.provider : {};
    const entry = isPlainRecord(providers[resolvedId]) ? providers[resolvedId] : null;
    if (!entry) return null;

    const npm = typeof entry.npm === "string" ? entry.npm : "";
    const apiType: CustomProviderApiType = npm === CUSTOM_PROVIDER_NPM.responses ? "responses" : "chat";
    const providerOptions = isPlainRecord(entry.options) ? entry.options : {};
    const baseURL = typeof providerOptions.baseURL === "string" ? providerOptions.baseURL : "";
    const modelsRecord = isPlainRecord(entry.models) ? entry.models : {};
    const models = Object.entries(modelsRecord).map(([id, raw]) => {
      const model = isPlainRecord(raw) ? raw : {};
      const limit = isPlainRecord(model.limit) ? model.limit : {};
      const context = typeof limit.context === "number" ? limit.context : null;
      return {
        id,
        toolCall: typeof model.tool_call === "boolean" ? model.tool_call : true,
        reasoning: typeof model.reasoning === "boolean" ? model.reasoning : false,
        contextLimit: context,
      };
    });

    return {
      providerId: resolvedId,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : resolvedId,
      baseURL,
      apiType,
      models,
    };
  }

  async function submitCustomProvider(input: CustomProviderInstallInput) {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const providerId = input.providerId.trim();
    const baseURL = input.baseURL.trim();
    const name = input.name.trim() || providerId;
    const apiKey = input.apiKey.trim();
    const models = input.models
      .map((model) => ({ ...model, id: model.id.trim() }))
      .filter((model) => model.id);

    if (!providerId) {
      throw new Error(t("providers.provider_id_required"));
    }
    if (!baseURL) {
      throw new Error("Base URL is required.");
    }
    if (!models.length) {
      throw new Error("Add at least one model ID.");
    }

    const modelsConfig: Record<string, Record<string, unknown>> = {};
    for (const model of models) {
      const entry: Record<string, unknown> = { name: model.name?.trim() || model.id };
      if (model.toolCall !== undefined) entry.tool_call = model.toolCall;
      if (model.reasoning) entry.reasoning = true;
      if (typeof model.contextLimit === "number" && model.contextLimit > 0) {
        entry.limit = { context: model.contextLimit };
      }
      modelsConfig[model.id] = entry;
    }

    const providerConfig: Record<string, unknown> = {
      npm: CUSTOM_PROVIDER_NPM[input.apiType] ?? CUSTOM_PROVIDER_NPM.chat,
      name,
      options: { baseURL },
      models: modelsConfig,
    };

    try {
      const wrote = await writeCustomProviderConfig(providerId, providerConfig);
      if (!wrote) {
        throw new Error("Could not save the provider configuration for this workspace.");
      }

      // Keep the secret out of the config file: store it in the engine auth
      // store, where opencode injects it as the OpenAI-compatible bearer key.
      if (apiKey) {
        await c.auth.set({ providerID: providerId, auth: { type: "api", key: apiKey } });
      }

      options.markOpencodeConfigReloadRequired();
      await refreshProviders({ dispose: true });
      return `${t("status.connected")} ${name}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.save_api_key_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /** The Eigenwelt flows run through the LegalWork server (it owns the OAuth
   *  loopback + the platform manifest); require a connected server client. */
  const requireEigenweltServerClient = () => {
    const legalworkSnapshot = options.legalworkServer.getSnapshot();
    const legalworkClient = legalworkSnapshot.legalworkServerClient;
    if (legalworkSnapshot.legalworkServerStatus !== "connected" || !legalworkClient) {
      throw new Error(t("providers.not_connected"));
    }
    return legalworkClient;
  };

  /**
   * Persist an Eigenwelt connection: write the provider block (dynamic model
   * list included) into the per-workspace runtime config via the same server
   * patchConfig path used by removeCustomProviderFromConfig / custom-provider
   * installs (with the project opencode.jsonc fallback for desktop-local
   * workspaces), store the API key in the engine auth store, then reload.
   */
  const finalizeEigenweltConnect = async (payload: {
    apiKey: string;
    baseURL: string;
    models: EigenweltManifestModel[];
  }) => {
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    const baseURL = payload.baseURL?.trim();
    if (!baseURL) {
      throw new Error("The Eigenwelt platform did not return a gateway URL.");
    }
    if (!Array.isArray(payload.models) || payload.models.length === 0) {
      throw new Error("The Eigenwelt platform did not return any models.");
    }

    const providerBlock = buildEigenweltProviderBlock(baseURL, payload.models);
    const wrote = await writeCustomProviderConfig(EIGENWELT_PROVIDER_ID, providerBlock);
    if (!wrote) {
      throw new Error("Could not save the provider configuration for this workspace.");
    }

    // Keep the secret out of the config file: same auth-store write as
    // submitProviderApiKey.
    await c.auth.set({ providerID: EIGENWELT_PROVIDER_ID, auth: { type: "api", key: payload.apiKey } });

    options.markOpencodeConfigReloadRequired();
    await refreshProviders({ dispose: true });
  };

  /** Start "Sign in with Eigenwelt": the LegalWork server binds the OAuth
   *  loopback and returns the platform authorize URL for the app to open. */
  async function startEigenweltSignIn(): Promise<{ authorizeUrl: string; sessionId: string }> {
    setStateField("providerAuthError", null);
    try {
      const legalworkClient = requireEigenweltServerClient();
      const started = await legalworkClient.eigenweltOauthStart();
      return { authorizeUrl: started.authorizeUrl, sessionId: started.sessionId };
    } catch (error) {
      const message = describeProviderError(error, t("providers.connect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * Long-poll the sign-in session until the browser flow delivers the
   * exchange payload, then finalize the connection. The server holds each
   * poll open (long-poll) and answers `{pending:true}` on its own timeout;
   * we re-poll after ~2s up to a ~10 minute cap. `cancelled` lets the modal
   * abort when it closes.
   */
  async function completeEigenweltSignIn(
    sessionId: string,
    opts?: { cancelled?: () => boolean },
  ): Promise<{ connected: boolean; cancelled?: boolean; message?: string }> {
    setStateField("providerAuthError", null);
    try {
      const legalworkClient = requireEigenweltServerClient();
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        if (opts?.cancelled?.()) return { connected: false, cancelled: true };
        const result = await legalworkClient.eigenweltOauthWait(sessionId);
        if ("pending" in result && result.pending) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        if (opts?.cancelled?.()) return { connected: false, cancelled: true };
        await finalizeEigenweltConnect(result as EigenweltSignInPayload);
        return { connected: true, message: `${t("status.connected")} Eigenwelt Model API` };
      }
      throw new Error("Eigenwelt sign-in timed out. Try again from the provider list.");
    } catch (error) {
      if (opts?.cancelled?.()) return { connected: false, cancelled: true };
      const message = describeProviderError(error, t("providers.oauth_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /** Connect Eigenwelt with a pasted API key: fetch the platform's public
   *  model manifest for the baseURL + models, then finalize as usual. */
  async function submitEigenweltApiKey(apiKey: string) {
    setStateField("providerAuthError", null);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error(t("providers.api_key_required"));
    }
    try {
      const legalworkClient = requireEigenweltServerClient();
      let manifest: EigenweltManifest;
      try {
        manifest = await legalworkClient.eigenweltModels();
      } catch {
        throw new Error("Could not reach the Eigenwelt platform. Check your connection and try again.");
      }
      await finalizeEigenweltConnect({ apiKey: trimmed, baseURL: manifest.baseURL, models: manifest.models });
      return `${t("status.connected")} Eigenwelt Model API`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.save_api_key_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function disconnectProvider(providerId: string) {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }

    const configDefined = providerIsConfigDefined(resolved);

    try {
      // Remove the stored API credential. Best-effort: config-defined providers
      // may have none, and the engine can reject removal of a key that isn't
      // there — that shouldn't abort the config removal below.
      try {
        await removeProviderAuthCredentials(resolved);
      } catch (credentialError) {
        if (!configDefined) throw credentialError;
      }

      // Custom / config-defined providers live in the runtime config store or
      // opencode.jsonc, so removing the credential alone leaves them connected.
      // Delete the provider's config block too.
      if (configDefined) {
        await removeCustomProviderFromConfig(resolved);
        options.markOpencodeConfigReloadRequired();
      }

      const updated = await refreshProviders({ dispose: true });
      if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
        // Still connected (e.g. via an env var we can't unset). Report what we
        // did rather than silently doing nothing.
        return `Removed stored credentials for ${resolved}${t("providers.still_connected_suffix")}`;
      }
      removeProviderFromState(resolved);
      return `${t("providers.disconnected_prefix")} ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.disconnect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function openProviderAuthModal(optionsArg?: {
    returnFocusTarget?: ProviderReturnFocusTarget;
    preferredProviderId?: string;
  }) {
    mutateState((current) => ({
      ...current,
      providerAuthReturnFocusTarget: optionsArg?.returnFocusTarget ?? "none",
      providerAuthPreferredProviderId: optionsArg?.preferredProviderId?.trim() || null,
      providerAuthBusy: true,
      providerAuthError: null,
    }));

    try {
      const methods = await loadProviderAuthMethods(getProviderAuthWorkerType());
      mutateState((current) => ({
        ...current,
        providerAuthMethods: methods,
        providerAuthModalOpen: true,
      }));
    } catch (error) {
      const message = describeProviderError(error, t("providers.load_failed"));
      mutateState((current) => ({
        ...current,
        providerAuthPreferredProviderId: null,
        providerAuthReturnFocusTarget: "none",
        providerAuthError: message,
      }));
      throw error;
    } finally {
      setStateField("providerAuthBusy", false);
    }
  }

  function closeProviderAuthModal(optionsArg?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      optionsArg?.restorePromptFocus ?? state.providerAuthReturnFocusTarget === "composer";
    mutateState((current) => ({
      ...current,
      providerAuthModalOpen: false,
      providerAuthError: null,
      providerAuthPreferredProviderId: null,
      providerAuthReturnFocusTarget: "none",
    }));
    if (shouldFocusPrompt) {
      options.focusPromptSoon?.();
    }
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const currentWorkspaceKey = () =>
    `${options.selectedWorkspaceRoot().trim()}::${options.runtimeWorkspaceId() ?? ""}`;

  const syncFromOptions = () => {
    const workspaceKey = currentWorkspaceKey();
    lastWorkspaceKey = workspaceKey;
    refreshSnapshot();
    emitChange();
  };

  const start = () => {
    if (started) return;
    // StrictMode double-mount re-arms after dispose.
    disposed = false;
    started = true;
    lastWorkspaceKey = currentWorkspaceKey();
    refreshSnapshot();
    emitChange();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    started = false;
    listeners.clear();
  };

  refreshSnapshot();

  return {
    subscribe,
    getSnapshot: () => snapshot,
    start,
    dispose,
    syncFromOptions,
    startProviderAuth,
    refreshProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    submitCustomProvider,
    startEigenweltSignIn,
    completeEigenweltSignIn,
    submitEigenweltApiKey,
    readCustomProviderForEdit,
    disconnectProvider,
    ensureProjectProviderDisabledState,
    openProviderAuthModal,
    closeProviderAuthModal,
  };
}

export function useProviderAuthStoreSnapshot(store: ProviderAuthStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
