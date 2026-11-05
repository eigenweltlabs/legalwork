import { isIP } from "node:net";
import { z } from "zod";
import { rawHttpOutputSchema } from "./raw-http-schema.js";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*$/);
const address = z.object({ address: z.string(), family: z.number() }).strict()
  .refine(value => isIP(value.address) === value.family && (value.family === 4 || value.family === 6));
const request = z.object({
  url: z.string().refine(value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }),
  method: z.string(), headers: z.record(z.string(), z.string()), bodyBase64: z.string(),
  bodyPresent: z.boolean(), bodyBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const proxy = z.object({ HTTP_PROXY: z.string().optional(), http_proxy: z.string().optional(), HTTPS_PROXY: z.string().optional(), https_proxy: z.string().optional(), ALL_PROXY: z.string().optional(), all_proxy: z.string().optional(), NO_PROXY: z.string().optional(), no_proxy: z.string().optional() }).strict();
/** Fixed private transport inputs, never executable/code/certificate settings. */
export const rawHttpNodeRequest = z.object({ kind: z.literal("request"), id, request, address, addresses: z.array(address).min(1), proxy }).strict()
  .refine(value => value.addresses.some(item => item.address === value.address.address && item.family === value.address.family));
export const rawHttpNodeInput = z.union([rawHttpNodeRequest, z.object({ kind: z.literal("cancel"), id }).strict(), z.object({ kind: z.literal("ack"), id }).strict(), z.object({ kind: z.literal("shutdown") }).strict()]);
export const rawHttpNodeError = z.object({ name: z.string(), message: z.string(), stack: z.string().optional(), code: z.string().optional(), details: z.string() }).strict();
export const rawHttpNodeReply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), pid: z.number().int().positive(), node: z.string(), openssl: z.string(), rss: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("settled"), id, outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("result"), result: rawHttpOutputSchema.omit({ url: true, redirected: true }) }).strict(),
    z.object({ kind: z.literal("error"), error: rawHttpNodeError }).strict(),
  ]) }).strict(),
  z.object({ kind: z.literal("released"), id }).strict(),
]);
