// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * ris_get_section — full text of one paragraph/article/anlage (consolidated law)
 * or one Rechtssatz/Entscheidungstext (case law).
 *
 * Resolution strategy by id kind:
 *  - RIS document number (NOR…, JWT_/JWR_/JJT_/JJR_…, LTI…, BGBLA_…): fetch the
 *    body straight from the deterministic content URL (the OGD search API has
 *    no fetch-by-id route); citation fields are parsed from the body header.
 *  - Gesetzesnummer or free text (law abbreviation, Geschäftszahl): resolve the
 *    record via a targeted search, then fetch the canonical content URL.
 *
 * Consolidated law defaults to the version in force today (fassung_vom
 * overrides); when the returned version is not in force on the requested date,
 * a version_note flags it.
 */
import { z } from "zod";
import { requireStateDocumentId } from "../client/state-law.js";
import type { RisClient } from "../client/ris-client.js";
import type { Applikation } from "../types.js";
import { AUTHENTIC_APPS, CASE_LAW_APPS, controllerForApp } from "../types.js";
import { ApplikationEnum, ContentFormatEnum } from "../schemas/enums.js";
import { RisCitationLeanSchema, RisCitationFullSchema } from "../schemas/citation.js";
import { buildLeanCitation, buildFullCitation } from "../client/citation.js";
import { extractDates, extractTitles, normaliseContentUrls } from "../client/normalization.js";
import {
  classifyId, normaliseIdInput, contentUrlFor, dokumentUrlFor,
  fetchDocumentBody, fetchDocumentHtml, convertBody,
  parseDocHeader, todayIso,
  type DocHeader,
} from "../client/content.js";
import { buildGetDocumentTool, GetDocumentInputSchema } from "./get-document.js";
import { RisNotFoundError } from "../infrastructure/errors.js";

export const GetSectionInputSchema = z.object({
  id: z.string().describe("Gesetzesnummer (with section_ref), RIS document number from a search result (NOR…, JWT_…, JJR_…), ELI/RIS URL, Geschäftszahl, or law abbreviation."),
  section_ref: z.string().describe("Paragraph/article/anlage label, e.g. '§ 12', 'Art. 5', 'Anlage 1'. Ignored when id is a document number (those address one section already)."),
  applikation: ApplikationEnum.optional(),
  fassung_vom: z.string().optional(),
  format: ContentFormatEnum.default("markdown"),
  include_neighbours: z.boolean().default(false).describe("Include prev/next section refs."),
  include_full_metadata: z.boolean().default(false),
}).strict();

export const GetSectionOutputSchema = z.object({
  ref: z.string(),
  type: z.string().optional(),
  text: z.string(),
  fassung_vom: z.string().optional(),
  version_note: z.string().optional().describe(
    "Present when the returned text is NOT the version in force on the requested date (expired, future, or law repealed). Surface this to the user.",
  ),
  neighbours: z.object({
    prev: z.string().optional(),
    next: z.string().optional(),
  }).optional(),
  ris_citation: z.union([RisCitationLeanSchema, RisCitationFullSchema]),
});

export type GetSectionInput = z.infer<typeof GetSectionInputSchema>;
export type GetSectionOutput = z.infer<typeof GetSectionOutputSchema>;

const KONS_APPS = new Set<Applikation>(["BrKons", "LrKons"]);

export function buildGetSectionTool(client: RisClient) {
  return {
    description:
      "Returns the full text of one section or decision. id accepts: a federal Gesetzesnummer (combine with section_ref like '§ 12'), a RIS document number from search results (NOR…, LTI…, JWT_/JWR_/JJT_/JJR_… — fetched directly; pass section_ref=''), or a Geschäftszahl / federal law abbreviation (verify the returned header matches). State law (LrKons) requires the exact document ID from a search scoped by bundesland and date; numeric law numbers repeat across states. Consolidated law defaults to the version in force TODAY; pass fassung_vom for a historical snapshot; a version_note flags text not in force on the requested date. format='plain' gives compact readable text; 'markdown' keeps structure; 'text' is one flattened line; 'raw_url' returns just the canonical URL.",
    inputSchema: GetSectionInputSchema,
    outputSchema: GetSectionOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (input: GetSectionInput): Promise<GetSectionOutput> => {
      const app: Applikation = input.applikation ?? "BrKons";
      const id = normaliseIdInput(input.id);
      const kind = classifyId(id);
      requireStateDocumentId(app, id);

      const result = kind === "dokumentnummer"
        ? await fetchByDokumentnummer(client, app, id, input)
        : await fetchViaSearch(client, app, id, kind, input);
      if (input.include_neighbours && KONS_APPS.has(app) && result.ris_citation.gesetzesnummer) {
        const document = await buildGetDocumentTool(client).handler(GetDocumentInputSchema.parse({
          id: app === "LrKons" ? id : result.ris_citation.gesetzesnummer, applikation: app, fassung_vom: input.fassung_vom, include_structure: true,
        }));
        const sections = document.structure ?? [];
        const index = sections.findIndex(section => section.ref.replace(/\s/g, "") === result.ref.replace(/\s/g, ""));
        if (index >= 0) result.neighbours = { prev: sections[index - 1]?.ref, next: sections[index + 1]?.ref };
      }
      return result;
    },
  };
}

// ---- Direct fetch by document number -------------------------------------------

async function fetchByDokumentnummer(
  client: RisClient,
  app: Applikation,
  id: string,
  input: GetSectionInput,
): Promise<GetSectionOutput> {
  const contentUrl = contentUrlFor(app, id);

  if (input.format === "raw_url") {
    return {
      ref: input.section_ref,
      text: contentUrl,
      fassung_vom: input.fassung_vom,
      ris_citation: minimalCitation(app, id, undefined),
    };
  }

  const resp = await fetchDocumentHtml(client, contentUrl);
  if (!resp.ok) {
    throw new RisNotFoundError(
      `Document '${id}' not found under applikation=${app} (HTTP ${resp.status}). ` +
        `Check that the id comes from a ris_search result and that 'applikation' matches the app it was found in.`,
    );
  }

  // Parse citation fields from the header block the document prints.
  const plain = await convertBody(resp.html, "plain", client.signal);
  const header = parseDocHeader(plain);
  const text = input.format === "plain" ? plain : await convertBody(resp.html, input.format === "text" ? "text" : input.format, client.signal);
  const citation = input.include_full_metadata ? { ...minimalCitation(app, id, header), source: "RIS OGD API v2.6", ecli: header.ecli } : minimalCitation(app, id, header);

  return {
    ref: header.artikel_paragraph_anlage ?? input.section_ref,
    type: header.artikel_paragraph_anlage ? inferRefType(header.artikel_paragraph_anlage) : undefined,
    text,
    fassung_vom: input.fassung_vom,
    version_note: versionNoteFromDates(header.inkrafttretensdatum, header.ausserkrafttretensdatum, input.fassung_vom),
    ris_citation: citation,
  };
}

export function minimalCitation(app: Applikation, id: string, header?: DocHeader) {
  const lean = {
    id,
    citation_label: header ? labelFromHeader(app, id, header) : id,
    applikation: app,
    is_authentic: AUTHENTIC_APPS.has(app),
    dokument_url: dokumentUrlFor(app, id),
    retrieved_at: new Date().toISOString(),
    ...(header?.gesetzesnummer ? { gesetzesnummer: header.gesetzesnummer } : {}),
    ...(header?.geschaeftszahl ? { geschaeftszahl: header.geschaeftszahl } : {}),
    ...(header?.entscheidungsdatum ? { entscheidungsdatum: header.entscheidungsdatum } : {}),
    ...(header?.gericht ? { gericht: header.gericht } : {}),
  };
  return lean;
}

function labelFromHeader(app: Applikation, id: string, h: DocHeader): string {
  if (h.geschaeftszahl) {
    const court = h.gericht ?? app;
    const date = h.entscheidungsdatum ? ` ${isoToDe(h.entscheidungsdatum)}` : "";
    return `${court}${date}, ${h.geschaeftszahl}`;
  }
  if (h.kurztitel) {
    const ref = h.artikel_paragraph_anlage ? ` ${h.artikel_paragraph_anlage}` : "";
    return `${h.kurztitel}${ref}`;
  }
  return id;
}

function isoToDe(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : iso;
}

// ---- Resolution via search ------------------------------------------------------

async function fetchViaSearch(
  client: RisClient,
  app: Applikation,
  id: string,
  kind: "gesetzesnummer" | "text",
  input: GetSectionInput,
): Promise<GetSectionOutput> {
  const controller = controllerForApp(app);
  const isKons = KONS_APPS.has(app);

  const baseParams = new Map<string, string>();
  baseParams.set("Applikation", app);
  if (kind === "gesetzesnummer") {
    baseParams.set("Gesetzesnummer", id);
  } else {
    baseParams.set(isKons ? "Titel" : CASE_LAW_APPS.has(app) ? "Geschaeftszahl" : "Suchworte", id);
  }

  const refType = inferRefType(input.section_ref);
  const refNum  = inferRefNumber(input.section_ref);
  if (isKons) {
    // Section restriction exists only on the consolidated-law controllers.
    if (refNum) {
      baseParams.set("Abschnitt.Von", refNum);
      baseParams.set("Abschnitt.Bis", refNum);
    }
    baseParams.set("Abschnitt.Typ", refType);
  }
  if (CASE_LAW_APPS.has(app)) {
    baseParams.set("Dokumenttyp.SucheInRechtssaetzen", "True");
    baseParams.set("Dokumenttyp.SucheInEntscheidungstexten", "True");
  }
  baseParams.set("DokumenteProSeite", "Ten");
  baseParams.set("Seitennummer", "1");

  // Consolidated law: default to the version in force today.
  const defaulted = isKons && !input.fassung_vom;
  const effectiveFassung = input.fassung_vom ?? (isKons ? todayIso() : undefined);

  let records = await queryWithFassung(client, controller, baseParams, isKons ? effectiveFassung : undefined);
  let fallbackNote: string | undefined;

  if (records.length === 0 && defaulted) {
    // Nothing in force today — law may be repealed or not yet in force.
    // Retry undated so the agent still gets the text, with a version_note.
    records = await queryWithFassung(client, controller, baseParams, undefined);
    if (records.length > 0) {
      fallbackNote = `No version of this section is in force on ${effectiveFassung} (law repealed or not yet in force). Returned the version available in RIS — check its Inkrafttretens-/Ausserkrafttretensdatum.`;
    }
  }

  const match = records[0];
  if (!match) {
    throw new RisNotFoundError(
      `No section found for id='${input.id}' section_ref='${input.section_ref}'. ` +
        `Use an id from a ris_search result (ris_citation.id or ris_citation.gesetzesnummer), or search the law by name first: ` +
        `ris_search(corpus=…, title='<name or abbreviation>') — title matches Langtitel, Kurztitel and Abkürzung.`,
    );
  }

  const citation = input.include_full_metadata ? buildFullCitation(match) : buildLeanCitation(match);
  const urls = normaliseContentUrls(match, /* includeRaw */ false);
  let text = "";

  if (input.format === "raw_url") {
    text = urls?.canonical ?? citation.dokument_url;
  } else if (urls?.canonical) {
    const body = await fetchDocumentBody(client, urls.canonical, input.format === "text" ? "text" : input.format);
    text = body.text;
  } else {
    text = extractTitles(match).titel ?? "(no content URL available)";
  }

  // Flag versions that are not in force on the requested date.
  const dates = extractDates(match);
  const note = fallbackNote ?? (isKons
    ? versionNoteFromDates(dates.in_force_from ?? undefined, dates.in_force_to ?? undefined, input.fassung_vom)
    : undefined);

  return {
    ref: input.section_ref,
    type: refType,
    text,
    fassung_vom: input.fassung_vom ?? (defaulted && !fallbackNote ? effectiveFassung : input.fassung_vom),
    version_note: note,
    ris_citation: citation,
  };
}

async function queryWithFassung(
  client: RisClient,
  controller: ReturnType<typeof controllerForApp>,
  baseParams: Map<string, string>,
  fassungVom: string | undefined,
) {
  const params = new Map(baseParams);
  if (fassungVom) params.set("Fassung.FassungVom", fassungVom);
  const { records } = await client.query(controller, params);
  return records;
}

/**
 * A version is flagged when its validity bracket excludes the requested date
 * (explicit fassung_vom, else today).
 */
function versionNoteFromDates(
  inForceFrom: string | undefined,
  inForceTo: string | undefined,
  requestedDate: string | undefined,
): string | undefined {
  const at = requestedDate ?? todayIso();
  if (inForceTo && inForceTo < at) {
    return `This version went OUT OF FORCE on ${inForceTo}. It is not the law in force on ${at}.`;
  }
  if (inForceFrom && inForceFrom > at) {
    return `This version enters into force on ${inForceFrom} — it is not yet in force on ${at}.`;
  }
  return undefined;
}

function inferRefType(ref: string): "Paragraph" | "Artikel" | "Anlage" | "Alle" {
  if (/^anl/i.test(ref)) return "Anlage";
  if (/^art/i.test(ref) || /^a\b/i.test(ref)) return "Artikel";
  if (/^[§p]/i.test(ref) || /^par/i.test(ref)) return "Paragraph";
  return "Alle";
}

function inferRefNumber(ref: string): string | undefined {
  const m = ref.match(/(\d+[a-z]?)/i);
  return m?.[1];
}
