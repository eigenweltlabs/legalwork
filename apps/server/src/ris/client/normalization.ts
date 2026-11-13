import { isRecord } from "../types.js";
// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * Normalise the SOAP-flavoured JSON the RIS REST API returns.
 *
 * - `Hits.#text` → numeric `total`; `@pageNumber`/`@pageSize` → numbers
 * - `OgdDocumentReference` / `ContentReference` / `ContentUrl`: single OR array → always array
 * - `xsi:nil="true"` blobs → null
 * - `@xmlns*` and other `@` attrs stripped (or lifted) per element
 * - `OgdSearchResult.Error` surfaced via translateUpstreamError on the caller side
 */
import type { RawDocRef, RawContentRef, RawContentUrl } from "../types.js";

export interface NormalisedHits {
  total: number;
  pageNumber: number;
  pageSize: number;
}

export function normaliseHits(raw: unknown): NormalisedHits {
  // Upstream shape: { "@pageNumber": "1", "@pageSize": "20", "#text": "16729" }
  const r = isRecord(raw) ? raw : {};
  const total     = toInt(r["#text"]) ?? 0;
  const pageNumber = toInt(r["@pageNumber"]) ?? 1;
  const pageSize   = toInt(r["@pageSize"])  ?? 20;
  return { total, pageNumber, pageSize };
}

/** Always returns an array, even if the upstream returned a single object or undefined. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** True when a value is the SOAP-serialised representation of null. */
export function isXsiNil(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (isRecord(v)) {
    const o = v;
    return o["@xsi:nil"] === "true";
  }
  return false;
}

/**
 * Recursively strip @xmlns* attributes and the bare "$" / "_" wrappers
 * that some XML→JSON libraries introduce. (RIS upstream uses neither, but
 * we keep this defensive in case the wrapper sits behind a proxy that
 * re-serialises.)
 */
export function stripXmlAttrs(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stripXmlAttrs);
  if (isRecord(input)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (k.startsWith("@xmlns")) continue;
      if (k === "@xsi:nil") continue;
      const cleanKey = k.startsWith("@") ? k.slice(1) : k;
      out[cleanKey] = stripXmlAttrs(v);
    }
    return out;
  }
  return input;
}

function toInt(v: unknown): number | undefined {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

// ---- Content-URL canonicalisation -------------------------------------------------

export interface NormalisedContentUrls {
  canonical: string;
  authentic?: string;
  alternates?: Record<string, string>;
}

const DATATYPE_PRIORITY: ReadonlyArray<string> = ["Html", "Pdf", "Xml", "Rtf"];

/**
 * Pick a canonical URL (prefer Html, then Pdf, then Xml, then Rtf), surface
 * `Authentisch` separately if present, and optionally include the full map
 * of all formats keyed by lowercased DataType.
 */
export function normaliseContentUrls(
  doc: RawDocRef,
  includeRaw: boolean,
): NormalisedContentUrls | undefined {
  const refs = asArray(doc.Data.Dokumentliste?.ContentReference);
  // For now we pick the FIRST MainDocument (or first reference if absent).
  const mainRef =
    refs.find((r) => r.ContentType === "MainDocument") ?? refs[0];
  if (!mainRef) return undefined;
  return contentRefToUrls(mainRef, includeRaw);
}

function contentRefToUrls(ref: RawContentRef, includeRaw: boolean): NormalisedContentUrls | undefined {
  const urls = asArray<RawContentUrl>(ref.Urls?.ContentUrl);
  if (urls.length === 0) return undefined;

  const byType = new Map<string, string>();
  for (const u of urls) {
    if (u.DataType && u.Url) byType.set(u.DataType, u.Url);
  }

  const canonical =
    DATATYPE_PRIORITY.map((d) => byType.get(d)).find(Boolean) ?? byType.values().next().value;
  if (!canonical) return undefined;

  const out: NormalisedContentUrls = { canonical };

  const authentic = byType.get("Authentisch");
  if (authentic) out.authentic = authentic;

  if (includeRaw) {
    const alternates: Record<string, string> = {};
    for (const [k, v] of byType) alternates[k.toLowerCase()] = v;
    out.alternates = alternates;
  }
  return out;
}

// ---- Date extraction --------------------------------------------------------------

export function extractDates(doc: RawDocRef): {
  published: string | null;
  modified: string | null;
  in_force_from: string | null;
  in_force_to: string | null;
} {
  const allg = doc.Data.Metadaten.Allgemein ?? {};
  const published = allg.Veroeffentlicht ?? null;
  const modified  = allg.Geaendert ?? null;

  // in_force_* come from the app-specific block (e.g. Bundesrecht.BrKons.Inkrafttretensdatum).
  // Walk one level deep to find Inkrafttretensdatum / Ausserkrafttretensdatum.
  let inForceFrom: string | null = null;
  let inForceTo: string | null = null;

  for (const value of Object.values(doc.Data.Metadaten)) {
    if (isRecord(value)) {
      for (const inner of Object.values(value)) {
        if (isRecord(inner)) {
          const r = inner;
          if (typeof r.Inkrafttretensdatum === "string") inForceFrom = r.Inkrafttretensdatum;
          if (typeof r.Ausserkrafttretensdatum === "string") inForceTo = r.Ausserkrafttretensdatum;
        }
      }
    }
  }
  return { published, modified, in_force_from: inForceFrom, in_force_to: inForceTo };
}

// ---- Title extraction -------------------------------------------------------------

/** Walks the Metadaten block to find the first Kurztitel / Titel. */
export function extractTitles(doc: RawDocRef): { kurztitel?: string; titel?: string } {
  for (const value of Object.values(doc.Data.Metadaten)) {
    if (isRecord(value)) {
      const r = value;
      const out: { kurztitel?: string; titel?: string } = {};
      if (typeof r.Kurztitel === "string") out.kurztitel = r.Kurztitel;
      if (typeof r.Titel === "string") out.titel = r.Titel;
      if (out.kurztitel || out.titel) return out;
    }
  }
  return {};
}
