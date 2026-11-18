import { z } from "zod";
import { ConfigProvider } from "@opencode/schema/config/provider";
import { Schema } from "effect";

// Eigenwelt's external model-manifest contract. This is business metadata,
// distinct from the native configuration LegalWork stores and sends to OpenCode.
const gatewayCostSchema = z.object({
  input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
  cache_read: z.number().finite().nonnegative(), cache_write: z.number().finite().nonnegative(),
});
export const OpenCodeModelConfigSchema = z.object({
  cost: gatewayCostSchema.extend({ context_over_200k: gatewayCostSchema.optional() }).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  variants: z.record(z.string(), z.object({ disabled: z.boolean().optional() }).catchall(z.unknown())).optional(),
  interleaved: z.union([z.boolean(), z.string(), z.object({ field: z.string() })]).optional(),
});
export type OpenCodeModelConfig = z.infer<typeof OpenCodeModelConfigSchema>;

export type NativeProviderModels = NonNullable<(typeof ConfigProvider.Info.Type)["models"]>;
export type NativeProviderDefinition = typeof ConfigProvider.Info.Type;
export function nativeProviderDefinition(value: unknown): NativeProviderDefinition {
  return Schema.decodeUnknownSync(ConfigProvider.Info)(value, { onExcessProperty: "error" });
}
const compatibleSettings = new Set(["apiKey", "baseURL", "timeout", "chunkTimeout", "headerTimeout", "disabled", "reasoningEffort", "textVerbosity", "user", "strictJsonSchema"]);
function defined(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** The gateway publishes OpenAI-compatible controls. Native provider settings
 * and raw HTTP body fields have distinct destinations; unknown body fields are
 * retained so provider-specific controls do not disappear. */
function gatewayOptions(value: Record<string, unknown> = {}) {
  const { headers, body, extraBody, ...options } = value;
  return {
    settings: Object.fromEntries(Object.entries(options).filter(([key]) => compatibleSettings.has(key))),
    body: { ...Object.fromEntries(Object.entries(options).filter(([key]) => !compatibleSettings.has(key))), ...object(body), ...object(extraBody) },
    ...(headers === undefined ? {} : { headers }),
  };
}

export function nativeGatewayModelControls(model: OpenCodeModelConfig) {
  const pricing = OpenCodeModelConfigSchema.shape.cost.safeParse(model.cost);
  const cost = pricing.success ? pricing.data : undefined;
  const field = typeof model.interleaved === "string" ? model.interleaved
    : model.interleaved && typeof model.interleaved === "object" ? model.interleaved.field : undefined;
  const { setCacheKey, ...options } = model.options ?? {};
  let disableThinkingBlockBinding = false;
  for (const name of ["thinking", "reasoningConfig"]) {
    const nested = object(options[name]);
    if (nested.blockBinding !== false) continue;
    disableThinkingBlockBinding = true;
    const { blockBinding, ...kept } = nested;
    if (Object.keys(kept).length) options[name] = kept;
    else delete options[name];
  }
  const compatibility = {
    ...(field === undefined ? {} : { reasoningField: field }),
    ...(setCacheKey === undefined ? {} : { supportsPromptCacheKey: setCacheKey }),
    ...(disableThinkingBlockBinding ? { supportsThinkingBlockBinding: false } : {}),
  };
  return {
    ...(cost ? { cost: [
      { input: cost.input, output: cost.output, cache: { read: cost.cache_read, write: cost.cache_write } },
      ...(cost.context_over_200k ? [{ tier: { type: "context", size: 200_000 }, input: cost.context_over_200k.input,
        output: cost.context_over_200k.output, cache: { read: cost.context_over_200k.cache_read, write: cost.context_over_200k.cache_write } }] : []),
    ] } : {}),
    ...gatewayOptions(options),
    ...(Object.keys(compatibility).length ? { compatibility } : {}),
    ...(model.variants === undefined ? {} : { variants: Object.entries(model.variants)
      .filter(([, variant]) => variant.disabled !== true)
      .map(([id, { disabled, ...options }]) => ({ id, ...gatewayOptions(options) })) }),
  };
}

/** Validate a newly built native model inventory; never infer a configuration
 * version from its fields or pass native overrides through a legacy converter. */
export function nativeProviderModels(models: Record<string, unknown>): NativeProviderModels {
  return nativeProviderDefinition({ models }).models ?? {};
}
