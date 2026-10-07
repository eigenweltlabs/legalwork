import { z } from "zod";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

export function modelCatalogBaseURL(): string {
  const baseURL = process.env.OPENCODE_MODELS_URL?.trim().replace(/\/+$/, "") ||
    "https://platform.eigenweltlabs.com/api/public/model-catalog";
  const url = new URL(baseURL);
  const ownHost = url.hostname === "platform.eigenweltlabs.com";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === "https:" && ownHost || loopback && ["http:", "https:"].includes(url.protocol))) {
    throw new Error("Model catalog updates must use Eigenwelt or a local development server.");
  }
  return baseURL;
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
export const modelCatalogSchema = z.record(z.string(), z.object({
  models: z.record(z.string(), z.unknown()),
}).passthrough()).refine((value) => Object.keys(value).length > 0);
const catalogProvider = z.object({ models: z.record(z.string(), model) });

/** Keep catalog capabilities for new built-in models without replacing user overrides. */
export function providerModelsFromCatalog(providerId: string, value: unknown): NonNullable<ProviderConfig["models"]> {
  const result = z.record(z.string(), z.unknown()).safeParse(value);
  if (!result.success) throw new Error("The model catalog returned invalid model information.");
  if (!result.data[providerId]) throw new Error(`No model catalog is available for ${providerId}.`);
  const provider = catalogProvider.safeParse(result.data[providerId]);
  if (!provider.success) throw new Error("The model catalog returned invalid model information.");
  return provider.data.models;
}
