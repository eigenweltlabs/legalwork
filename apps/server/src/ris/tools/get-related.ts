import { classifyId, normaliseIdInput } from "../client/content.js";
import { requireStateDocumentId } from "../client/state-law.js";
import { buildGetDocumentTool, GetDocumentInputSchema } from "./get-document.js";
import { RisNotFoundError } from "../infrastructure/errors.js";
import { isRecord } from "../types.js";
// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * ris_get_related — amendments / predecessors / successors of a norm, or
 * Normen cited by / citing a case-law decision.
 *
 * Strategy:
 *  - For consolidated law (BrKons/LrKons): parse the Aenderung / NovellenBeziehung
 *    fields out of the record's Metadaten block (no separate API endpoint exists).
 *  - For case law: fan out to ris_search with the document's id or
 *    Geschaeftszahl in the Norm field of related case law applications.
 */
import { z } from "zod";
import type { RisClient } from "../client/ris-client.js";
import type { Applikation } from "../types.js";
import { CORPUS_MAP, CASE_LAW_APPS, controllerForApp } from "../types.js";
import { ApplikationEnum } from "../schemas/enums.js";
import { RisCitationLeanSchema } from "../schemas/citation.js";
import { PaginationResponseSchema } from "../schemas/shared.js";
import { buildLeanCitation, flattenStrings } from "../client/citation.js";
import { extractTitles } from "../client/normalization.js";

export const RelationshipTypeEnum = z.enum([
  "amends",
  "amended_by",
  "predecessor",
  "successor",
  "cites_norm",
  "cited_by_case",
]);

export const GetRelatedInputSchema = z.object({
  id: z.string(),
  applikation: ApplikationEnum.optional(),
  relationship_types: z.array(RelationshipTypeEnum).optional().describe(
    "Filter the returned relations. Defaults to all known types for the record's corpus.",
  ),
  limit:  z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

const RelationSchema = z.object({
  type: RelationshipTypeEnum,
  target_id: z.string(),
  target_label: z.string().optional(),
  target_citation: RisCitationLeanSchema.optional(),
});

export const GetRelatedOutputSchema = PaginationResponseSchema.extend({
  id: z.string(),
  items: z.array(RelationSchema),
});

export type GetRelatedInput = z.infer<typeof GetRelatedInputSchema>;
export type GetRelatedOutput = z.infer<typeof GetRelatedOutputSchema>;

export function buildGetRelatedTool(client: RisClient) {
  return {
    description:
      "Returns the amendment / citation graph for a document. For consolidated law: amendments (NovellenBeziehung) and predecessor / successor versions. For case law: norms cited by the decision (from the 'Norm' field), and decisions that cite this one.",
    inputSchema: GetRelatedInputSchema,
    outputSchema: GetRelatedOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (input: GetRelatedInput): Promise<GetRelatedOutput> => {
      const app: Applikation = input.applikation ?? "BrKons";
      const controller = controllerForApp(app);

      const id = normaliseIdInput(input.id);
      const kind = classifyId(id);
      requireStateDocumentId(app, id);
      // 1) Fetch the source record, checking exact IDs before returning relations.
      const params = new Map<string, string>();
      params.set("Applikation", app);
      if (kind === "gesetzesnummer") {
        params.set("Gesetzesnummer", id);
      } else {
        params.set(kind === "dokumentnummer" ? "Suchworte" : app === "BrKons" || app === "LrKons" ? "Titel" : CASE_LAW_APPS.has(app) ? "Geschaeftszahl" : "Suchworte", id);
      }
      params.set("DokumenteProSeite", "Ten");
      params.set("Seitennummer", "1");
      const { records } = await client.query(controller, params);
      let source = kind === "dokumentnummer" ? records.find(record => record.Data.Metadaten.Technisch?.ID === id) : records[0];
      if (!source && kind === "dokumentnummer" && CASE_LAW_APPS.has(app)) {
        const document = await buildGetDocumentTool(client).handler(GetDocumentInputSchema.parse({ id, applikation: app }));
        if (document.ris_citation.geschaeftszahl) {
          const byCase = new Map(params);
          byCase.delete("Suchworte"); byCase.set("Geschaeftszahl", document.ris_citation.geschaeftszahl);
          byCase.set("Dokumenttyp.SucheInRechtssaetzen", "True"); byCase.set("Dokumenttyp.SucheInEntscheidungstexten", "True");
          const resolved = await client.query(controller, byCase);
          source = resolved.records.find(record => record.Data.Metadaten.Technisch?.ID === id);
        }
      }
      if (!source) throw new RisNotFoundError("Could not resolve exact RIS metadata for this document. Read it with ris_get_section or search by its case number before requesting relations.");
      const items: z.infer<typeof RelationSchema>[] = [];

      if (source) {
        // Walk Metadaten for Aenderung / NovellenBeziehung / cited Norm.
        for (const value of Object.values(source.Data.Metadaten)) {
          if (!isRecord(value)) continue;
          for (const inner of Object.values(value)) {
            if (!isRecord(inner)) continue;
            const sub = inner;
            if (wantsType(input, "amended_by")) {
              // Aenderung may be a string, an array, or {item:[…]} — flatten all.
              for (const aenderung of flattenStrings(sub.Aenderung)) {
                items.push({ type: "amended_by", target_id: aenderung, target_label: aenderung });
              }
            }
            if (wantsType(input, "amends")) {
              const organ = typeof sub.NovellenPublikationsorgan === "string" ? sub.NovellenPublikationsorgan : "";
              for (const nr of flattenStrings(sub.NovellenBgblnummer)) {
                items.push({ type: "amends", target_id: nr, target_label: `${organ} ${nr}`.trim() });
              }
            }
            if (typeof sub.Norm === "string" && wantsType(input, "cites_norm")) {
              for (const norm of String(sub.Norm).split(/[,;]/)) {
                const cleaned = norm.trim();
                if (cleaned) items.push({ type: "cites_norm", target_id: cleaned, target_label: cleaned });
              }
            }
          }
        }

        // Case law lists cited norms as Judikatur.Normen = { item: [...] }.
        if (wantsType(input, "cites_norm")) {
          const seen = new Set(items.filter((i) => i.type === "cites_norm").map((i) => i.target_id));
          for (const block of Object.values(source.Data.Metadaten)) {
            if (!isRecord(block)) continue;
            for (const norm of flattenStrings(block.Normen)) {
              if (!seen.has(norm)) {
                seen.add(norm);
                items.push({ type: "cites_norm", target_id: norm, target_label: norm });
              }
            }
          }
        }
      }

      // 2) Find decisions that cite this norm. This is a capped SAMPLE across
      //    tribunals (one page per court), not an exhaustive, fully-paginable
      //    set — so flag when it was truncated instead of implying completeness.
      let citedTruncated = false;
      const failures: string[] = [];
      if (wantsType(input, "cited_by_case")) {
        const caseLawApps = CORPUS_MAP.case_law.apps;
        // Fan out (sequentially, rate-limited inside client).
        for (const caseApp of caseLawApps) {
          if (items.length >= input.limit + input.offset) { citedTruncated = true; break; }
          const p = new Map<string, string>();
          p.set("Applikation", caseApp);
          p.set("Norm", id);
          if (CASE_LAW_APPS.has(caseApp)) {
            p.set("Dokumenttyp.SucheInRechtssaetzen", "True");
            p.set("Dokumenttyp.SucheInEntscheidungstexten", "True");
          }
          p.set("DokumenteProSeite", "Ten");
          p.set("Seitennummer", "1");
          try {
            const { records: caseRecords, hits } = await client.query(controllerForApp(caseApp), p);
            for (const rec of caseRecords) {
              const cit = buildLeanCitation(rec);
              items.push({
                type: "cited_by_case",
                target_id: cit.id,
                target_label: extractTitles(rec).kurztitel,
                target_citation: cit,
              });
            }
            if (hits.total > caseRecords.length) citedTruncated = true;
          } catch {
            failures.push(caseApp);
          }
        }
      }

      const total = items.length;
      const slice = items.slice(input.offset, input.offset + input.limit);
      const has_more = input.offset + slice.length < total;

      return {
        id: input.id,
        total,
        count: slice.length,
        offset: input.offset,
        limit: input.limit,
        has_more,
        next_offset: has_more ? input.offset + slice.length : null,
        refinement_hint: [
          "Relations include only explicitly returned metadata. An empty list is not evidence that no relationships exist. Predecessor/successor links are not reliably exposed; use dated law searches for version history.",
          ...(citedTruncated ? ["cited_by_case is a capped sample. Page ris_search with a specific case-law application and norm for additional results."] : []),
          ...(failures.length ? [`Citing-decision searches failed for: ${failures.join(", ")}. Their records are missing.`] : []),
        ].join(" "),
        items: slice,
      };
    },
  };
}

function wantsType(input: GetRelatedInput, t: z.infer<typeof RelationshipTypeEnum>): boolean {
  return !input.relationship_types || input.relationship_types.includes(t);
}
