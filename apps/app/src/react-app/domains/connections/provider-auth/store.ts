import { orgChatEngineId } from "@legalwork/types/org-policy";
import type { SystemOneConfiguration } from "@legalwork/types/systemone";
import { useSyncExternalStore } from "react";
import { EIGENWELT_SIGN_IN_TIMEOUT_MS, type EigenweltCheckoutSelection } from "@legalwork/types/eigenwelt-checkout";
import { useSyncProviderSetupState } from "./sync-provider-setup-state";
import { isEigenweltEntitledStatus } from "@/app/lib/eigenwelt-trial";
import { EigenweltSignInTimeoutError } from "@/app/lib/eigenwelt-sign-in";

import type { FormFields } from "@opencode/client";
import { ensureNativeCatalogReady } from "@/app/lib/opencode-catalog-ready";
import { readConfig, disabledProvidersFromConfig } from "@/app/lib/opencode-config";

import { t } from "../../../../i18n";
import { waitForHealthy } from "../../../../app/lib/opencode";
import type {
  Client,
  ProviderListItem,
  ProviderListView,
  WorkspaceDisplay,
} from "../../../../app/types";
import { safeStringify } from "../../../../app/utils";
import {
  compareProviders,
  filterProviderList,
} from "../../../../app/utils/providers";
import { getReactQueryClient } from "../../../infra/query-client";
import { ensureProviderListQuery, refreshProviderListQueries } from "../../../infra/provider-list-query";
import type { LegalworkServerStoreSnapshot } from "../legalwork-server-store";
import type {
  EigenweltAccountIdentity,
  EigenweltEntitlements,
  EigenweltManifestModel,
  EigenweltSignInPayload,
  CustomProviderModelRefreshStatus,
} from "../../../../app/lib/legalwork-server";
import { LegalworkServerError } from "../../../../app/lib/legalwork-server";
import { invalidateEigenweltEntitlements } from "../eigenwelt-entitlements";
import type { EigenweltPlanId } from "../../../../app/lib/eigenwelt-plans";

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
import { customProviderModelEntry, customProviderModelFromEntry } from "./custom-provider-config";
import { orgPolicyAllows } from "../org-policy";
import { isAnthropicProvider, supportedProviderAuthMethods } from "./methods";

type ProviderReturnFocusTarget = "none" | "composer";

export type ProviderAuthMethod = {
  type: "oauth" | "api" | "command" | "external";
  label: string;
  methodIndex?: number;
  integrationID?: string;
  methodID?: string;
  form?: FormFields;
};

export type ProviderAuthProvider = {
  id: string;
  name: string;
  env: string[];
};

export type ProviderAuthorizationView = { url: string; instructions?: string; method: "auto" | "code" };

export type ProviderOAuthStartResult = {
  methodIndex: number;
  authorization: ProviderAuthorizationView;
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
  /** Output-token limit of an edited model; new models get the default. */
  outputLimit?: number | null;
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
  chat: "@opencode/ai/providers/openai-compatible",
  responses: "@opencode/ai/providers/openai/responses",
};

/** Provider id of the first-party Eigenwelt Model API connection. */
export const EIGENWELT_PROVIDER_ID = "eigenwelt";

export type { EigenweltManifestModel } from "../../../../app/lib/legalwork-server";

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
  autoRefresh?: boolean;
  preserveExistingEndpoint?: boolean;
};

/** A custom provider's current config, read back so the form can edit it. */
export type CustomProviderEditData = {
  providerId: string;
  name: string;
  baseURL: string;
  endpointConfigured?: boolean;
  apiType: CustomProviderApiType;
  modelRefresh?: CustomProviderModelRefreshStatus;
  models: Array<{
    id: string;
    name?: string;
    toolCall: boolean;
    reasoning: boolean;
    contextLimit: number | null;
    outputLimit: number | null;
  }>;
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
  providerAuthStartOAuth: boolean;
  providerAuthWorkerType: "local";
  providerAuthProviders: ProviderAuthProvider[];
};

type CreateProviderAuthStoreOptions = {
  client: () => Client | null;
  baseUrl: () => string;
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
  providerAuthStartOAuth: boolean;
  providerAuthReturnFocusTarget: ProviderReturnFocusTarget;
};

export type ProviderAuthStore = ReturnType<typeof createProviderAuthStore>;

export function createProviderAuthStore(options: CreateProviderAuthStoreOptions) {
  const listeners = new Set<() => void>();

  let snapshot: ProviderAuthStoreSnapshot;
  let disposed = false;
  let started = false;
  let lastWorkspaceKey = "";
  let modelRefreshTimer: ReturnType<typeof setInterval> | undefined;

  let state: MutableState = {
    providerAuthModalOpen: false,
    providerAuthBusy: false,
    providerAuthError: null,
    providerAuthMethods: {},
    providerAuthPreferredProviderId: null,
    providerAuthStartOAuth: false,
    providerAuthReturnFocusTarget: "none",
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getProviderAuthWorkerType = (): "local" => "local";

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
      providerAuthStartOAuth: state.providerAuthStartOAuth,
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


  const ensureProjectProviderDisabledState = async (providerId: string, disabled: boolean) => {
    const resolved = providerId.trim();
    if (!resolved) throw new Error(t("providers.provider_id_required"));
    const { legalworkClient, legalworkWorkspaceId, canUseLegalworkServer } = await resolveLegalworkConfigTarget("write");
    if (!canUseLegalworkServer || !legalworkClient || !legalworkWorkspaceId) throw new Error("Connect to a LegalWork server to change provider availability.");
    await legalworkClient.setProviderEnabled(legalworkWorkspaceId, resolved, !disabled);
    const current = options.disabledProviders().filter(id => id !== resolved);
    options.setDisabledProviders(disabled ? [...current, resolved] : current);
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

  const applyProviderListState = (value: ProviderListView, opts?: { suppressNewProviderEvent?: boolean }) => {
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

  const authLocation = () => ({ directory: options.selectedWorkspaceRoot().trim() });
  const providerIntegrationID = (providerId: string) => options.providers().find(provider => provider.id === providerId)?.integrationID ?? providerId;
  let authGeneration = 0;
  const attempts = new Map<string, { client: Client; location: { directory: string }; integrationID: string; attemptID: string; type: "oauth" | "command" }>();
  const cancelProviderAuth = async () => {
    authGeneration += 1;
    const pending = [...attempts.values()];
    attempts.clear();
    await Promise.all(pending.map(attempt => attempt.type === "oauth"
      ? attempt.client.integration.oauth.cancel(attempt).catch(() => undefined)
      : attempt.client.integration.command.cancel(attempt).catch(() => undefined)));
  };
  const removeProviderAuthCredentials = async (providerId: string) => {
    const client = options.client();
    if (!client) throw new Error(t("providers.not_connected"));
    const target = await resolveLegalworkConfigTarget("read");
    if (target.hasLegalworkTarget && target.legalworkClient && target.legalworkWorkspaceId) {
      const credentials = await target.legalworkClient.listProviderCredentials(target.legalworkWorkspaceId, providerId);
      const active = credentials.items.find(credential => credential.active);
      if (active) await target.legalworkClient.disconnectProviderCredential(target.legalworkWorkspaceId, providerId, active.id);
      return;
    }
    const integrationID = providerIntegrationID(providerId);
    const active = (await client.credential.list()).find(credential => credential.integrationID === integrationID && credential.active);
    if (active) await client.credential.remove({ credentialID: active.id });
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

  const loadProviderAuthMethods = async (_workerType: "local") => {
    const client = options.client();
    if (!client) throw new Error(t("providers.not_connected"));
    await ensureNativeCatalogReady(client, options.selectedWorkspaceRoot());
    const integrations = (await client.integration.list({ location: authLocation() })).data;
    const methods: Record<string, ProviderAuthMethod[]> = {};
    for (const integration of integrations) {
      methods[integration.id] = integration.methods.flatMap((method, methodIndex): ProviderAuthMethod[] => {
        if (method.type === "env") return [];
        return [{ type: method.type === "key" ? "api" : method.type,
          label: method.label || t("providers.api_key_label"), methodIndex, integrationID: integration.id,
          ...("id" in method ? { methodID: method.id } : {}), ...("form" in method ? { form: method.form } : {}) }];
      });
    }
    for (const provider of options.providers()) {
      const id = provider.integrationID ?? provider.id;
      if (methods[id]) methods[provider.id] = methods[id];
    }
    for (const provider of getProviderAuthProviders()) if (isAnthropicProvider(provider.id)) methods[provider.id] = supportedProviderAuthMethods(provider.id, []);
    for (const [id, value] of Object.entries(methods)) methods[id] = supportedProviderAuthMethods(id, value);
    return methods;
  };

  async function startProviderAuth(providerId?: string, methodIndex?: number, answer?: Record<string, string | number | boolean | readonly string[]>): Promise<ProviderOAuthStartResult> {
    setStateField("providerAuthError", null);
    const client = options.client();
    if (!client) throw new Error(t("providers.not_connected"));
    const resolved = providerId?.trim();
    if (isAnthropicProvider(resolved ?? "")) throw new Error(t("providers.anthropic_api_key_hint"));
    if (!resolved) throw new Error(t("providers.provider_id_required"));
    const methods = await loadProviderAuthMethods(getProviderAuthWorkerType());
    const selected = methods[resolved]?.find(method => methodIndex === undefined ? method.type === "oauth" : method.methodIndex === methodIndex);
    if (!selected || selected.methodIndex === undefined || !selected.methodID) throw new Error(t("providers.oauth_method_required"));
    await cancelProviderAuth();
    const generation = authGeneration;
    const integrationID = selected.integrationID ?? providerIntegrationID(resolved);
    const location = authLocation();
    if (selected.type === "external") {
      await client.integration.connect.external({ integrationID, methodID: selected.methodID, answer, location });
      await refreshProviderListQueries(getReactQueryClient());
      await refreshProviders();
      return { methodIndex: selected.methodIndex, authorization: { url: "", instructions: t("providers.connected_named", { name: providerName(resolved) }), method: "auto" } };
    }
    if (selected.type === "command") {
      const attempt = (await client.integration.command.connect({ integrationID, methodID: selected.methodID, location })).data;
      if (generation !== authGeneration) {
        await client.integration.command.cancel({ integrationID, attemptID: attempt.attemptID, location });
        throw new Error("Sign-in was canceled.");
      }
      attempts.set(`${resolved}:${selected.methodIndex}`, { client, location, integrationID, attemptID: attempt.attemptID, type: "command" });
      return { methodIndex: selected.methodIndex, authorization: { url: "", instructions: selected.label, method: "auto" } };
    }
    const attempt = (await client.integration.oauth.connect({ integrationID, methodID: selected.methodID, answer, location })).data;
    if (generation !== authGeneration) {
      await client.integration.oauth.cancel({ integrationID, attemptID: attempt.attemptID, location });
      throw new Error("Sign-in was canceled.");
    }
    attempts.set(`${resolved}:${selected.methodIndex}`, { client, location, integrationID, attemptID: attempt.attemptID, type: "oauth" });
    return { methodIndex: selected.methodIndex, authorization: { url: attempt.url, instructions: attempt.instructions, method: attempt.mode } };
  }

  const providerDefinitionMetadata = async () => {
    const target = await resolveLegalworkConfigTarget("read");
    if (!target.canUseLegalworkServer || !target.legalworkClient || !target.legalworkWorkspaceId) return null;
    const [saved, policy] = await Promise.all([target.legalworkClient.getConfig(target.legalworkWorkspaceId), target.legalworkClient.orgPolicy()]);
    const providers = isPlainRecord(saved.opencode.providers) ? saved.opencode.providers : isPlainRecord(saved.opencode.provider) ? saved.opencode.provider : {};
    const firm = policy.entries["ai.chat.providers"];
    return { saved, providers, firmIDs: new Set(firm && !firm.released ? firm.value.map(orgChatEngineId) : []) };
  };

  async function refreshProviders(optionsArg?: { dispose?: boolean }) {
    const c = options.client();
    if (!c) return null;

    if (optionsArg?.dispose) {
      const legalworkSnapshot = options.legalworkServer.getSnapshot();
      const legalworkClient = legalworkSnapshot.legalworkServerClient;
      if (legalworkSnapshot.legalworkServerStatus === "connected" && legalworkClient) {
        const workspaceId=options.runtimeWorkspaceId()?.trim() || (await options.ensureRuntimeWorkspaceId?.())?.trim();
        if (!workspaceId) throw new Error(t("providers.config_api_unavailable"));
        // A failed managed refresh must never fall back to globally disposing
        // other projects. Surface the error so the existing connection can recover.
        await legalworkClient.reloadEngine(workspaceId);
      } else {
        const active=await c.session.active();
        if(Object.keys(active).length)throw new Error("Wait for all projects to finish before reloading this standalone engine.");
        await c.location.reload();
      }

      try {
        await waitForHealthy(options.client() ?? c, { timeoutMs: 30_000, pollMs: 250 });
      } catch {
        // ignore health wait failures and still attempt provider reads
      }
      // Refresh active observers and drop inactive lists before reading the
      // same cache below. A forced second fetch would enumerate models twice.
      await refreshProviderListQueries(getReactQueryClient()).catch(() => undefined);
    }

    const activeClient = options.client() ?? c;
    let disabledProviders = options.disabledProviders() ?? [];
    try {
      const config = await readConfig(activeClient, options.selectedWorkspaceRoot());
      disabledProviders = disabledProvidersFromConfig(config);
      options.setDisabledProviders(disabledProviders);
      refreshSnapshot();
      emitChange();
    } catch {
      // ignore config read failures and continue with current store state
    }

    try {
      const native = await ensureProviderListQuery(getReactQueryClient(), {
        client: activeClient, baseUrl: options.baseUrl(), directory: options.selectedWorkspaceRoot(),
      });
      // The native catalog includes organization policy and plugin decisions
      // that config documents alone cannot resolve.
      disabledProviders = disabledProviders.filter(id => !native.connected.includes(id));
      options.setDisabledProviders(disabledProviders);
      const metadata = await providerDefinitionMetadata().catch(() => null);
      const projected = { ...native, all: native.all.map(provider => {
        const declared = Boolean(metadata && (Object.hasOwn(metadata.providers, provider.id) || Object.hasOwn(metadata.saved.providerDisplay ?? {}, provider.id)));
        const editableAsCustom = Boolean(metadata && declared && metadata.saved.providerDisplay?.[provider.id]?.editable === true && !metadata.firmIDs.has(provider.id));
        return { ...provider, source: editableAsCustom ? "custom" : provider.source, editableAsCustom,
          configurationReadOnly: declared && !editableAsCustom } satisfies ProviderListItem;
      }) };
      const updated = filterProviderList(projected, disabledProviders);
      applyProviderListState(updated);
      return updated;
    } catch {
      return null;
    }
  }

  async function completeProviderAuthOAuth(providerId: string, methodIndex: number, code?: string) {
    const client = options.client();
    if (!client) throw new Error(t("providers.not_connected"));
    if (isAnthropicProvider(providerId)) throw new Error(t("providers.anthropic_api_key_hint"));
    const key = `${providerId}:${methodIndex}`;
    const attempt = attempts.get(key);
    if (!attempt) {
      const value = await refreshProviders();
      return { connected: value?.connected.includes(providerId) === true, pending: false };
    }
    try {
      if (attempt.type === "oauth" && code?.trim()) await client.integration.oauth.complete({ ...attempt, code: code.trim() });
      const status = attempt.type === "oauth"
        ? (await client.integration.oauth.status(attempt)).data
        : (await client.integration.command.status(attempt)).data;
      if (status.status === "pending") return { connected: false, pending: true, message: "message" in status ? status.message : undefined };
      attempts.delete(key);
      if (status.status !== "complete") throw new Error("message" in status ? status.message : t("providers.oauth_failed"));
      await refreshProviderListQueries(getReactQueryClient());
      const value = await refreshProviders();
      return { connected: value?.connected.includes(providerId) === true, pending: false, message: t("providers.connected_named", { name: providerName(providerId) }) };
    } catch (error) {
      setStateField("providerAuthError", describeProviderError(error, t("providers.oauth_failed")));
      throw error;
    }
  }

  async function submitProviderApiKey(providerId: string, apiKey: string, answer?: Record<string, string | number | boolean | readonly string[]>) {
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
      await c.integration.connect.key({ integrationID: providerIntegrationID(providerId), key: trimmed, answer, location: authLocation() });
      await refreshProviderListQueries(getReactQueryClient());
      await refreshProviders();
      return t("providers.connected_named", { name: providerName(providerId) });
    } catch (error) {
      const message = describeProviderError(error, t("providers.save_api_key_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  const writeCustomProviderConfig = async (
    providerId: string,
    providerConfig: Record<string, unknown>,
    autoRefresh: boolean,
  ): Promise<boolean> => {
    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveLegalworkConfigTarget("write");

    // Preferred: persist into the LegalWork runtime config store, so the
    // provider is available across the server's workspaces (and survives a
    // matter folder that doesn't carry its own opencode.jsonc). This mirrors
    // the local-provider install path used elsewhere in settings.
    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      await legalworkClient.patchConfig(legalworkWorkspaceId, {
        opencode: { providers: { [providerId]: providerConfig } },
        legalwork: { customProviderModelRefresh: { [providerId]: { enabled: autoRefresh } } },
      });
      return true;
    }

    if (hasLegalworkTarget) {
      throw new Error(t("providers.config_api_unavailable"));
    }

    throw new Error("Connect to a LegalWork server to save custom provider settings.");
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
        opencode: { providers: { [resolved]: null } },
      });
      return;
    }

    if (hasLegalworkTarget) {
      // Connected to a LegalWork server we can't write config to — nothing to
      // remove there; credential removal above is the best we can do.
      return;
    }

    throw new Error("Connect to a LegalWork server to change custom provider settings.");
  };

  /** True when the provider is defined in config (custom / has a base URL), so
   *  removing it requires deleting its config block, not just its credential. */
  const providerIsConfigDefined = (providerId: string): boolean =>
    options.providers().find(provider => provider.id === providerId)?.editableAsCustom === true;

  async function readCustomProviderForEdit(
    providerId: string,
  ): Promise<CustomProviderEditData | null> {
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    const resolvedId = providerId.trim();
    if (!resolvedId) return null;

    const metadata = await providerDefinitionMetadata();
    if (!metadata) throw new Error("Connect to a LegalWork server to edit custom provider settings.");
    if (metadata.firmIDs.has(resolvedId) || metadata.saved.providerDisplay?.[resolvedId]?.editable !== true) return null;
    const providers = metadata.providers;
    let modelRefresh: CustomProviderModelRefreshStatus | undefined;
    const settings = isPlainRecord(metadata.saved.legalwork.customProviderModelRefresh) ? metadata.saved.legalwork.customProviderModelRefresh : {};
    const status = settings[resolvedId];
    if (isPlainRecord(status)) modelRefresh = {
      enabled: status.enabled === true,
      availableModels: Array.isArray(status.availableModels) ? status.availableModels.filter((id): id is string => typeof id === "string") : undefined,
      lastUpdatedAt: typeof status.lastUpdatedAt === "number" ? status.lastUpdatedAt : undefined,
      lastError: typeof status.lastError === "string" ? status.lastError : null,
      pendingReload: status.pendingReload === true,
    };
    const entry = isPlainRecord(providers[resolvedId]) ? providers[resolvedId] : null;
    if (!entry) return null;

    const npm = typeof entry.package === "string" ? entry.package : "";
    const apiType: CustomProviderApiType = npm === CUSTOM_PROVIDER_NPM.responses ? "responses" : "chat";
    const providerOptions = isPlainRecord(entry.settings) ? entry.settings : {};
    const baseURL = typeof providerOptions.baseURL === "string" ? providerOptions.baseURL : "";
    const modelsRecord = isPlainRecord(entry.models) ? entry.models : {};
    const models = Object.entries(modelsRecord)
      .map(([id, raw]) => customProviderModelFromEntry(id, raw));

    return {
      providerId: resolvedId,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : resolvedId,
      baseURL,
      endpointConfigured: metadata.saved.providerDisplay?.[resolvedId]?.hasCustomEndpoint ?? Boolean(baseURL),
      apiType,
      models,
      modelRefresh,
    };
  }

  async function fetchCustomProviderModels(input: { baseURL: string; apiKey: string; providerId?: string }): Promise<string[]> {
    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } = await resolveLegalworkConfigTarget("read");
    if (!hasLegalworkTarget || !legalworkClient || !legalworkWorkspaceId) {
      throw new Error("Connect to the LegalWork worker to fetch models, or enter model IDs manually.");
    }
    const result = await legalworkClient.discoverProviderModels(legalworkWorkspaceId, input);
    return result.models;
  }

  async function refreshCustomProviderModels(input: { providerId?: string; force?: boolean; reloadRequired?: boolean; catalog?: boolean } = {}) {
    if (!options.client()) return null;
    const workspaceKey = currentWorkspaceKey();
    const target = await resolveLegalworkConfigTarget("read");
    if (!target.legalworkClient || !target.legalworkWorkspaceId) return null;
    const result = await target.legalworkClient.refreshCustomProviderModels(target.legalworkWorkspaceId, input);
    if (disposed || workspaceKey !== currentWorkspaceKey()) return result;
    if (result.reloaded) {
      await refreshProviderListQueries(getReactQueryClient());
      await refreshProviders();
    }
    return result;
  }

  async function refreshCustomProvider(providerId: string) {
    await refreshCustomProviderModels({ providerId, force: true });
    return readCustomProviderForEdit(providerId);
  }

  async function refreshProviderModels(providerId: string) {
    const provider = options.providers().find(item => item.id === providerId);
    if (provider?.configurationReadOnly) throw new Error(t("provider_auth.authored_readonly"));
    const hasBaseURL = provider?.hasCustomEndpoint ?? (typeof provider?.settings?.baseURL === "string" && provider.settings.baseURL.trim().length > 0);
    return refreshCustomProviderModels({ providerId, force: true, catalog: provider?.source !== "custom" && !hasBaseURL });
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
    if (!baseURL && !input.preserveExistingEndpoint) {
      throw new Error(t("providers.base_url_required"));
    }
    if (!models.length) {
      throw new Error(t("providers.model_id_required"));
    }

    const modelsConfig: Record<string, Record<string, unknown>> = {};
    for (const model of models) {
      const entry = customProviderModelEntry(model);
      modelsConfig[model.id] = { ...entry, limit: entry.limit ?? null, disabled: false };
    }

    const providerConfig: Record<string, unknown> = {
      package: CUSTOM_PROVIDER_NPM[input.apiType],
      name,
      settings: baseURL ? { baseURL } : {},
      models: modelsConfig,
    };

    try {
      const metadata = await providerDefinitionMetadata();
      if (metadata && (metadata.firmIDs.has(providerId) || Object.hasOwn(metadata.saved.providerDisplay ?? {}, providerId) && metadata.saved.providerDisplay?.[providerId]?.editable !== true)) {
        throw new Error(t("provider_auth.authored_readonly"));
      }
      const wrote = await writeCustomProviderConfig(providerId, providerConfig, input.autoRefresh === true);
      if (!wrote) {
        throw new Error(t("providers.save_config_failed"));
      }

      // Keep the secret out of the config file: store it in the engine auth
      // store, where opencode injects it as the OpenAI-compatible bearer key.
      if (apiKey) {
        await c.model.list({ location: authLocation() });
        await c.integration.connect.key({ integrationID: providerId, key: apiKey, location: authLocation() });
      }

      options.markOpencodeConfigReloadRequired();
      const target = await resolveLegalworkConfigTarget("read");
      if (target.legalworkClient && target.legalworkWorkspaceId) {
        await refreshCustomProviderModels({ providerId, force: input.autoRefresh === true, reloadRequired: true });
      } else {
        await refreshProviders({ dispose: true });
      }
      return t("providers.connected_named", { name });
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

  /** Save the account through LegalWork even before the project's agent is
   * connected or approved. Refresh its providers only when it is connected. */
  const finalizeEigenweltConnect = async (payload: {
    systemOne?: SystemOneConfiguration;
    apiKey: string;
    baseURL: string;
    models: EigenweltManifestModel[];
    account?: EigenweltAccountIdentity;
    entitlements?: EigenweltEntitlements;
    platformToken?: string;
    accessTokenExpiresAt?: number;
    refreshToken?: string;
    platformURL?: string;
  }) => {
    const baseURL = payload.baseURL?.trim();
    const models = Array.isArray(payload.models) ? payload.models : [];
    // "Signed in with Eigenwelt" = the account connection (entitlements +
    // rotating token), independent of the served model list. A bare API-key
    // connect carries none of these.
    const hasAccount = Boolean(
      payload.entitlements || payload.platformToken || payload.refreshToken || payload.platformURL,
    );
    if (!(baseURL && payload.apiKey) && !hasAccount) {
      throw new Error(t("providers.no_gateway_url"));
    }

    // Eigenwelt is a firm ACCOUNT, not a per-workspace provider — so we hand the
    // account (entitlements + tokens) AND the gateway manifest ({baseURL, apiKey,
    // models}) to the LegalWork server, which caches them globally and injects
    // the `eigenwelt` provider into EVERY workspace's engine config (like the
    // free tier). The browser callback is not a completed sign-in until these
    // credentials have been saved. Never hide a failed save behind a reload.
    const { legalworkClient, legalworkWorkspaceId, canUseLegalworkServer } =
      await resolveLegalworkConfigTarget("write");
    if (!canUseLegalworkServer || !legalworkClient || !legalworkWorkspaceId) {
      throw new Error(t("providers.not_connected"));
    }
    await legalworkClient.eigenweltSaveConnection(legalworkWorkspaceId, {
      systemOne: payload.systemOne,
      account: payload.account ?? null,
      entitlements: payload.entitlements ?? null,
      platformURL: payload.platformURL ?? null,
      platformToken: payload.platformToken ?? null,
      refreshToken: payload.refreshToken ?? null,
      accessTokenExpiresAt: payload.accessTokenExpiresAt ?? null,
      ...(baseURL && payload.apiKey ? { baseURL, apiKey: payload.apiKey, models } : {}),
    });
    invalidateEigenweltEntitlements();

    // This refresh already reloads the engine. Scheduling the automatic
    // reload as well disposes the instance a second time during sign-in.
    await refreshProviders({ dispose: true });
  };

  /** Start "Sign in with Eigenwelt": the LegalWork server binds the OAuth
   *  loopback and returns the platform authorize URL for the app to open. */
  async function startEigenweltSignIn(opts?: {
    intent?: "sign-in";
    /** The plan picked on the plan screen: its checkout opens in the browser. */
    plan?: EigenweltPlanId;
    checkout?: EigenweltCheckoutSelection;
  }): Promise<{ authorizeUrl: string; sessionId: string }> {
    setStateField("providerAuthError", null);
    try {
      const legalworkClient = requireEigenweltServerClient();
      const started = await legalworkClient.eigenweltOauthStart(opts);
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
   * we re-poll after ~2s up to a one-hour cap. `cancelled` lets the modal
   * abort when it closes.
   */
  async function completeEigenweltSignIn(
    sessionId: string,
    opts?: { cancelled?: () => boolean },
  ): Promise<{ connected: boolean; cancelled?: boolean; message?: string; preferredAiProvider?: "openai" | "other" }> {
    setStateField("providerAuthError", null);
    try {
      const legalworkClient = requireEigenweltServerClient();
      const deadline = Date.now() + EIGENWELT_SIGN_IN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (opts?.cancelled?.()) return { connected: false, cancelled: true };
        const result = await legalworkClient.eigenweltOauthWait(sessionId);
        if ("pending" in result && result.pending) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        if (opts?.cancelled?.()) return { connected: false, cancelled: true };
        await finalizeEigenweltConnect(result as EigenweltSignInPayload);
        if ("account" in result && result.account && "entitlements" in result &&
          result.entitlements?.plan === "sync" && isEigenweltEntitledStatus(result.entitlements.subscriptionStatus)) {
          useSyncProviderSetupState.getState().reset(`${result.account.orgId}:${result.account.userId}`);
        }
        return { connected: true, preferredAiProvider: "preferredAiProvider" in result ? result.preferredAiProvider : undefined, message: t("providers.connected_named", { name: "Eigenwelt" }) };
      }
    } catch (error) {
      if (opts?.cancelled?.()) return { connected: false, cancelled: true };
      if (error instanceof LegalworkServerError && error.code === "eigenwelt_signin_timeout") {
        const message = t("providers.eigenwelt_signin_timeout");
        setStateField("providerAuthError", message);
        throw new EigenweltSignInTimeoutError(message);
      }
      const message = describeProviderError(error, t("providers.oauth_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
    const message = t("providers.eigenwelt_signin_timeout");
    setStateField("providerAuthError", message);
    throw new EigenweltSignInTimeoutError(message);
  }

  /** A provider's name as the member sees it, for the messages after connecting or disconnecting. */
  const providerName = (providerId: string) =>
    options.providers().find((provider) => provider.id === providerId)?.name ?? providerId;

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

      const updated = await refreshProviders({ dispose: configDefined });
      if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
        // Still connected (e.g. via an env var we can't unset). Report what we
        // did rather than silently doing nothing.
        return t("providers.still_connected", { name: providerName(resolved) });
      }
      const name = providerName(resolved);
      removeProviderFromState(resolved);
      return t("providers.disconnected_named", { name });
    } catch (error) {
      const message = describeProviderError(error, t("providers.disconnect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function openProviderAuthModal(optionsArg?: {
    returnFocusTarget?: ProviderReturnFocusTarget;
    preferredProviderId?: string;
    startOAuth?: boolean;
    /** Connecting one of the firm's providers: allowed whatever the firm allows of the member's own. */
    firm?: boolean;
  }) {
    // Every way to add a provider leads here: the firm may not allow members' own.
    if (!optionsArg?.firm && !(await orgPolicyAllows("ai.chat.allowCustom"))) return;
    mutateState((current) => ({
      ...current,
      providerAuthReturnFocusTarget: optionsArg?.returnFocusTarget ?? "none",
      providerAuthPreferredProviderId: optionsArg?.preferredProviderId?.trim() || null,
      providerAuthStartOAuth: optionsArg?.startOAuth === true && !isAnthropicProvider(optionsArg.preferredProviderId ?? ""),
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
        providerAuthStartOAuth: false,
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
    void cancelProviderAuth();
    mutateState((current) => ({
      ...current,
      providerAuthModalOpen: false,
      providerAuthError: null,
      providerAuthPreferredProviderId: null,
      providerAuthStartOAuth: false,
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
    const changed = workspaceKey !== lastWorkspaceKey;
    lastWorkspaceKey = workspaceKey;
    refreshSnapshot();
    emitChange();
    if (changed) void cancelProviderAuth();
    if (started && changed) pollCustomProviderModels();
  };

  const pollCustomProviderModels = () => {
    if (disposed || document.visibilityState === "hidden") return;
    void refreshCustomProviderModels().catch(() => undefined);
  };

  const start = () => {
    if (started) return;
    // StrictMode double-mount re-arms after dispose.
    disposed = false;
    started = true;
    lastWorkspaceKey = currentWorkspaceKey();
    refreshSnapshot();
    emitChange();
    modelRefreshTimer = setInterval(pollCustomProviderModels, 15_000);
    document.addEventListener("visibilitychange", pollCustomProviderModels);
    pollCustomProviderModels();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    void cancelProviderAuth();
    started = false;
    clearInterval(modelRefreshTimer);
    document.removeEventListener("visibilitychange", pollCustomProviderModels);
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
    cancelProviderAuth,
    refreshProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    submitCustomProvider,
    fetchCustomProviderModels,
    refreshCustomProviderModels,
    refreshCustomProvider,
    refreshProviderModels,
    startEigenweltSignIn,
    completeEigenweltSignIn,
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
