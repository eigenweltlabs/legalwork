// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * Translate the wrapper's typed parameters into upstream RIS query params.
 *
 * Handles:
 *  - Per-app aliasing (Erv English names, Upts GZ vs Geschaeftszahl, GrA typo)
 *  - Multi-select expansion (bundesland → SucheInKaernten=true&...)
 *  - Document-type multi-select → Typ.SucheIn*=true flags
 *  - Spg branching (OSG vs RSG namespaces)
 *  - Case-law Dokumenttyp defaults (both Rechtssaetze and Entscheidungstexten)
 */
import type { Applikation } from "../types.js";
import { CASE_LAW_APPS, STATE_LAW_APPS } from "../types.js";

export interface SearchInput {
  applikation: Applikation;
  query?: string;
  title?: string;
  date_from?: string;
  date_to?: string;
  in_force_on?: string;
  gesetzesnummer?: string;
  kundmachungsorgan?: string;
  geschaeftszahl?: string;
  norm?: string;
  gericht?: string;
  bundesland?: string | string[];
  rechtsgebiet?: string;
  fachgebiet?: string;
  einbringende_stelle?: string;
  entscheidungsart?: string;
  since_period?: string;
  document_type?: ("law" | "regulation" | "announcement" | "other")[];
  sort_by?: "relevance" | "date_desc" | "date_asc" | "citation";
  limit?: number;
  offset?: number;
  filters?: Record<string, unknown>;
}

/** Map document_type enum to upstream Typ.SucheIn* flag names. */
const DOCTYPE_FLAGS: Record<string, string> = {
  law: "Typ.SucheInGesetzen",
  regulation: "Typ.SucheInVerordnungen",
  announcement: "Typ.SucheInKundmachungen",
  other: "Typ.SucheInSonstiges",
};

/**
 * Returns the upstream query-param map for a typed search input.
 * Caller URL-encodes; this function deals only in raw keys and values.
 */
export function buildSearchParams(input: SearchInput): Map<string, string> {
  const p = new Map<string, string>();
  const app = input.applikation;
  p.set("Applikation", app);

  // ---- App-specific aliasing for text-search fields ----
  const isErv = app === "Erv";
  if (input.query !== undefined) {
    p.set(isErv ? "SearchTerms" : "Suchworte", input.query);
  }
  if (input.title !== undefined) {
    p.set(isErv ? "Title" : "Titel", input.title);
  }
  if (input.kundmachungsorgan !== undefined) {
    p.set(isErv ? "Source" : "Kundmachungsorgan", input.kundmachungsorgan);
  }

  // ---- Date ranges. Different apps use different field names ----
  // Federal/state consolidated: no top-level date_from/to — use Fassung.* or Kundmachung.*
  // Gazettes: Kundmachung.Von/.Bis (BgblAuth, LgblAuth) or Kundgemacht.Von/.Bis (BgblPdf, BgblAlt)
  // Case law: EntscheidungsdatumVon / EntscheidungsdatumBis
  // Bvb/GrA: Kundmachungsdatum.Von/.Bis (typo GrA: Kundemachungsdatum)
  // Sonstige various: Kundmachungsdatum.Von/.Bis, Entscheidungsdatum.Von/.Bis
  if (input.date_from || input.date_to) {
    const { from, to } = dateRangeKeys(app);
    if (input.date_from) p.set(from, input.date_from);
    if (input.date_to) p.set(to, input.date_to);
  }

  // ---- in_force_on → Fassung.FassungVom (consolidated only) ----
  if (input.in_force_on) {
    p.set("Fassung.FassungVom", input.in_force_on);
  }

  // ---- Identity / lookup fields ----
  if (input.gesetzesnummer) p.set("Gesetzesnummer", input.gesetzesnummer);

  if (input.geschaeftszahl) {
    // Upts is the one app that uses GZ, not Geschaeftszahl.
    p.set(app === "Upts" ? "GZ" : "Geschaeftszahl", input.geschaeftszahl);
  }

  if (input.norm) p.set("Norm", input.norm);
  if (input.gericht) p.set("Gericht", input.gericht);
  if (input.rechtsgebiet) p.set("Rechtsgebiet", input.rechtsgebiet);
  if (input.fachgebiet) p.set("Fachgebiet", input.fachgebiet);
  if (input.einbringende_stelle) p.set("EinbringendeStelle", input.einbringende_stelle);
  if (input.entscheidungsart) p.set("Entscheidungsart", input.entscheidungsart);

  // ---- Bundesland: array (flag-multi-select) vs single value ----
  if (input.bundesland !== undefined) {
    const values = Array.isArray(input.bundesland) ? input.bundesland : [input.bundesland];
    if (STATE_LAW_APPS.has(app)) {
      // Multi-select boolean flags. The upstream key is namespaced under
      // `Bundesland.` — a bare `SucheInWien` is silently ignored (returns the
      // unfiltered set). Verified against the OGD Landesrecht endpoint:
      // `Bundesland.SucheInWien=true` restricts to LWI; `SucheInWien=true` does not.
      for (const b of values) p.set(`Bundesland.SucheIn${b}`, "true");
    } else {
      // Value-style.
      p.set("Bundesland", values[0]!);
    }
  }

  // ---- document_type multi-select → Typ.SucheIn*=true flags ----
  if (input.document_type && input.document_type.length > 0) {
    for (const t of input.document_type) {
      const flag = DOCTYPE_FLAGS[t];
      if (flag) p.set(flag, "True");
    }
  }

  // ---- Case-law trap: default both Dokumenttyp flags ----
  if (CASE_LAW_APPS.has(app)) {
    p.set("Dokumenttyp.SucheInRechtssaetzen", "True");
    p.set("Dokumenttyp.SucheInEntscheidungstexten", "True");
  }

  // ---- since_period ----
  if (input.since_period && input.since_period !== "Undefined") {
    p.set("ImRisSeit", input.since_period);
  }

  // ---- sort_by → upstream Sortierung.SortDirection + .SortedByColumn ----
  if (input.sort_by) {
    const sort = sortMap(app, input.sort_by);
    if (sort) {
      p.set("Sortierung.SortDirection", sort.direction);
      p.set("Sortierung.SortedByColumn", sort.column);
    }
  }

  // ---- Pagination ----
  const upstreamPageSize = pickUpstreamPageSize(input.limit ?? 20);
  p.set("DokumenteProSeite", upstreamPageSize.label);
  p.set("Seitennummer", String(Math.floor((input.offset ?? 0) / upstreamPageSize.size) + 1));

  // ---- Niche per-app filters (the discriminated union) ----
  if (input.filters) {
    applyFilters(p, app, input.filters);
  }

  return p;
}

/** Apply a niche per-app filter object to the params map. */
function applyFilters(p: Map<string, string>, app: Applikation, filters: Record<string, unknown>): void {
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  };

  switch (app) {
    case "Gbk":
      set("Kommission", filters.kommission);
      set("Senat", filters.senat);
      set("Diskriminierungsgrund", filters.diskriminierungsgrund);
      break;
    case "Dsk":
    case "Dok":
    case "Pvak":
    case "Verg":
      set("EntscheidendeBehoerde", filters.entscheidende_behoerde);
      break;
    case "Bks":
      set("Bereich", filters.bereich);
      break;
    case "Avsv":
      set("Urheber", filters.urheber);
      set("Dokumentart", filters.dokumentart);
      set("Avsvnummer", filters.avsvnummer);
      break;
    case "Spg": {
      const branch = filters.spg_branch;
      const planType = filters.spg_plan_type;
      const land = filters.spg_land;
      if (branch === "OSG" && planType) {
        set("OsgSuchEinschraenkung.SpgStrukturplanType", planType);
      } else if (branch === "RSG") {
        if (planType) set("RsgSuchEinschraenkung.SpgStrukturplanType", planType);
        if (land) set("RsgSuchEinschraenkung.Land", land);
      }
      set("Spgnummer", filters.spgnummer);
      break;
    }
    case "Avn":
      set("Avnnummer", filters.avnnummer);
      break;
    case "Erlaesse":
      set("Bundesministerium", filters.bundesministerium);
      set("Fundstelle", filters.fundstelle);
      set("Abteilung", filters.abteilung);
      break;
    case "Mrp":
      set("Einbringer", filters.einbringer);
      set("Sitzungsnummer", filters.sitzungsnummer);
      set("Gesetzgebungsperiode", filters.gesetzgebungsperiode);
      break;
    case "Upts":
      set("Partei", filters.partei);
      break;
    case "Ubas":
      set("Verfasser", filters.verfasser);
      set("Spruch", filters.spruch);
      set("Index", filters.index);
      break;
    case "Umse":
      set("Kurzbezeichnung", filters.kurzbezeichnung);
      break;
    case "Justiz":
      set("RechtlicheBeurteilung", filters.rechtliche_beurteilung);
      set("Spruch", filters.spruch);
      set("Fundstelle", filters.fundstelle);
      set("Rechtssatznummer", filters.rechtssatznummer);
      break;
    case "GrA":
      set("Bezirk", filters.bezirk);
      set("Gemeinde", filters.gemeinde);
      set("Gemeindeverband", filters.gemeindeverband);
      // GrA upstream typo: Kundemachungsdatum (missing 's')
      set("Kundemachungsnummer", filters.kundmachungsnummer);
      break;
    case "LgblNO":
      set("Gliederungszahl", filters.gliederungszahl);
      break;
    case "PruefGewO":
      set("Typ.Befaehigungspruefungsordnung", filters.typ_befaehigungspruefungsordnung);
      break;
    case "KmGer":
      set("Typ", filters.typ);
      break;
  }
}

function dateRangeKeys(app: Applikation): { from: string; to: string } {
  if (app === "BgblAuth" || app === "LgblAuth" || app === "Lgbl") {
    return { from: "Kundmachung.Von", to: "Kundmachung.Bis" };
  }
  if (app === "BgblPdf" || app === "BgblAlt") {
    return { from: "Kundgemacht.Von", to: "Kundgemacht.Bis" };
  }
  if (CASE_LAW_APPS.has(app)) {
    return { from: "EntscheidungsdatumVon", to: "EntscheidungsdatumBis" };
  }
  if (app === "GrA") {
    // upstream typo: Kundemachungsdatum
    return { from: "Kundemachungsdatum.Von", to: "Kundemachungsdatum.Bis" };
  }
  if (app === "Bvb") {
    return { from: "Kundmachungsdatum.Von", to: "Kundmachungsdatum.Bis" };
  }
  if (app === "Mrp") {
    return { from: "Sitzungsdatum.Von", to: "Sitzungsdatum.Bis" };
  }
  if (app === "Upts") {
    return { from: "Entscheidungsdatum.Von", to: "Entscheidungsdatum.Bis" };
  }
  if (app === "Erlaesse") {
    return { from: "VonInkrafttretensdatum", to: "BisInkrafttretensdatum" };
  }
  if (app === "RegV") {
    return { from: "BeschlussdatumVon", to: "BeschlussdatumBis" };
  }
  // Default for consolidated apps: Fassung.{Von,Bis}Inkrafttretensdatum
  return { from: "Fassung.VonInkrafttretensdatum", to: "Fassung.BisInkrafttretensdatum" };
}

/**
 * Upstream date-sort column, per application.
 *
 * `SortedByColumn` is validated against a per-app enum (`JustizSortableColumn`,
 * `DskSortableColumn`, `BrKonsSortableColumn`, …) — there is no shared value.
 * Case law sorts on "Datum", consolidated law on "Inkrafttretensdatum",
 * gazettes on "Kundmachungsdatum", and a handful of apps use their own column.
 * Sending the wrong one triggers an upstream schema-validation error, so the
 * column must be resolved per app. Values verified against the OGD POST samples.
 */
function dateSortColumn(app: Applikation): string | undefined {
  if (CASE_LAW_APPS.has(app) || app === "Gbk") return "Datum";
  if (app === "BrKons" || app === "LrKons" || app === "Spg" || app === "PruefGewO" || app === "KmGer") {
    return "Inkrafttretensdatum";
  }
  if (app === "LgblNO") return "Ausgabedatum";
  if (app === "Upts") return "Entscheidungsdatum";
  if (app === "Mrp") return "Sitzungsdatum";
  if (app === "RegV") return "Beschlussdatum";
  if (app === "Begut") return "EndeBegutachtungsfrist";
  if (app === "Erlaesse") return "Genehmigungsdatum";
  // Erv / Normenliste / Gr expose no date-sortable column.
  if (app === "Erv" || app === "Normenliste" || app === "Gr") return undefined;
  // Gazette family: BgblAuth, BgblPdf, BgblAlt, LgblAuth, Lgbl, Vbl, Bvb, GrA, Avsv, Avn.
  return "Kundmachungsdatum";
}

/**
 * Map our sort_by enum to the upstream Sortierung pair. Resolves the
 * `SortedByColumn` per application (see `dateSortColumn`). When the app has no
 * column matching the requested sort, returns undefined — the caller then omits
 * Sortierung entirely and the upstream falls back to relevance, which is
 * preferable to a hard schema-validation error.
 */
function sortMap(
  app: Applikation,
  sortBy: NonNullable<SearchInput["sort_by"]>,
): { direction: "Ascending" | "Descending"; column: string } | undefined {
  if (sortBy === "relevance") return undefined;
  if (sortBy === "citation") {
    // Geschaeftszahl is a sortable column only for case-law applications.
    return CASE_LAW_APPS.has(app)
      ? { direction: "Ascending", column: "Geschaeftszahl" }
      : undefined;
  }
  const column = dateSortColumn(app);
  if (!column) return undefined;
  return { direction: sortBy === "date_desc" ? "Descending" : "Ascending", column };
}

/** Pick the smallest upstream DokumenteProSeite value ≥ requested limit. */
export function pickUpstreamPageSize(limit: number): { label: "Ten" | "Twenty" | "Fifty" | "OneHundred"; size: 10 | 20 | 50 | 100 } {
  if (limit <= 10)  return { label: "Ten",        size: 10 };
  if (limit <= 20)  return { label: "Twenty",     size: 20 };
  if (limit <= 50)  return { label: "Fifty",      size: 50 };
  return                   { label: "OneHundred", size: 100 };
}
