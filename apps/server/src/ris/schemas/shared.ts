// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * Shared schemas: pagination, content URLs, common result envelope.
 */
import { z } from "zod";

export const PaginationInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const PaginationResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  refinement_hint: z.string().optional(),
  pagination_warning: z.string().optional(),
});

export const ContentUrlsSchema = z.object({
  canonical: z.string().url().describe("Primary URL (HTML, or PDF for gazettes without HTML)."),
  authentic: z
    .string()
    .url()
    .optional()
    .describe("Amtssigniert .pdfsig — legally binding artefact. Present only when is_authentic=true."),
  alternates: z
    .record(z.string(), z.string().url())
    .optional()
    .describe(
      'Other format URLs. Present only when include_raw_content_urls=true. Keys: "xml", "html", "pdf", "rtf", etc.',
    ),
});

export const DatesSummarySchema = z.object({
  published: z.string().nullable(),
  modified: z.string().nullable(),
  in_force_from: z.string().nullable(),
  in_force_to: z.string().nullable(),
});

export type PaginationInput = z.infer<typeof PaginationInputSchema>;
export type PaginationResponse = z.infer<typeof PaginationResponseSchema>;
export type ContentUrls = z.infer<typeof ContentUrlsSchema>;
export type DatesSummary = z.infer<typeof DatesSummarySchema>;
