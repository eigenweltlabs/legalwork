import { isRecord } from "../types.js";
// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * ris_search — universal search across all controllers and applications.
 *
 * Lean by default; opt-in to full metadata via include_full_metadata=true
 * (caps limit to 25). Multi-app fan-out resolves the upstream controller per
 * application and survives per-app failures (reported in applikations_failed).
 */
import { z } from "zod";
import type { RisClient } from "../client/ris-client.js";
import type { Applikation, RawDocRef } from "../types.js";
import { CORPUS_MAP, controllerForApp } from "../types.js";
import {
  ApplikationEnum, BundeslandEnum, CorpusEnum, DocumentTypeEnum,
  SincePeriodEnum, SortByEnum,
} from "../schemas/enums.js";
import { type PaginationResponse } from "../schemas/shared.js";
import { RisCitationLeanSchema, RisCitationFullSchema } from "../schemas/citation.js";
import { buildSearchParams, pickUpstreamPageSize } from "../client/translation.js";
import { buildLeanCitation, buildFullCitation } from "../client/citation.js";
import {
  RisValidationError, RisBulkFetchRefused,
} from "../infrastructure/errors.js";
import { extractTitles } from "../client/normalization.js";


// ---- Input schema --------------------------------------------------------------

export const SearchInputSchema = z
  .object({
    corpus: CorpusEnum.describe(
      "Coarse selector mapping to one or more applications. Use 'federal_law' for consolidated Bundesrecht; 'case_law' for Vfgh/Vwgh/Justiz/Bvwg/Lvwg and friends; 'gazettes' for BgblAuth/LgblAuth/...",
    ),
    applikation: ApplikationEnum.optional().describe(
      "Narrows to a specific RIS application within the chosen corpus. Omit to fan out across all apps of the corpus (slow for case_law; failures per app are reported, not fatal).",
    ),

    query: z.string().optional().describe(
      "Full-text search over document TEXT (German). Boolean operators: 'und', 'oder', 'nicht'. One '*' wildcard per word, ≥2 chars before and after. NOT for statute names — a name in query returns every document that merely mentions it; use title instead.",
    ),
    title: z.string().optional().describe(
      "Title search over Langtitel, Kurztitel AND Abkürzung — use this for law names and abbreviations ('IFG' ≡ 'Informationsfreiheitsgesetz'). Variants may be combined: 'IFG oder Informationsfreiheitsgesetz'.",
    ),

    date_from: z.string().optional().describe("Lower bound for the relevant date (Kundmachung / Entscheidung / Veröffentlichung depending on corpus). YYYY-MM-DD."),
    date_to:   z.string().optional().describe("Upper bound for the relevant date. YYYY-MM-DD."),
    in_force_on: z.string().optional().describe("Consolidated law only — restricts to the version in force on this date. YYYY-MM-DD."),

    gesetzesnummer: z.string().optional().describe(
      "Stable numeric key of one law (every consolidated-law hit carries it in ris_citation.gesetzesnummer). Searching with it returns one hit per section — the law's table of contents.",
    ),
    kundmachungsorgan: z.string().optional().describe("e.g. 'BGBl. I Nr.'"),
    geschaeftszahl: z.string().optional().describe("Case number; for Upts, wrapper aliases to upstream 'GZ'."),
    norm: z.string().optional().describe("Case law: decisions citing a given norm, e.g. '§ 3 AsylG 2005'."),
    gericht: z.string().optional().describe("Case law: court name."),

    bundesland: z.union([BundeslandEnum, z.array(BundeslandEnum)]).optional().describe(
      "One of nine Austrian states. For state-law apps (LrKons/LgblAuth/Lgbl/Vbl) accepts an array — wrapper expands to SucheIn{State}=true upstream. For value-style apps (Bvb/Gr/GrA/Lvwg/Uvs) takes a single value.",
    ),

    rechtsgebiet: z.string().optional(),
    fachgebiet:   z.string().optional(),
    einbringende_stelle: z.string().optional(),
    entscheidungsart: z.string().optional(),
    since_period: SincePeriodEnum.optional(),

    document_type: z.array(DocumentTypeEnum).optional().describe(
      "Multi-select. Mapped upstream to Typ.SucheInGesetzen/.SucheInVerordnungen/.SucheInKundmachungen/.SucheInSonstiges.",
    ),

    filters: z.record(z.string(), z.unknown()).optional().describe(
      "Per-application niche filters. Call ris_list_scopes(field, applikation) to discover valid fields and values.",
    ),

    sort_by: SortByEnum.optional().default("relevance"),

    limit:  z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),

    include_full_metadata: z.boolean().default(false).describe("Includes Indizes, Schlagworte, Anmerkung, Aenderung lists, and the full ris_citation. Requires limit ≤ 25 (a larger limit is rejected)."),
    include_raw_content_urls: z.boolean().default(false).describe("Includes the full ContentUrl array (xml/html/pdf/rtf/authentisch) under content_urls.alternates."),

    bulk_acknowledged: z.boolean().default(false).describe("Set true to bypass the bulk-fetch refusal when paginating past 1,000 records. Caller affirms they have RIS upstream consent."),
  })
  .strict();

export type SearchInput = z.infer<typeof SearchInputSchema>;

// ---- Output schema -------------------------------------------------------------

const ItemSchema = z.object({
  kurztitel: z.string().optional(),
  titel: z.string().optional(),
  type: z.string().optional(),
  score: z.number().optional(),
  ris_citation: z.union([RisCitationLeanSchema, RisCitationFullSchema]),
});

const AppFailureSchema = z.object({
  applikation: ApplikationEnum,
  error: z.string(),
});

export const SearchOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit:  z.number().int().positive(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  refinement_hint:    z.string().optional(),
  pagination_warning: z.string().optional(),
  applikations_searched: z.array(ApplikationEnum),
  applikations_failed: z.array(AppFailureSchema).optional().describe(
    "Apps that errored during a multi-app fan-out. Their records are missing from items; totals cover the successful apps only.",
  ),
  items: z.array(ItemSchema),
});

export type SearchOutput = z.infer<typeof SearchOutputSchema>;

// ---- Tool handler --------------------------------------------------------------

const BULK_FETCH_THRESHOLD = 1000;

export function buildSearchTool(client: RisClient) {
  return {
    description:
      "Universal search across all RIS applications. For statute names/abbreviations use title= (matches Langtitel/Kurztitel/Abkürzung — 'IFG' ≡ 'Informationsfreiheitsgesetz'); query= is German full-text over document text and returns every document mentioning the term. Lean records carry ris_citation with gesetzesnummer (consolidated law) or geschaeftszahl/entscheidungsdatum/gericht (case law); include_full_metadata=true adds the full Metadaten block (limit ≤25). Set applikation to narrow (recommended for case_law); otherwise the wrapper fans out across the corpus and reports per-app errors in applikations_failed. Consolidated-law ordering is alphabetical, not relevance-ranked. Duplicate section hits are different Fassungen (versions).",
    inputSchema: SearchInputSchema,
    outputSchema: SearchOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (input: SearchInput): Promise<SearchOutput> => {
      enforceTierCaps(input);

      const apps = resolveApps(input);

      // Bulk-fetch guard: cap the depth of the requested window, not a
      // per-app product. We only ever fetch ~limit records regardless of the
      // app count, so the meaningful limit is how deep the global offset goes.
      if (!input.bulk_acknowledged) {
        const wouldFetch = input.offset + input.limit;
        if (wouldFetch > BULK_FETCH_THRESHOLD) {
          throw new RisBulkFetchRefused(wouldFetch, BULK_FETCH_THRESHOLD);
        }
      }

      const toItem = (raw: RawDocRef): z.infer<typeof ItemSchema> => {
        const t = extractTitles(raw);
        const citation = input.include_full_metadata ? buildFullCitation(raw) : buildLeanCitation(raw);
        return {
          kurztitel: t.kurztitel,
          titel: input.include_full_metadata ? t.titel : undefined,
          type: extractTypeField(raw),
          ris_citation: citation,
        };
      };

      // ---- Single app: page directly against the one controller. ----
      if (apps.length === 1) {
        const app = apps[0]!;
        const upstreamPage = pickUpstreamPageSize(input.limit);
        const { total, records } = await client.queryPaged(
          controllerForApp(app),
          buildSearchParams({ ...input, applikation: app }),
          { limit: input.limit, offset: input.offset, upstreamPageSize: upstreamPage.size },
        );
        const items = records.map(toItem);
        return {
          ...buildPagination({ total, count: items.length, offset: input.offset, limit: input.limit, input }),
          applikations_searched: apps,
          items,
        };
      }

      // ---- Multi-app fan-out. ----
      // The global result list is the concatenation of each app's results in
      // corpus order. To serve [offset, offset+limit) *correctly* we first learn
      // each app's total (cheap count), then fetch the exact window from the
      // app(s) it spans. The previous approach queried every app at the same
      // shared offset and sliced the concatenation to `limit`, which silently
      // dropped every app after the first and made deep pages unreachable.
      const failures: Array<{ applikation: Applikation; error: string }> = [];
      let firstError: unknown;

      // 1) Per-app totals in parallel. A failing app is recorded, not fatal.
      const counted = await Promise.all(
        apps.map(async (app) => {
          try {
            const total = await client.count(
              controllerForApp(app),
              buildSearchParams({ ...input, applikation: app }),
            );
            return { app, total, ok: true };
          } catch (err) {
            firstError ??= err;
            failures.push({ applikation: app, error: err instanceof Error ? err.message : "RIS application failed" });
            return { app, total: 0, ok: false };
          }
        }),
      );

      // Every app failed → surface the first real error instead of an empty result.
      if (failures.length === apps.length && firstError !== undefined) {
        throw firstError;
      }

      // 2) Lay out global offsets over the successful apps, then fetch the
      //    window across app boundaries.
      const okApps = counted.filter((c) => c.ok);
      let grandTotal = 0;
      const spans = okApps.map((c) => {
        const start = grandTotal;
        grandTotal += c.total;
        return { app: c.app, total: c.total, start };
      });

      const merged: RawDocRef[] = [];
      let need = input.limit;
      let cursor = input.offset;
      for (const span of spans) {
        if (need <= 0) break;
        if (cursor >= span.start + span.total) continue;   // window starts after this app
        const localOffset = Math.max(0, cursor - span.start);
        const take = Math.min(need, span.total - localOffset);
        if (take <= 0) continue;
        const pageSize = pickUpstreamPageSize(take);
        const { records } = await client.queryPaged(
          controllerForApp(span.app),
          buildSearchParams({ ...input, applikation: span.app, limit: take, offset: localOffset }),
          { limit: take, offset: localOffset, upstreamPageSize: pageSize.size },
        );
        for (const raw of records) merged.push(raw);
        need -= records.length;
        cursor += records.length;
      }

      const items = merged.map(toItem);
      return {
        ...buildPagination({ total: grandTotal, count: items.length, offset: input.offset, limit: input.limit, input }),
        pagination_warning: "Results are grouped by RIS application, not globally ranked or date-sorted. Select applikation for precise ordering.",
        applikations_searched: okApps.map((c) => c.app),
        ...(failures.length > 0 ? { applikations_failed: failures } : {}),
        items,
      };
    },
  };
}

// ---- Helpers -------------------------------------------------------------------

function enforceTierCaps(input: SearchInput): void {
  if (input.include_full_metadata && input.limit > 25) {
    throw new RisValidationError(
      "include_full_metadata=true caps limit at 25. Reduce limit, or call ris_get_document(id) per record to fetch full metadata individually.",
    );
  }
}

function resolveApps(input: SearchInput): Applikation[] {
  if (input.applikation) return [input.applikation];
  return CORPUS_MAP[input.corpus].apps;
}

function extractTypeField(doc: RawDocRef): string | undefined {
  for (const value of Object.values(doc?.Data?.Metadaten ?? {})) {
    if (!isRecord(value)) continue;
    const block = value;
    // Block level first: Judikatur.Dokumenttyp ("Rechtssatz" / "Entscheidungstext").
    if (typeof block.Dokumenttyp === "string") return block.Dokumenttyp;
    if (typeof block.Typ === "string") return block.Typ;
    for (const inner of Object.values(block)) {
      if (!isRecord(inner)) continue;
      const sub = inner;
      if (typeof sub.Typ === "string") return sub.Typ;
      if (typeof sub.Dokumenttyp === "string") return sub.Dokumenttyp;
    }
  }
  return undefined;
}

function buildPagination(args: {
  total: number; count: number; offset: number; limit: number; input: SearchInput;
}): PaginationResponse {
  const { total, count, offset, limit, input } = args;
  const has_more = offset + count < total;
  const next_offset = has_more ? offset + count : null;

  const out: PaginationResponse = {
    total, count, offset, limit, has_more, next_offset,
  };

  if (total > 500) {
    out.refinement_hint = "Wide query. Consider a more specific 'applikation' or a stricter date_from/date_to window.";
  } else if (total > 100 && !input.date_from && !input.date_to) {
    out.refinement_hint = "Add 'date_from' (and optionally 'date_to') to narrow.";
  } else if (total > 100 && input.corpus === "case_law" && !input.gericht) {
    out.refinement_hint = "Add 'gericht' or 'geschaeftszahl' to narrow.";
  } else if (total > 100) {
    out.refinement_hint = `Found ${total} results. Add filters (date range, applikation) to narrow.`;
  }

  if (offset > 300) {
    out.pagination_warning = "Pagination beyond this depth is rare for useful queries. Refine the search, or use ris_get_history if you're tracking changes over time.";
  }
  return out;
}
