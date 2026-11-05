import { readStoredProviderApiKey } from "./custom-provider-model-refresh.js";
import { EIGENWELT_PROVIDER_ID } from "./eigenwelt-paid-manifest.js";
import type { FirmOcr } from "./ocr/manager.js";
import { memberKeyRef } from "./ocr/manager.js";
import { appliedOrgPolicy, orgPolicySecret } from "./org-policy.js";
import { orgChatEngineId, type OrgChatProvider, type OrgFirmKey } from "./org-policy-schema.js";
import { discoverProviderModels } from "./provider-model-discovery.js";
import { nativeProviderDefinition, type NativeProviderDefinition } from "./opencode-model-config.js";
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

/** Keep firm-key configuration separate from definitions needing a native
 * connection: the engine force-enables every provider in its configuration. */
async function orgChatProviderDefinitions(config: ServerConfig, withFirmKey: boolean): Promise<Record<string, NativeProviderDefinition>> {
  const providers = (await appliedOrgPolicy(config, "ai.chat.providers"))?.value ?? [];
  const blocks: Record<string, NativeProviderDefinition> = {};
  for (const provider of providers) {
    const key = await firmKey(config, provider.key);
    const { source } = provider;
    if (Boolean(key) !== withFirmKey) continue;
    if (source.type === "catalog") {
      if (provider.models !== "all") throw new Error("The firm's model allowlist requires native model-policy support. Its restrictions have been retained; the provider cannot be broadened.");
      // A member's own key or sign-in stays with the engine; firm-owned values
      // use native provider settings.
      const settings = { ...(source.resourceName ? { resourceName: source.resourceName } : {}), ...(key ? { apiKey: key } : {}) };
      blocks[source.provider] = nativeProviderDefinition({
        name: provider.name,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      });
      continue;
    }
    const custom = { ...provider, source };
    const memberKey = key ?? await readStoredProviderApiKey(config, provider.id, null).catch(() => "");
    const models = await customModels(custom, memberKey);
    if (models.length === 0 && withFirmKey) continue;
    blocks[provider.id] = nativeProviderDefinition({
      package: source.apiType === "responses" ? "@opencode/ai/providers/openai/responses" : "@opencode/ai/providers/openai-compatible",
      name: provider.name,
      settings: { baseURL: source.baseURL },
      ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
      models: Object.fromEntries(models.map((id) => [id, { name: id, capabilities: { tools: true } }])),
    });
  }
  return blocks;
}

/** The engine ids of the firm's chat providers: they stay on whatever the member disconnected. */
export async function orgChatEngineIds(config: ServerConfig): Promise<string[]> {
  return ((await appliedOrgPolicy(config, "ai.chat.providers"))?.value ?? []).map(orgChatEngineId);
}

/** Only firm-supplied keys may force-enable a configured provider. */
export function orgChatProviderBlocks(config: ServerConfig) {
  return orgChatProviderDefinitions(config, true);
}

/** Templates preserve endpoints and model inventories while native connections
 * decide readiness. Putting these in config.providers would force-enable them. */
export function orgChatProviderTemplates(config: ServerConfig) {
  return orgChatProviderDefinitions(config, false);
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
