import { Model } from "@opencode/schema/model";
import { Option, Schema } from "effect";
import { z } from "zod";

const price = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(), cache_write: z.number().nonnegative().optional() });
const entry = z.object({
  id: z.string().optional(), name: z.string(), status: z.literal("deprecated"), family: z.string().optional(),
  release_date: z.string().optional(), tool_call: z.boolean(), temperature: z.boolean().optional(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }),
  limit: z.object({ context: z.number().int().nonnegative(), input: z.number().int().nonnegative().optional(), output: z.number().int().nonnegative() }),
  cost: price.extend({ tiers: z.array(price.extend({ tier: z.object({ type: z.literal("context"), size: z.number().int() }) })).optional() }).optional(),
  provider: z.object({ npm: z.string().optional(), api: z.string().optional(), shape: z.enum(["responses", "completions"]).optional() }).optional(),
  interleaved: z.union([z.boolean(), z.string(), z.object({ field: z.string() })]).optional(),
  reasoning_options: z.array(z.object({ type: z.string(), values: z.array(z.union([z.string(), z.null()])).optional() }).passthrough()).optional(),
});
const catalog = z.object({ azure: z.object({ models: z.record(z.string(), z.unknown()) }) });
const packages: Record<string, string> = {
  "@ai-sdk/azure": "@opencode/ai/providers/azure/responses",
  "@ai-sdk/openai": "@opencode/ai/providers/openai/responses",
  "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
  "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
};

/** Restore metadata definitions through OpenCode's public provider API. Azure's
 * native discovery still decides which deployments are available; status stays intact. */
export function azureModelDefinitions(input: unknown): Model.Info[] {
  const parsed = catalog.safeParse(input);
  if (!parsed.success) return [];
  return Object.entries(parsed.data.azure.models).flatMap(([id, value]) => {
    const decoded = entry.safeParse(value);
    if (!decoded.success || !decoded.data.modalities.output.includes("text")) return [];
    const model = decoded.data, sdk = model.provider?.npm;
    if (sdk && !packages[sdk] && !sdk.startsWith("@opencode/ai/providers/")) return [];
    const packageName = sdk ? packages[sdk] ?? sdk : undefined;
    const settings = {
      ...(model.provider?.api ? { baseURL: model.provider.api } : {}),
      ...(packageName === "@opencode/ai/providers/openai-compatible" ? { provider: "azure" } : {}),
    };
    const variants = (model.reasoning_options ?? []).flatMap(option => option.type === "effort"
      ? (option.values ?? []).filter((effort): effort is string => effort !== null && effort !== "null").map(effort => ({ id: effort, settings: { reasoningEffort: effort } })) : []);
    const cost = (item: z.infer<typeof price>) => ({ input: item.input, output: item.output, cache: { read: item.cache_read ?? 0, write: item.cache_write ?? 0 } });
    const released = Date.parse(model.release_date ?? "");
    const field = typeof model.interleaved === "string" ? model.interleaved : typeof model.interleaved === "object" ? model.interleaved.field : undefined;
    const nativePackage = model.provider?.shape === "completions" && (sdk === undefined || sdk === "@ai-sdk/azure") ? "@opencode/ai/providers/azure/chat" : packageName;
    const definition = Option.getOrUndefined(Schema.decodeUnknownOption(Model.Info)({
      id: model.id ?? id, modelID: model.id ?? id, providerID: "azure", name: model.name,
      ...(model.family ? { family: model.family } : {}), ...(nativePackage ? { package: nativePackage } : {}),
      ...(Object.keys(settings).length ? { settings } : {}), ...(field ? { compatibility: { reasoningField: field } } : {}),
      capabilities: { tools: model.tool_call, input: model.modalities.input, output: model.modalities.output, ...(model.temperature === undefined ? {} : { temperature: model.temperature }) },
      limit: model.limit, status: model.status, enabled: true, variants,
      time: { released: Number.isFinite(released) ? released : 0 },
      cost: model.cost ? [cost(model.cost), ...(model.cost.tiers ?? []).map(tier => ({ ...cost(tier), tier: tier.tier }))] : [],
    }));
    return definition ? [definition] : [];
  });
}
