import { hasStoredProviderAuth, readStoredProviderApiKey } from "./custom-provider-model-refresh.js";
import { EIGENWELT_PROVIDER_ID } from "./eigenwelt-paid-manifest.js";
import type { FirmOcr } from "./ocr/manager.js";
import { memberKeyRef } from "./ocr/manager.js";
import { appliedOrgPolicy, orgPolicySecret } from "./org-policy.js";
import { orgChatEngineId, type OrgChatProvider, type OrgFirmKey } from "./org-policy-schema.js";
import { discoverProviderModels } from "./provider-model-discovery.js";
import type { ServerConfig } from "./types.js";

/**
 * The firm's own AI providers (chat, SystemOne, OCR) as they apply on this
 * computer. The firm's keys come from the policy's secrets, kept in memory
 * while signed in; a member's own key stays where the member's keys are.
 */

async function firmKey(config: ServerConfig, key: OrgChatProvider["key"] | OrgFirmKey): Promise<string | null> {
  return key.by === "firm" ? orgPolicySecret(config, key.secretRef) : null;
}

const DISCOVERY_MS = 10 * 60_000;
const discovered = new Map<string, { at: number; models: string[] }>();

/** A custom provider's models: the firm's list, or every model it lists now (the last good answer while it cannot be reached). */
async function customModels(provider: OrgChatProvider & { source: { type: "custom" } }, apiKey: string): Promise<string[]> {
  if (provider.models !== "all") return provider.models;
  const cacheKey = `${provider.id}\n${provider.source.baseURL}`;
  const cached = discovered.get(cacheKey);
  if (cached && Date.now() - cached.at < DISCOVERY_MS) return cached.models;
  try {
    const models = await discoverProviderModels(provider.source.baseURL, apiKey);
    discovered.set(cacheKey, { at: Date.now(), models });
    return models;
  } catch {
    return cached?.models ?? [];
  }
}

/**
 * Engine provider blocks for the firm's chat providers that can be used now:
 * with the firm's key while signed in, or once the member added their own key
 * or signed in. The engine offers every provider in its config, key or not.
 */
export async function orgChatProviderBlocks(config: ServerConfig): Promise<Record<string, unknown>> {
  const providers = (await appliedOrgPolicy(config, "ai.chat.providers"))?.value ?? [];
  const blocks: Record<string, unknown> = {};
  for (const provider of providers) {
    const key = await firmKey(config, provider.key);
    if (!key && !(await hasStoredProviderAuth(orgChatEngineId(provider)))) continue;
    const { source } = provider;
    if (source.type === "catalog") {
      // A member's own key or sign-in stays with the engine; the firm's key and resource go in the options.
      const options = { ...(source.resourceName ? { resourceName: source.resourceName } : {}), ...(key ? { apiKey: key } : {}) };
      blocks[source.provider] = {
        name: provider.name,
        ...(Object.keys(options).length > 0 ? { options } : {}),
        ...(provider.models === "all" ? {} : { whitelist: provider.models }),
      };
      continue;
    }
    const custom = { ...provider, source };
    const models = await customModels(custom, key ?? (await readStoredProviderApiKey(provider.id, null)));
    if (models.length === 0) continue;
    blocks[provider.id] = {
      npm: source.apiType === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
      name: provider.name,
      // The engine passes `options` verbatim to the provider and ignores a bare `apiKey` there.
      options: { baseURL: source.baseURL, ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) },
      models: Object.fromEntries(models.map((id) => [id, { name: id, tool_call: true }])),
    };
  }
  return blocks;
}

/** The engine ids of the firm's chat providers: they stay on whatever the member disconnected. */
export async function orgChatEngineIds(config: ServerConfig): Promise<string[]> {
  return ((await appliedOrgPolicy(config, "ai.chat.providers"))?.value ?? []).map(orgChatEngineId);
}

/** While the firm allows no providers of the member's own: the providers the engine may use. */
export async function orgEnabledProviders(config: ServerConfig): Promise<string[] | null> {
  if ((await appliedOrgPolicy(config, "ai.chat.allowCustom"))?.value !== false) return null;
  return [EIGENWELT_PROVIDER_ID, ...(await orgChatEngineIds(config))];
}

/** The firm's OCR engines, default and whether members may add their own. */
export async function orgOcr(config: ServerConfig): Promise<FirmOcr> {
  const engines = (await appliedOrgPolicy(config, "ai.ocr.engines"))?.value ?? [];
  return {
    engines: engines.map((engine) => ({
      id: engine.id,
      label: engine.label,
      kind: engine.kind,
      model: engine.model,
      endpoint: engine.endpoint,
      apiKeyRef: engine.key.by === "firm" ? `org:${engine.key.secretRef}` : memberKeyRef(engine.id),
      languages: null,
      maxTokens: 8192,
      firmKey: engine.key.by,
    })),
    defaultEngineId: (await appliedOrgPolicy(config, "ai.ocr.defaultEngine"))?.value ?? null,
    allowCustom: (await appliedOrgPolicy(config, "ai.ocr.allowCustom"))?.value !== false,
    resolveFirmKey: async (secretRef) => (await orgPolicySecret(config, secretRef)) ?? undefined,
  };
}
