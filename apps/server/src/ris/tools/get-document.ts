import { isRecord } from "../types.js";
// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * ris_get_document — full metadata for one record by id (Gesetzesnummer,
 * RIS document number, URL, or free text).
 *
 * The RIS REST API has no fetch-by-ID route (a `Dokumentnummer` query param is
 * silently ignored upstream), so:
 *  - Gesetzesnummer / free text resolve via a targeted search;
 *  - document numbers resolve via search only where the full-text index
 *    contains them (consolidated law), otherwise from the deterministic
 *    content URL, with citation fields parsed from the document header. A
 *    non-matching first hit is never silently returned.
 */
import { z } from "zod";
import { requireStateDocumentId, stateSearchFlag } from "../client/state-law.js";
import type { RisClient } from "../client/ris-client.js";
import { AUTHENTIC_APPS, CASE_LAW_APPS, controllerForApp, type Applikation, type RawDocRef } from "../types.js";
import { ApplikationEnum } from "../schemas/enums.js";
import { ContentUrlsSchema, DatesSummarySchema } from "../schemas/shared.js";
import { RisCitationFullSchema, RisCitationLeanSchema } from "../schemas/citation.js";
import { buildLeanCitation, buildFullCitation, findMetaFields } from "../client/citation.js";
import { extractDates, extractTitles, normaliseContentUrls } from "../client/normalization.js";
import {
  classifyId, normaliseIdInput, contentUrlFor, dokumentUrlFor,
  fetchDocumentHtml, convertBody, parseDocHeader, todayIso,
} from "../client/content.js";
import { RisNotFoundError, RisValidationError } from "../infrastructure/errors.js";

export const GetDocumentInputSchema = z.object({
  id: z.string().describe("Gesetzesnummer (whole law), RIS document number (e.g. NOR40191806, JWT_…), ELI/RIS URL, or free text (first match)."),
  applikation: ApplikationEnum.optional().describe("Required when 'id' is not a Gesetzesnummer; picks the app/controller the id lives in."),
  fassung_vom: z.string().optional().describe("YYYY-MM-DD — snapshot for consolidated law. Defaults to today."),
  include_structure: z.boolean().default(false).describe("Include the consolidated-law TOC (one entry per section; capped at 800 — see structure_truncated)."),
  include_full_metadata: z.boolean().default(false).describe("Include all Metadaten fields."),
  include_raw_content_urls: z.boolean().default(false),
}).strict();

const StructureItemSchema = z.object({
  ref: z.string(),
  type: z.string(),
  title: z.string().optional(),
  in_force_from: z.string().nullable(),
  in_force_to: z.string().nullable(),
});

export const GetDocumentOutputSchema = z.object({
  kurztitel: z.string().optional(),
  titel: z.string().optional(),
  type: z.string().optional(),
  dates: DatesSummarySchema,
  content_urls: ContentUrlsSchema,
  ris_citation: z.union([RisCitationLeanSchema, RisCitationFullSchema]),
  structure: z.array(StructureItemSchema).optional(),
  structure_truncated: z.boolean().optional(),
  structure_note: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Full Metadaten block when include_full_metadata=true."),
});

export type GetDocumentInput = z.infer<typeof GetDocumentInputSchema>;
export type GetDocumentOutput = z.infer<typeof GetDocumentOutputSchema>;

const KONS_APPS = new Set<Applikation>(["BrKons", "LrKons"]);
const STRUCTURE_CAP = 800; // 8 upstream pages of 100

export function buildGetDocumentTool(client: RisClient) {
  return {
    description:
      "Fetch metadata for one RIS document. id: federal Gesetzesnummer (whole law), RIS document number from a search result (NOR…, LTI…, JWT_…, BGBLA_…), or federal law name (first match). State law (LrKons) requires the exact document ID from a search scoped by bundesland; numeric law numbers repeat across states. include_structure=true returns the section list (TOC) of a consolidated law, capped at 800 entries and scoped to the document's state. fassung_vom snapshots consolidated law (defaults to today).",
    inputSchema: GetDocumentInputSchema,
    outputSchema: GetDocumentOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (input: GetDocumentInput): Promise<GetDocumentOutput> => {
      const id = normaliseIdInput(input.id);
      const kind = classifyId(id);
      if (!input.applikation && kind !== "gesetzesnummer") {
        throw new RisValidationError("applikation is required unless 'id' is a numeric Gesetzesnummer.");
      }
      const app: Applikation = input.applikation ?? "BrKons";
      requireStateDocumentId(app, id);

      let out: GetDocumentOutput;
      let bundesland: string | undefined;
      let gesetzesnummer: string | undefined = kind === "gesetzesnummer" ? id : undefined;

      if (kind === "dokumentnummer") {
        // Consolidated-law full text indexes its document numbers, so a
        // Suchworte lookup with exact-ID verification works there; for case
        // law and gazettes the header of the content document is the source.
        const viaSearch = KONS_APPS.has(app) ? await lookupByExactId(client, app, id, input) : undefined;
        const resolved = viaSearch ?? (await buildFromContentUrl(client, app, id));
        out = resolved.document;
        bundesland = resolved.bundesland;
        gesetzesnummer ??= out.ris_citation.gesetzesnummer;
      } else {
        const match = await lookupBySearch(client, app, id, kind, input);
        const titles = extractTitles(match);
        const citation = input.include_full_metadata ? buildFullCitation(match) : buildLeanCitation(match);
        out = {
          kurztitel: titles.kurztitel,
          titel: titles.titel,
          type: extractType(match),
          dates: extractDates(match),
          content_urls: normaliseContentUrls(match, input.include_raw_content_urls) ?? { canonical: citation.dokument_url },
          ris_citation: citation,
        };
        if (input.include_full_metadata) {
          out.metadata = match.Data.Metadaten;
        }
        gesetzesnummer ??= citation.gesetzesnummer ?? buildFullCitation(match).gesetzesnummer;
      }

      if (input.include_structure) {
        if (app === "LrKons" && !bundesland) {
          out.structure = [];
          out.structure_note = "Structure unavailable: RIS did not identify this document's Bundesland. Use ris_search with bundesland and gesetzesnummer to list its sections.";
        } else if (KONS_APPS.has(app) && gesetzesnummer) {
          const structure = await fetchStructure(client, app, gesetzesnummer, input.fassung_vom ?? todayIso(), bundesland);
          out.structure = structure.items;
          if (structure.truncated) {
            out.structure_truncated = true;
            out.structure_note = `Law has ${structure.total} section records; structure capped at ${STRUCTURE_CAP}. Page ris_search(gesetzesnummer=${gesetzesnummer}) for the rest.`;
          }
          if (structure.items.length === 0) {
            out.structure_note = `No sections in force on ${input.fassung_vom ?? todayIso()} — the law may be repealed; pass a historical fassung_vom for its former structure.`;
          }
        } else {
          out.structure = [];
          out.structure_note = KONS_APPS.has(app)
            ? "Structure unavailable: could not resolve a Gesetzesnummer for this id — pass the Gesetzesnummer as id."
            : "Structure is only available for consolidated law (BrKons/LrKons).";
        }
      }
      return out;
    },
  };
}

// ---- Lookup paths ---------------------------------------------------------------

/** Suchworte lookup that only accepts an exact Technisch.ID match. */
async function lookupByExactId(
  client: RisClient,
  app: Applikation,
  id: string,
  input: GetDocumentInput,
): Promise<{ document: GetDocumentOutput; bundesland?: string } | undefined> {
  const params = new Map<string, string>();
  params.set("Applikation", app);
  params.set("Suchworte", id);
  params.set("DokumenteProSeite", "Ten");
  params.set("Seitennummer", "1");
  const { records } = await client.query(controllerForApp(app), params);
  const match = records.find((r) => r.Data.Metadaten.Technisch?.ID === id);
  if (!match) return undefined;

  const titles = extractTitles(match);
  const citation = input.include_full_metadata ? buildFullCitation(match) : buildLeanCitation(match);
  const out: GetDocumentOutput = {
    kurztitel: titles.kurztitel,
    titel: titles.titel,
    type: extractType(match),
    dates: extractDates(match),
    content_urls: normaliseContentUrls(match, input.include_raw_content_urls) ?? { canonical: citation.dokument_url },
    ris_citation: citation,
  };
  if (input.include_full_metadata) out.metadata = match.Data.Metadaten;
  return { document: out, bundesland: findMetaFields(match, ["Bundesland"]).Bundesland?.[0] };
}

/** Build the response from the deterministic content URL + parsed header. */
async function buildFromContentUrl(client: RisClient, app: Applikation, id: string): Promise<{ document: GetDocumentOutput; bundesland?: string }> {
  const contentUrl = contentUrlFor(app, id);
  const resp = await fetchDocumentHtml(client, contentUrl);
  if (!resp.ok) {
    throw new RisNotFoundError(
      `Document '${id}' not found under applikation=${app} (HTTP ${resp.status}). ` +
        `Check that the id comes from a ris_search result and that 'applikation' matches.`,
    );
  }
  const header = parseDocHeader(await convertBody(resp.html, "plain", client.signal));
  const isCaseLaw = CASE_LAW_APPS.has(app);
  const document: GetDocumentOutput = {
    kurztitel: header.kurztitel,
    dates: {
      published: null,
      modified: null,
      in_force_from: header.inkrafttretensdatum ?? null,
      in_force_to: header.ausserkrafttretensdatum ?? null,
    },
    content_urls: { canonical: contentUrl },
    ris_citation: {
      id,
      citation_label: header.geschaeftszahl
        ? `${header.gericht ?? app} ${header.entscheidungsdatum ?? ""}, ${header.geschaeftszahl}`.replace(/\s+/g, " ").trim()
        : `${header.kurztitel ?? id}${header.artikel_paragraph_anlage ? ` ${header.artikel_paragraph_anlage}` : ""}`,
      applikation: app,
      is_authentic: AUTHENTIC_APPS.has(app),
      dokument_url: dokumentUrlFor(app, id),
      retrieved_at: new Date().toISOString(),
      ...(header.gesetzesnummer ? { gesetzesnummer: header.gesetzesnummer } : {}),
      ...(isCaseLaw && header.geschaeftszahl ? { geschaeftszahl: header.geschaeftszahl } : {}),
      ...(isCaseLaw && header.entscheidungsdatum ? { entscheidungsdatum: header.entscheidungsdatum } : {}),
      ...(isCaseLaw && header.gericht ? { gericht: header.gericht } : {}),
    },
  };
  return { document, bundesland: header.bundesland };
}

/** Gesetzesnummer / free-text lookup (first match), with today-default Fassung for consolidated law. */
async function lookupBySearch(
  client: RisClient,
  app: Applikation,
  id: string,
  kind: "gesetzesnummer" | "text",
  input: GetDocumentInput,
): Promise<RawDocRef> {
  const isKons = KONS_APPS.has(app);
  const baseParams = new Map<string, string>();
  baseParams.set("Applikation", app);
  if (kind === "gesetzesnummer") baseParams.set("Gesetzesnummer", id);
  else baseParams.set(isKons ? "Titel" : CASE_LAW_APPS.has(app) ? "Geschaeftszahl" : "Suchworte", id);
  if (CASE_LAW_APPS.has(app)) {
    baseParams.set("Dokumenttyp.SucheInRechtssaetzen", "True");
    baseParams.set("Dokumenttyp.SucheInEntscheidungstexten", "True");
  }
  baseParams.set("DokumenteProSeite", "Ten");
  baseParams.set("Seitennummer", "1");

  const fassung = input.fassung_vom ?? (isKons ? todayIso() : undefined);
  if (isKons && fassung) {
    const dated = new Map(baseParams);
    dated.set("Fassung.FassungVom", fassung);
    const { records } = await client.query(controllerForApp(app), dated);
    if (records[0]) return records[0];
    throw new RisNotFoundError(`No version is in force on ${fassung}. Use ris_verify to check validity, or pass a historical fassung_vom.`);
  }
  const { records } = await client.query(controllerForApp(app), baseParams);
  if (!records[0]) {
    throw new RisNotFoundError(
      `No RIS record found for id='${id}' in applikation=${app}. ` +
        `Search first: ris_search(corpus=…, title='<name or abbreviation>').`,
    );
  }
  return records[0];
}

// ---- Structure (TOC) --------------------------------------------------------------

function extractType(doc: RawDocRef): string | undefined {
  for (const value of Object.values(doc?.Data?.Metadaten ?? {})) {
    if (!isRecord(value)) continue;
    const block = value;
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

/**
 * Build the TOC of a consolidated law: RIS stores one record per section, so
 * paging the Gesetzesnummer search (at the requested Fassung) IS the structure.
 */
async function fetchStructure(
  client: RisClient,
  app: Applikation,
  gesetzesnummer: string,
  fassungVom: string,
  bundesland?: string,
): Promise<{ items: z.infer<typeof StructureItemSchema>[]; truncated: boolean; total: number }> {
  const items: z.infer<typeof StructureItemSchema>[] = [];
  let total = 0;

  for (let page = 1; page <= STRUCTURE_CAP / 100; page++) {
    const params = new Map<string, string>();
    params.set("Applikation", app);
    params.set("Gesetzesnummer", gesetzesnummer);
    if (bundesland) params.set(stateSearchFlag(bundesland), "true");
    params.set("Fassung.FassungVom", fassungVom);
    params.set("DokumenteProSeite", "OneHundred");
    params.set("Seitennummer", String(page));

    const { hits, records } = await client.query(controllerForApp(app), params);
    total = hits.total;
    for (const rec of records) {
      const ref = findMetaFields(rec, ["ArtikelParagraphAnlage"]).ArtikelParagraphAnlage?.[0] ?? "";
      const dates = extractDates(rec);
      items.push({
        ref,
        type: refTypeOf(ref),
        in_force_from: dates.in_force_from,
        in_force_to: dates.in_force_to,
      });
    }
    if (page * 100 >= total || records.length === 0) break;
  }
  return { items, truncated: total > STRUCTURE_CAP, total };
}

function refTypeOf(ref: string): string {
  if (/^anl/i.test(ref)) return "Anlage";
  if (/^art/i.test(ref)) return "Artikel";
  if (/^§/.test(ref) || /^par/i.test(ref)) return "Paragraph";
  return "Sonstige";
}
