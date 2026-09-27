import { z } from "zod";
import { PageStructureSchema, DocumentRelationSchema } from "@legalwork/types/document-structure";
import { contentSchema } from "../ocr/types.js";

export const pageSchema = z.object({
  page: z.number().int().positive(), nativeText: z.string(),
  structure: PageStructureSchema.optional(),
  ocr: contentSchema.nullable(), width: z.number(), height: z.number(),
  status: z.enum(["complete", "needs-review", "error"]), error: z.string().optional(),
});
export const preparedSchema = z.object({
  version: z.enum(["review-preparation-1", "review-preparation-2"]), key: z.string(), file: z.string(), fileAbs: z.string(), sourceSha256: z.string(),
  engine: z.object({ id: z.string(), label: z.string(), model: z.string(), execution: z.enum(["local", "remote"]) }),
  layoutFingerprint: z.string().optional(), relations: z.array(DocumentRelationSchema).default([]),
  pageCount: z.number().int().nonnegative(), pages: z.array(pageSchema),
  status: z.enum(["complete", "needs-review", "error"]), error: z.string().optional(),
});
export type PreparedDocument = z.infer<typeof preparedSchema>;
