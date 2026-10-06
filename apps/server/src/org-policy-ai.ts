import { buildEigenweltModelsMap } from "./eigenwelt-auth.js";
import { EIGENWELT_PROVIDER_ID } from "./eigenwelt-paid-manifest.js";
import type { ServerEngineSettings } from "./ocr/settings.js";
import { appliedOrgPolicy, orgPolicySecret } from "./org-policy.js";
import type { ServerConfig } from "./types.js";

/**
 * The firm's AI providers and models (chat, SystemOne, OCR) as they apply on
 * this computer. A provider's API key comes from the policy's secrets, which
 * are kept in memory while signed in: after a sign-out the firm's providers
 * stay listed but cannot be used until the member signs in again.
 */

async function secretFor(config: ServerConfig, ref: string | null): Promise<{ usable: boolean; key: string | null }> {
  if (ref === null) return { usable: true, key: null };
  const key = await orgPolicySecret(config, ref);
  return { usable: key !== null, key };
}

/** Engine provider blocks for the firm's chat providers that can be used now. */
export async function orgChatProviderBlocks(config: ServerConfig): Promise<Record<string, unknown>> {
  const providers = (await appliedOrgPolicy(config, "ai.chat.providers"))?.value ?? [];
  const blocks: Record<string, unknown> = {};
  for (const provider of providers) {
    const secret = await secretFor(config, provider.secretRef);
    if (!secret.usable) continue;
    blocks[provider.id] = {
      npm: provider.apiType === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
      name: provider.name,
      options: { baseURL: provider.baseURL, ...(secret.key ? { apiKey: secret.key } : {}) },
      models: buildEigenweltModelsMap(provider.models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        contextLength: model.contextLimit,
        maxOutputTokens: model.outputLimit,
      }))),
    };
  }
  return blocks;
}

/** While the firm allows no providers of the member's own: the providers the engine may use. */
export async function orgEnabledProviders(config: ServerConfig): Promise<string[] | null> {
  if ((await appliedOrgPolicy(config, "ai.chat.allowCustom"))?.value !== false) return null;
  const providers = (await appliedOrgPolicy(config, "ai.chat.providers"))?.value ?? [];
  return [EIGENWELT_PROVIDER_ID, ...providers.map((provider) => provider.id)];
}

/** The firm's SystemOne providers; `apiKey` is null while their key is unavailable. */
export async function orgSystemOneProviders(config: ServerConfig) {
  const providers = (await appliedOrgPolicy(config, "ai.systemOne.providers"))?.value ?? [];
  return Promise.all(providers.map(async (provider) => ({
    id: provider.id,
    name: provider.name,
    endpoint: provider.endpoint,
    enabled: true,
    models: provider.models,
    apiKey: (await secretFor(config, provider.secretRef)).key ?? (provider.secretRef === null ? "" : null),
  })));
}

/** The firm's OCR engines (their keys resolve through `org:` references), default and whether members may add their own. */
export async function orgOcr(config: ServerConfig): Promise<{
  engines: ServerEngineSettings[];
  defaultEngineId: string | null;
  allowCustom: boolean;
  resolveApiKey: (reference: string) => Promise<string | undefined>;
}> {
  const engines = (await appliedOrgPolicy(config, "ai.ocr.engines"))?.value ?? [];
  return {
    engines: engines.map((engine) => ({
      id: engine.id,
      label: engine.label,
      kind: engine.kind,
      model: engine.model,
      endpoint: engine.endpoint,
      apiKeyRef: `org:${engine.secretRef}`,
      languages: null,
      maxTokens: 8192,
    })),
    defaultEngineId: (await appliedOrgPolicy(config, "ai.ocr.defaultEngine"))?.value ?? null,
    allowCustom: (await appliedOrgPolicy(config, "ai.ocr.allowCustom"))?.value !== false,
    resolveApiKey: async (reference) => (await orgPolicySecret(config, reference.slice("org:".length))) ?? undefined,
  };
}
