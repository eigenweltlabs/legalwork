import { z } from "zod";

export const CORPUS_MAX_FILES = 1000;

export const CorpusQuerySchema = z.strictObject({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(CORPUS_MAX_FILES).optional().describe("Exact project-relative files or folders requested by the user. Pass the named folder directly, e.g. ['Jev Search Corpus'], not the whole project. Folders recurse automatically in one job for up to 1,000 files; never enumerate their files or split into 250/500-file batches."),
  question: z.string().trim().min(3).max(2000).optional(),
  kind: z.enum(["yes_no", "classification"]).default("yes_no"),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(27).optional(),
  jobId: z.string().uuid().optional(),
  answers: z.array(z.string().max(100)).max(30).optional().describe("Result filter, not a restriction on which files run. For 'which files contain X', use ['Yes']. Counts still cover every processed file."),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(30),
  waitSeconds: z.number().int().min(0).max(25).default(20),
  cancel: z.boolean().default(false),
  evidencePath: z.string().min(1).max(4096).optional(),
  evidenceChunk: z.number().int().nonnegative().default(0),
  evidenceOffset: z.number().int().nonnegative().default(0),
  evidenceLimit: z.number().int().min(500).max(12000).default(6000),
});
export type CorpusQuery = z.infer<typeof CorpusQuerySchema>;
export const CORPUS_FALLBACKS = ["Not found", "Not applicable", "Unclear"];
export const CorpusRowSchema = z.object({
  path: z.string(), status: z.enum(["complete", "uncertain", "error", "unsupported"]),
  answer: z.string().nullable(), confidence: z.number().nullable(), error: z.string().optional(),
  sources: z.array(z.object({ chunk: z.number().int().nonnegative(), pages: z.array(z.number().int().positive()) })).optional(),
  extraction: z.enum(["native", "ocr"]).optional(), chunks: z.number().optional(), sourceHash: z.string().optional(),
});
export type CorpusRow = z.infer<typeof CorpusRowSchema>;
export const SavedCorpusJobSchema = z.object({
  id: z.string().uuid(), requestId: z.string().optional(), createdAt: z.number(),
  status: z.enum(["running", "complete", "cancelled", "interrupted"]),
  rows: z.array(CorpusRowSchema).max(CORPUS_MAX_FILES), total: z.number().int().nonnegative().max(CORPUS_MAX_FILES), skipped: z.number().int().nonnegative(),
  question: z.string(), kind: z.enum(["yes_no", "classification"]),
  selection: z.object({ providerId: z.string(), model: z.string() }),
});
export type SavedCorpusJob = z.infer<typeof SavedCorpusJobSchema>;
