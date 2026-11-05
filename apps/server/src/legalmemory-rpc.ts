import { LegalMemoryPermissionSchema, LegalMemoryPermissionReplySchema } from "./native-shared-values.js";
import { z } from "zod";

export const legalMemoryReadTools = ["list_connectors", "list_matters", "list_matter_documents", "search_semantic", "download_document", "find_related_documents"] as const;
export const legalMemoryOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), name: z.enum(legalMemoryReadTools), args: z.record(z.string(), z.json()) }).strict(),
  z.object({ type: z.literal("tree"), name: z.enum(["roots", "children", "search"]), params: z.record(z.string(), z.union([z.string(), z.number()])) }).strict(),
]);
export const legalMemoryRequestSchema = z.object({
  serverName: z.string().min(1), operation: legalMemoryOperationSchema,
}).strict();
export const legalMemoryResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({ ok: z.literal(false), code: z.enum(["permission_denied", "cancelled", "not_configured", "tree_unavailable", "tool_unavailable", "request_failed"]), message: z.string() }),
]);
export type LegalMemoryRequest = z.infer<typeof legalMemoryRequestSchema>;
export type LegalMemoryResponse = z.infer<typeof legalMemoryResponseSchema>;
export const legalMemoryRpc = {
  id: "legalwork.legalmemory-access",
  methods: { permissions: { input: { type: "object", properties: {}, additionalProperties: false }, output: z.toJSONSchema(z.object({ requests: z.array(LegalMemoryPermissionSchema) })) }, reply: { input: z.toJSONSchema(LegalMemoryPermissionReplySchema), output: { type: "object", properties: { replied: { type: "boolean" } }, required: ["replied"], additionalProperties: false } }, cleanup: { input: { type: "object", properties: {}, additionalProperties: false }, output: { type: "object", properties: { removed: { type: "integer" } }, required: ["removed"], additionalProperties: false } }, servers: { input: { type: "object", properties: {}, additionalProperties: false }, output: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"], additionalProperties: false } }, request: { input: z.toJSONSchema(legalMemoryRequestSchema), output: z.toJSONSchema(legalMemoryResponseSchema) } }, events: {},
} satisfies import("@opencode/schema/rpc").PortableDefinition;

/** Explicit security/cancellation failures must never become a tree fallback. */
export class LegalMemoryAccessError extends Error {
  constructor(readonly code: Exclude<LegalMemoryResponse, { ok: true }>["code"], message: string) { super(message); }
}
export function canFallbackLegalMemoryTree(error: unknown): boolean {
  return error instanceof LegalMemoryAccessError ? (error.code === "tree_unavailable" || error.code === "tool_unavailable") : !(error instanceof DOMException && error.name === "AbortError");
}
