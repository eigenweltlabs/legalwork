import { isRecord } from "../types.js";
// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * Build ris_citation objects from a normalised RIS record.
 * Lean by default; full form gated by include_full_metadata.
 *
 * Judikatur metadata nests multi-values as `{ item: string | string[] }`
 * (e.g. Geschaeftszahl, Normen) and keeps Entscheidungsdatum / Dokumenttyp at
 * the block level — the walkers below handle both shapes so case-law
 * citations carry Geschäftszahl, date, and court.
 */
import type { RawDocRef, Applikation } from "../types.js";
import { AUTHENTIC_APPS, CASE_LAW_APPS } from "../types.js";
import type { RisCitationLean, RisCitationFull } from "../schemas/citation.js";
import { extractTitles } from "./normalization.js";
import { dokumentUrlFor } from "./content.js";

/** Flatten a string / string[] / {item: …} value into a string array. */
export function flattenStrings(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(flattenStrings);
  if (isRecord(v)) {
    const o = v;
    if ("item" in o) return flattenStrings(o.item);
    return [];
  }
  return [];
}

/**
 * Collect the values of the wanted keys from the Metadaten tree, checking
 * both block level (Metadaten.Judikatur.Entscheidungsdatum) and one level
 * deeper (Metadaten.Judikatur.Vwgh.Gericht). First non-empty hit per key wins.
 */
export function findMetaFields(doc: RawDocRef, keys: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const wanted = new Set(keys);
  const visit = (obj: Record<string, unknown>) => {
    for (const key of wanted) {
      if (out[key]?.length) continue;
      const values = flattenStrings(obj[key]);
      if (values.length) out[key] = values;
    }
  };
  for (const block of Object.values(doc.Data.Metadaten)) {
    if (!isRecord(block)) continue;
    visit(block);
    for (const inner of Object.values(block)) {
      if (!isRecord(inner)) continue;
      visit(inner);
    }
  }
  return out;
}

/** "Verwaltungsgerichtshof (VwGH)" → "VwGH"; otherwise the value unchanged. */
function shortCourt(gericht: string): string {
  const m = /\(([^)]+)\)\s*$/.exec(gericht);
  return m ? m[1]! : gericht;
}

/** ISO date → German d.m.yyyy for citation labels. Accepts a trailing time
 *  component (e.g. "2025-12-16T00:00:00") and uses only the date portion. */
function isoToDeDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : iso;
}

/** Build the lean citation. */
export function buildLeanCitation(doc: RawDocRef): RisCitationLean {
  const t = doc.Data.Metadaten.Technisch ?? {};
  const a = doc.Data.Metadaten.Allgemein ?? {};
  const app = t.Applikation ?? "BrKons";

  const lean: RisCitationLean = {
    id: t.ID ?? "",
    citation_label: "",
    applikation: app,
    is_authentic: AUTHENTIC_APPS.has(app),
    // The output schema requires a valid URL. When the record carries no
    // DokumentUrl (e.g. deleted-record history entries), fall back to the
    // deterministic Dokument.wxe page instead of "" — an empty string fails
    // z.string().url() and would turn the whole tool response into an isError.
    dokument_url: a.DokumentUrl || dokumentUrlFor(app, t.ID ?? ""),
    retrieved_at: new Date().toISOString(),
  };

  if (CASE_LAW_APPS.has(app)) {
    const f = findMetaFields(doc, ["Geschaeftszahl", "Entscheidungsdatum", "Gericht", "Dokumenttyp"]);
    if (f.Geschaeftszahl?.length) lean.geschaeftszahl = f.Geschaeftszahl.join(", ");
    if (f.Entscheidungsdatum?.[0]) lean.entscheidungsdatum = f.Entscheidungsdatum[0];
    if (f.Gericht?.[0]) lean.gericht = f.Gericht[0];
    lean.citation_label = buildCaseLawLabel(lean, f.Dokumenttyp?.[0]) ?? buildGenericLabel(doc);
  } else {
    if (app === "BrKons" || app === "LrKons") {
      const f = findMetaFields(doc, ["Gesetzesnummer"]);
      if (f.Gesetzesnummer?.[0]) lean.gesetzesnummer = f.Gesetzesnummer[0];
    }
    lean.citation_label = buildGenericLabel(doc);
  }
  return lean;
}

/** "VwGH 16.12.2025, Ra 2024/07/0205 (Rechtssatz)" — undefined when GZ is missing. */
function buildCaseLawLabel(lean: RisCitationLean, dokumenttyp?: string): string | undefined {
  if (!lean.geschaeftszahl) return undefined;
  const court = lean.gericht ? shortCourt(lean.gericht) : lean.applikation;
  const date = lean.entscheidungsdatum ? ` ${isoToDeDate(lean.entscheidungsdatum)}` : "";
  const typ = dokumenttyp === "Rechtssatz" ? " (Rechtssatz)" : "";
  return `${court}${date}, ${lean.geschaeftszahl}${typ}`;
}

/** Build the full citation with discriminating identifiers. */
export function buildFullCitation(doc: RawDocRef): RisCitationFull {
  const full: RisCitationFull = { ...buildLeanCitation(doc), source: "RIS OGD API v2.6" };

  // Walk the per-app block to extract discriminating fields.
  for (const value of Object.values(doc.Data.Metadaten)) {
    if (!isRecord(value)) continue;
    const block = value;

    // Consolidated law top-level fields appear on Bundesrecht / Landesrecht
    // blocks. Use first-non-empty-wins (??=) throughout so a later block never
    // clobbers an earlier good value.
    pickStr(block, "Eli",                              (v) => (full.eli ??= v));
    pickStr(block, "GesamteRechtsvorschriftUrl",       (v) => (full.gesamte_rechtsvorschrift_url ??= v));
    pickStr(block, "Gesetzesnummer",                   (v) => (full.gesetzesnummer ??= v));
    pickStr(block, "EuropeanCaseLawIdentifier",        (v) => (full.ecli ??= v));

    // Sub-blocks per app.
    for (const inner of Object.values(block)) {
      if (!isRecord(inner)) continue;
      const sub = inner;
      pickStr(sub, "Eli",                                (v) => (full.eli ??= v));
      pickStr(sub, "GesamteRechtsvorschriftUrl",         (v) => (full.gesamte_rechtsvorschrift_url ??= v));
      pickStr(sub, "Gesetzesnummer",                     (v) => (full.gesetzesnummer ??= v));
      pickStr(sub, "Kundmachungsorgan",                  (v) => (full.kundmachungsorgan ??= v));
      pickStr(sub, "Inkrafttretensdatum",                (v) => (full.fassung_vom ??= v));
      pickStr(sub, "Bgblnummer",                         (v) => (full.bgblnummer ??= v));
      pickStr(sub, "Lgblnummer",                         (v) => (full.lgblnummer ??= v));
      pickStr(sub, "Ausgabedatum",                       (v) => (full.kundmachungsdatum ??= v));
      pickStr(sub, "Kundmachungsdatum",                  (v) => (full.kundmachungsdatum ??= v));
      pickStr(sub, "Teil",                               (v) => (full.teil ??= v));
      pickStr(sub, "Entscheidungsdatum",                 (v) => (full.entscheidungsdatum ??= v));
      pickStr(sub, "Gericht",                            (v) => (full.gericht ??= v));
      pickStr(sub, "Sammlungsnummer",                    (v) => (full.sammlungsnummer ??= v));
      pickStr(sub, "Rechtsgebiet",                       (v) => (full.rechtsgebiet ??= v));
      pickStr(sub, "EuropeanCaseLawIdentifier",          (v) => (full.ecli ??= v));
    }
  }
  return full;
}

/** Label like "Wasserrechtsgesetz 1959 (BGBl. Nr. 215/1959 § 0)" for non-case-law records. */
function buildGenericLabel(doc: RawDocRef): string {
  const t = extractTitles(doc);
  const title = t.kurztitel ?? t.titel ?? doc.Data.Metadaten.Technisch?.ID ?? "(untitled)";

  // Find a discriminator: gazettes use Bgbl/Lgbl-nummer; consolidated uses
  // Kundmachungsorgan + Artikel/Paragraph; case law is handled separately.
  let suffix = "";
  for (const value of Object.values(doc.Data.Metadaten)) {
    if (!isRecord(value)) continue;
    for (const inner of Object.values(value)) {
      if (!isRecord(inner)) continue;
      const sub = inner;
      if (typeof sub.Geschaeftszahl === "string") {
        suffix = sub.Geschaeftszahl;
        break;
      }
      if (typeof sub.Bgblnummer === "string") {
        suffix = sub.Bgblnummer;
        break;
      }
      if (typeof sub.Lgblnummer === "string") {
        suffix = sub.Lgblnummer;
        break;
      }
      if (typeof sub.Kundmachungsorgan === "string") {
        const para = typeof sub.ArtikelParagraphAnlage === "string" ? sub.ArtikelParagraphAnlage : "";
        suffix = para ? `${sub.Kundmachungsorgan} ${para}` : sub.Kundmachungsorgan;
        break;
      }
    }
    if (suffix) break;
  }
  return suffix ? `${title} (${suffix})` : title;
}

function pickStr(obj: Record<string, unknown>, key: string, set: (v: string) => void): void {
  const v = obj[key];
  if (typeof v === "string" && v.trim() !== "") set(v);
}
