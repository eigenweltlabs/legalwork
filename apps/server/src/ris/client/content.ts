import { convertHtml } from "../../agent-sandbox/web-convert.js";
import { RisValidationError } from "../infrastructure/errors.js";
import type { RisClient } from "./ris-client.js";
// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * Document-content helpers shared by ris_get_section / ris_get_document:
 *
 *  - id classification (Gesetzesnummer vs RIS document number vs free text)
 *  - deterministic content-URL construction for document numbers
 *    (the OGD search API has no fetch-by-id route and silently ignores a
 *    `Dokumentnummer` query param, but every document is served under
 *    https://ogd.ris.bka.gv.at/Dokumente/<segment>/<nr>/<nr>.html)
 *  - HTML → markdown/plain/text conversion
 *  - header-field parsing from RIS document bodies (Kurztitel, Geschäftszahl,
 *    Entscheidungsdatum, ECLI, In-/Außerkrafttretensdatum, …)
 */
import type { Applikation } from "../types.js";

// ---- id classification -------------------------------------------------------

export type IdKind = "gesetzesnummer" | "dokumentnummer" | "text";

/**
 * Classify a caller-supplied id.
 *  - 4–10 digits → Gesetzesnummer (stable key of a consolidated law)
 *  - RIS document numbers (NOR40260557, LTI12003138, JWT_/JWR_/JJT_/JJR_…,
 *    BGBLA_2024_I_5, LGBLA_TI_…): uppercase prefix + digits/underscores,
 *    no spaces → fetched directly via the content-URL pattern
 *  - anything else (law abbreviations, Geschäftszahlen, free text) → full-text
 */
export function classifyId(id: string): IdKind {
  if (/^\d{4,10}$/.test(id)) return "gesetzesnummer";
  if (/^[A-Z]{2,8}[A-Z0-9_]*\d[A-Z0-9_]*$/.test(id) && id.length >= 6) return "dokumentnummer";
  return "text";
}

/**
 * Normalise an id input: for URLs (ELI or Dokument.wxe links) extract the
 * trailing document number where present, otherwise return the input as-is.
 */
export function normaliseIdInput(id: string): string {
  const trimmed = id.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new RisValidationError("Invalid RIS source URL."); }
  if (url.protocol !== "https:" || !["www.ris.bka.gv.at", "ris.bka.gv.at", "ogd.ris.bka.gv.at"].includes(url.hostname) || url.username || url.password || url.port)
    throw new RisValidationError("Only official HTTPS RIS source URLs are supported.");
  for (const [key, value] of url.searchParams) if (/^(Dokumentnummer|Gesetzesnummer)$/i.test(key) && classifyId(value) !== "text") return value;
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = decodeURIComponent(segments[i]).replace(/\.(html|xml|pdf|rtf)$/i, "");
    if (classifyId(segment) === "dokumentnummer") return segment;
  }
  throw new RisValidationError("This RIS URL has no document number. Search for the law or decision first.");
}

/** URL path segment under /Dokumente/ per application. */
function contentSegment(app: Applikation): string {
  if (app === "BrKons") return "Bundesnormen";
  if (app === "LrKons") return "Landesnormen";
  return app;
}

/** Deterministic HTML content URL for a document number. */
export function contentUrlFor(app: Applikation, dokumentnummer: string): string {
  const seg = contentSegment(app);
  return `https://ogd.ris.bka.gv.at/Dokumente/${seg}/${encodeURIComponent(dokumentnummer)}/${encodeURIComponent(dokumentnummer)}.html`;
}

/** Human-facing RIS document page for a document number. */
export function dokumentUrlFor(app: Applikation, dokumentnummer: string): string {
  return `https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=${app}&Dokumentnummer=${encodeURIComponent(dokumentnummer)}`;
}

// ---- HTML conversion ----------------------------------------------------------

/**
 * Strip RIS screen-reader duplicates. The HTML wraps every legal citation in
 * a pair of spans — `<span aria-hidden="true">§ 1</span>` for the visible
 * abbreviated form, `<span class="sr-only">Paragraph eins,</span>` for the
 * accessibility expansion. Removing the latter halves bodies on case-law text
 * and gives clean readable output.
 */
function stripScreenReaderSpans(html: string): string {
  return html.replace(/<span[^>]*class="[^"]*\bsr-only\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "");
}

export type BodyFormat = "markdown" | "text" | "plain";

/** Reuse LegalWork's bounded HTML parser in an isolated worker. */
export async function convertBody(html: string, format: BodyFormat, signal: AbortSignal): Promise<string> {
  const clean = stripScreenReaderSpans(html).replace(/<head[\s\S]*?<\/head>/gi, "");
  const converted = await convertHtml(clean, format === "markdown" ? "markdown" : "text", signal);
  return format === "text" ? converted.replace(/\s+/g, " ").trim() : converted;
}

export async function fetchDocumentHtml(client: RisClient, url: string) {
  return client.fetchHtml(url);
}

export async function fetchDocumentBody(client: RisClient, url: string, format: BodyFormat) {
  const response = await client.fetchHtml(url);
  return { ...response, text: await convertBody(response.html, format, client.signal) };
}

// ---- Header parsing -----------------------------------------------------------

export interface DocHeader {
  bundesland?: string;
  kurztitel?: string;
  abkuerzung?: string;
  gesetzesnummer?: string;
  geschaeftszahl?: string;
  entscheidungsdatum?: string; // ISO
  gericht?: string;
  ecli?: string;
  inkrafttretensdatum?: string;  // ISO
  ausserkrafttretensdatum?: string; // ISO
  artikel_paragraph_anlage?: string;
}

const HEADER_LABELS: Record<string, keyof DocHeader> = {
  "Bundesland": "bundesland",
  "Kurztitel": "kurztitel",
  "Abkürzung": "abkuerzung",
  "Gesetzesnummer": "gesetzesnummer",
  "Geschäftszahl": "geschaeftszahl",
  "Entscheidungsdatum": "entscheidungsdatum",
  "Gericht": "gericht",
  "European Case Law Identifier": "ecli",
  "Inkrafttretensdatum": "inkrafttretensdatum",
  "Außerkrafttretensdatum": "ausserkrafttretensdatum",
  "§/Artikel/Anlage": "artikel_paragraph_anlage",
};

const DATE_FIELDS = new Set<keyof DocHeader>([
  "entscheidungsdatum", "inkrafttretensdatum", "ausserkrafttretensdatum",
]);

/** Convert a German dd.mm.yyyy date to ISO; pass ISO through unchanged. */
export function deDateToIso(v: string): string {
  // Accept non-zero-padded day/month (e.g. "1.5.1959") and pad to ISO.
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v.trim());
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return v.trim();
}

/**
 * Parse the label/value header block RIS prints at the top of every document
 * body (plain-converted). Stops caring once the "Text" label is reached.
 */
export function parseDocHeader(plainText: string): DocHeader {
  const out: DocHeader = {};
  const lines = plainText.split("\n").map((l) => l.trim());
  // RIS prints the stable law number in the footer, after the legal text.
  const lawNumberLabel = lines.lastIndexOf("Gesetzesnummer");
  const footerNumber = lines.slice(lawNumberLabel + 1).find(line => line.length > 0);
  if (lawNumberLabel >= 0 && footerNumber && /^\d{4,10}$/.test(footerNumber)) out.gesetzesnummer = footerNumber;
  const end = lines.findIndex((l) => l === "Text");
  const scope = end === -1 ? lines.slice(0, 80) : lines.slice(0, end + 1);
  for (let i = 0; i < scope.length - 1; i++) {
    const key = HEADER_LABELS[scope[i]!];
    if (!key || out[key]) continue;
    // The value is usually the next line, but block-level tags can emit a blank
    // line between label and value — scan forward to the next non-empty line.
    let value: string | undefined;
    for (let j = i + 1; j < scope.length && j <= i + 3; j++) {
      const cand = scope[j]!;
      if (!cand) continue;               // skip blank lines between label and value
      if (cand in HEADER_LABELS) break;  // hit the next label → this one has no value
      value = cand;
      break;
    }
    if (!value) continue;
    out[key] = DATE_FIELDS.has(key) ? deDateToIso(value) : value;
  }
  return out;
}

/** Today's date (UTC) as YYYY-MM-DD. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
