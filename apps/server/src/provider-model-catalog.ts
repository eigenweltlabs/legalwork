import { z } from "zod";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

export function modelCatalogBaseURL(): string {
  return process.env.OPENCODE_MODELS_URL?.trim().replace(/\/+$/, "") ||
    "https://models.opencode.ai";
}

const cost = z.object({
  input: z.number().nonnegative(), output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(), cache_write: z.number().nonnegative().optional(),
});
const modality = z.enum(["text", "audio", "image", "video", "pdf"]);
const model = z.object({
  id: z.string().optional(), name: z.string(), family: z.string().optional(), release_date: z.string().optional(),
  attachment: z.boolean().optional(), reasoning: z.boolean().optional(),
  temperature: z.boolean().optional(), tool_call: z.boolean().optional(),
  interleaved: z.union([z.boolean(), z.string(), z.object({ field: z.string() })]).optional(),
  cost: cost.extend({ context_over_200k: cost.optional() }).optional(),
  limit: z.object({ context: z.number().nonnegative(), output: z.number().nonnegative(), input: z.number().nonnegative().optional() }),
  modalities: z.object({ input: z.array(modality).optional(), output: z.array(modality).optional() }).optional(),
  status: z.enum(["alpha", "beta", "deprecated", "active"]).optional(),
  provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
});
const catalog = z.record(z.string(), z.unknown());
const catalogProvider = z.object({ models: z.record(z.string(), model) });

/** Keep catalog capabilities for new built-in models without replacing user overrides. */
export async function fetchProviderModelCatalog(providerId: string, baseURL = modelCatalogBaseURL()): Promise<NonNullable<ProviderConfig["models"]>> {
  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/api.json`, {
    cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Could not refresh the model catalog (HTTP ${response.status}).`);
  const result = catalog.safeParse(await response.json());
  if (!result.success) throw new Error("The model catalog returned invalid model information.");
  if (!result.data[providerId]) throw new Error(`No model catalog is available for ${providerId}.`);
  const provider = catalogProvider.safeParse(result.data[providerId]);
  if (!provider.success) throw new Error("The model catalog returned invalid model information.");
  return provider.data.models;
}
