// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * Zod enums for every closed value list the agent might pass.
 * Keep these comprehensive; agents reference them via list_scopes.
 */
import { z } from "zod";

export const ControllerEnum = z.enum([
  "Bundesrecht", "Landesrecht", "Bezirke", "Gemeinden", "Judikatur",
  "Sonstige", "History", "Version",
]);

export const CorpusEnum = z.enum([
  "federal_law", "state_law", "case_law", "gazettes",
  "drafts_and_bills", "municipal", "official_announcements", "english_translations",
]);

export const ApplikationEnum = z.enum([
  "BrKons", "BgblAuth", "BgblPdf", "BgblAlt", "Begut", "RegV", "Erv",
  "LrKons", "LgblAuth", "Lgbl", "LgblNO", "Vbl",
  "Bvb",
  "Gr", "GrA",
  "Vfgh", "Vwgh", "Justiz", "Bvwg", "Lvwg", "Dsk", "Dok", "Pvak",
  "Gbk", "Verg", "Uvs", "Ubas", "Umse", "Bks", "AsylGH", "Normenliste",
  "PruefGewO", "Avsv", "Spg", "Avn", "KmGer", "Mrp", "Erlaesse", "Upts",
]);

export const BundeslandEnum = z.enum([
  "Burgenland", "Kaernten", "Niederoesterreich", "Oberoesterreich",
  "Salzburg", "Steiermark", "Tirol", "Vorarlberg", "Wien",
]);

export const SincePeriodEnum = z.enum([
  "Undefined", "EinerWoche", "ZweiWochen", "EinemMonat",
  "DreiMonaten", "SechsMonaten", "EinemJahr",
]);

export const DocumentTypeEnum = z.enum(["law", "regulation", "announcement", "other"]);

export const SortDirectionEnum = z.enum(["Ascending", "Descending"]);

export const SortByEnum = z.enum(["relevance", "date_desc", "date_asc", "citation"]);

export const ContentFormatEnum = z.enum(["markdown", "text", "plain", "raw_url"]);

export const ResponseFormatEnum = z.enum(["structured", "markdown"]);

/** Niche per-app enums. */
export const SenatEnum = z.enum(["I", "II", "III"]);

export const DiskriminierungsgrundEnum = z.enum([
  "Geschlecht", "EthnischeZugehoerigkeit", "Religion", "Weltanschauung",
  "Alter", "SexuelleOrientierung", "Mehrfachdiskriminierung",
]);

export const KommissionEnum = z.enum([
  "BundesGleichbehandlungskommission", "Gleichbehandlungskommission",
]);

export const SpgBranchEnum = z.enum(["OSG", "RSG"]);

export const ParteiEnum = z.enum([
  "ÖVP (Österreichische Volkspartei)",
  "SPÖ (Sozialdemokratische Partei Österreichs)",
  "FPÖ (Freiheitliche Partei Österreichs)",
  "NEOS (Das neue Österreich und Liberales Forum)",
  "GRUENE (Die Grünen - Die Grüne Alternative)",
  "KPÖ (Kommunistische Partei Österreichs)",
  "BZÖ (Bündnis für die Zukunft Österreichs)",
  "Team Stronach (Team Stronach für Österreich)",
  "Andere Parteien",
]);

/**
 * EinbringendeStelle / Bundesministerium are very long historical lists.
 * We accept any string; list_scopes returns the canonical current values.
 * (Validating against a frozen enum would reject historical ministry names
 * that still appear on older records.)
 */
