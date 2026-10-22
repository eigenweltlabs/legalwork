import { z } from "zod";

export const provenanceSchema = z.object({ provider: z.enum(["chatgpt", "claude"]), kind: z.enum(["folder", "archive", "github", "configuration"]), location: z.string(), root: z.string(), ref: z.string().optional(), directory: z.string().optional(), marketplace: z.string().optional(), asWorkflow: z.boolean().optional(), revision: z.string().optional(), digest: z.string(), version: z.string().nullable() });
export const requirementSchema = z.object({ kind: z.enum(["dependency", "app", "runtime", "permission"]), name: z.string(), code: z.string(), message: z.string(), required: z.boolean(), status: z.enum(["setup", "blocked", "changed", "satisfied"]), version: z.string().optional(), marketplace: z.string().optional() });
export const importStateSchema = z.object({ readiness: z.enum(["ready", "setup", "partial", "unsupported"]), requirements: z.array(requirementSchema) });
export const importHistorySchema = z.array(z.object({ at: z.number(), action: z.enum(["installed", "updated", "rolled_back"]), digest: z.string(), version: z.string().nullable(), revision: z.string().optional() }));
