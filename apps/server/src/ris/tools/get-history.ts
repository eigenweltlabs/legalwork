import { historyApplication } from "../types.js";
// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * ris_get_history — what changed in an Anwendung between two dates.
 * Wraps the upstream /History controller.
 */
import { z } from "zod";
import type { RisClient } from "../client/ris-client.js";
import { ApplikationEnum } from "../schemas/enums.js";
import { RisCitationLeanSchema } from "../schemas/citation.js";
import { PaginationResponseSchema } from "../schemas/shared.js";
import { buildLeanCitation } from "../client/citation.js";
import { extractTitles } from "../client/normalization.js";
import { pickUpstreamPageSize } from "../client/translation.js";
import { RisBulkFetchRefused } from "../infrastructure/errors.js";

export const GetHistoryInputSchema = z.object({
  anwendung: ApplikationEnum.describe("The application to track (e.g. BgblAuth, BrKons, Vfgh)."),
  from_date: z.string().describe("YYYY-MM-DD."),
  to_date: z.string().optional().describe("YYYY-MM-DD. Defaults to today (UTC)."),
  include_deleted: z.boolean().default(false),
  limit:  z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  bulk_acknowledged: z.boolean().default(false),
}).strict();

const HistoryItemSchema = z.object({
  // The /History controller reports presence/deletion, not an add-vs-modify
  // distinction — non-deleted records are always "modified". "added" is kept
  // in the enum for compatibility but is not emitted.
  action: z.enum(["added", "modified", "deleted"]),
  import_timestamp: z.string().optional(),
  kurztitel: z.string().optional(),
  ris_citation: RisCitationLeanSchema,
});

export const GetHistoryOutputSchema = PaginationResponseSchema.extend({
  anwendung: ApplikationEnum,
  from_date: z.string(),
  to_date: z.string(),
  items: z.array(HistoryItemSchema),
});

export type GetHistoryInput = z.infer<typeof GetHistoryInputSchema>;
export type GetHistoryOutput = z.infer<typeof GetHistoryOutputSchema>;

const BULK_FETCH_THRESHOLD = 1000;

export function buildGetHistoryTool(client: RisClient) {
  return {
    description:
      "Lists records added, modified, or deleted in a given RIS application between two dates. The freshness primitive for change tracking — prefer this over re-running a search when you only need 'what's new since X'. Result records carry ImportTimestamp.",
    inputSchema: GetHistoryInputSchema,
    outputSchema: GetHistoryOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (input: GetHistoryInput): Promise<GetHistoryOutput> => {
      const to = input.to_date ?? new Date().toISOString().slice(0, 10);

      if (!input.bulk_acknowledged) {
        const requested = input.offset + input.limit;
        if (requested > BULK_FETCH_THRESHOLD) {
          throw new RisBulkFetchRefused(requested, BULK_FETCH_THRESHOLD);
        }
      }

      const params = new Map<string, string>();
      params.set("Anwendung", historyApplication(input.anwendung));
      params.set("AenderungenVon", input.from_date);
      params.set("AenderungenBis", to);
      if (input.include_deleted) params.set("IncludeDeletedDocuments", "True");

      const upstreamPage = pickUpstreamPageSize(input.limit);
      params.set("DokumenteProSeite", upstreamPage.label);

      const { total, records } = await client.queryPaged("History", params, {
        limit: input.limit,
        offset: input.offset,
        upstreamPageSize: upstreamPage.size,
      });

      const items: z.infer<typeof HistoryItemSchema>[] = records.map((rec) => {
        const isDeleted = Boolean(rec.Data.Deleted);
        const ts = rec.Data.Metadaten.Technisch?.ImportTimestamp;
        const tsStr = typeof ts === "string" ? ts : undefined;
        return {
          // Upstream exposes no reliable add-vs-modify signal (nearly every
          // record carries an ImportTimestamp), so don't fabricate "added".
          action: isDeleted ? "deleted" : "modified",
          import_timestamp: tsStr,
          kurztitel: extractTitles(rec).kurztitel,
          ris_citation: buildLeanCitation(rec),
        };
      });

      const has_more = input.offset + items.length < total;
      return {
        anwendung: input.anwendung,
        from_date: input.from_date,
        to_date: to,
        total,
        count: items.length,
        offset: input.offset,
        limit: input.limit,
        has_more,
        next_offset: has_more ? input.offset + items.length : null,
        items,
      };
    },
  };
}
