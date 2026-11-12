// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * Core types shared across the wrapper.
 */

export type Controller =
  | "Bundesrecht"
  | "Landesrecht"
  | "Bezirke"
  | "Gemeinden"
  | "Judikatur"
  | "Sonstige"
  | "History"
  | "Version";

export type Corpus =
  | "federal_law"
  | "state_law"
  | "case_law"
  | "gazettes"
  | "drafts_and_bills"
  | "municipal"
  | "official_announcements"
  | "english_translations";

export type Applikation =
  // Bundesrecht
  | "BrKons" | "BgblAuth" | "BgblPdf" | "BgblAlt" | "Begut" | "RegV" | "Erv"
  // Landesrecht
  | "LrKons" | "LgblAuth" | "Lgbl" | "LgblNO" | "Vbl"
  // Bezirke
  | "Bvb"
  // Gemeinden
  | "Gr" | "GrA"
  // Judikatur
  | "Vfgh" | "Vwgh" | "Justiz" | "Bvwg" | "Lvwg" | "Dsk" | "Dok" | "Pvak"
  | "Gbk" | "Verg" | "Uvs" | "Ubas" | "Umse" | "Bks" | "AsylGH" | "Normenliste"
  // Sonstige
  | "PruefGewO" | "Avsv" | "Spg" | "Avn" | "KmGer" | "Mrp" | "Erlaesse" | "Upts";

/** Apps that carry legal force (amtssigniert PDFs). */
export const AUTHENTIC_APPS: ReadonlySet<Applikation> = new Set<Applikation>([
  "BgblAuth", "LgblAuth", "Vbl", "Bvb", "GrA",
  "PruefGewO", "Avsv", "Spg", "Avn", "KmGer",
]);

/** Apps where Bundesland is a flag-style multi-select (SucheIn{State}=true). */
export const STATE_LAW_APPS: ReadonlySet<Applikation> = new Set<Applikation>([
  "LrKons", "LgblAuth", "Lgbl", "Vbl",
]);

/** Apps where searching needs Dokumenttyp.SucheInRechtssaetzen + Entscheidungstexten flags. */
export const CASE_LAW_APPS: ReadonlySet<Applikation> = new Set<Applikation>([
  "Vfgh", "Vwgh", "Justiz", "Bvwg", "Lvwg", "Dsk", "Dok", "Pvak",
  "Verg", "Uvs", "Ubas", "Umse", "Bks", "AsylGH",
]);

export type CorpusToApps = {
  [K in Corpus]: { apps: Applikation[] };
};

/** Maps a coarse corpus to the applications that belong in it. */
export const CORPUS_MAP: CorpusToApps = {
  federal_law:            { apps: ["BrKons"] },
  state_law:              { apps: ["LrKons"] },
  gazettes:               { apps: ["BgblAuth", "BgblPdf", "BgblAlt", "LgblAuth", "Lgbl", "LgblNO", "Vbl", "Bvb"] },
  drafts_and_bills:       { apps: ["Begut", "RegV"] },
  english_translations:   { apps: ["Erv"] },
  case_law:               { apps: [...CASE_LAW_APPS, "Gbk", "Normenliste"] },
  municipal:              { apps: ["Gr", "GrA"] },
  official_announcements: { apps: ["PruefGewO", "Avsv", "Spg", "Avn", "KmGer", "Mrp", "Erlaesse", "Upts"] },
};

/**
 * Upstream controller per application. The controller is the URL path segment
 * of the OGD API; sending an app to the wrong controller triggers an upstream
 * schema-validation error (e.g. LgblAuth is a Landesrecht app even though it
 * sits in the cross-jurisdiction "gazettes" corpus).
 */
export const APP_CONTROLLER: Record<Applikation, Controller> = {
  BrKons: "Bundesrecht", BgblAuth: "Bundesrecht", BgblPdf: "Bundesrecht",
  BgblAlt: "Bundesrecht", Begut: "Bundesrecht", RegV: "Bundesrecht", Erv: "Bundesrecht",
  LrKons: "Landesrecht", LgblAuth: "Landesrecht", Lgbl: "Landesrecht",
  LgblNO: "Landesrecht", Vbl: "Landesrecht",
  Bvb: "Bezirke",
  Gr: "Gemeinden", GrA: "Gemeinden",
  Vfgh: "Judikatur", Vwgh: "Judikatur", Justiz: "Judikatur", Bvwg: "Judikatur",
  Lvwg: "Judikatur", Dsk: "Judikatur", Dok: "Judikatur", Pvak: "Judikatur",
  Gbk: "Judikatur", Verg: "Judikatur", Uvs: "Judikatur", Ubas: "Judikatur",
  Umse: "Judikatur", Bks: "Judikatur", AsylGH: "Judikatur", Normenliste: "Judikatur",
  PruefGewO: "Sonstige", Avsv: "Sonstige", Spg: "Sonstige", Avn: "Sonstige",
  KmGer: "Sonstige", Mrp: "Sonstige", Erlaesse: "Sonstige", Upts: "Sonstige",
};

/** Resolve the upstream controller for an application. */
export function controllerForApp(app: Applikation): Controller {
  return APP_CONTROLLER[app];
}

/** Raw upstream response envelope (before normalisation). */
export interface RawOgdResponse {
  OgdSearchResult: {
    "@status"?: "ok" | "error";
    Error?: { Applikation?: Applikation; Message?: string };
    OgdDocumentResults?: {
      Hits: {
        "@pageNumber": string;
        "@pageSize": string;
        "#text": string;
      };
      OgdDocumentReference?: RawDocRef | RawDocRef[];
    };
  };
}

export interface RawDocRef {
  Data: {
    Metadaten: {
      Technisch?: {
        ID?: string;
        Applikation?: Applikation;
        Organ?: string;
        Einbringer?: string;
        ImportTimestamp?: string | { "@xsi:nil"?: "true" };
      };
      Allgemein?: {
        Veroeffentlicht?: string;
        Geaendert?: string;
        DokumentUrl?: string;
      };
      // App-specific blocks live under Bundesrecht / Landesrecht / Judikatur / etc.
      [key: string]: unknown;
    };
    Dokumentliste?: {
      ContentReference?: RawContentRef | RawContentRef[];
    };
    Deleted?: { Reason?: string };
  };
}

export interface RawContentRef {
  ContentType?: string;
  Name?: string;
  Urls?: { ContentUrl?: RawContentUrl | RawContentUrl[] };
}

export interface RawContentUrl {
  DataType?: string;
  Url?: string;
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** History retains legacy application names even though search uses BrKons,
 * LrKons, Gr and GrA. OGD-RIS API manual v2.6, pp. 59–60. */
const HISTORY_NAMES: Partial<Record<Applikation, string>> = {
  BrKons: "Bundesnormen", LrKons: "Landesnormen", Gr: "Gemeinderecht", GrA: "GemeinderechtAuth",
};
export function historyApplication(app: Applikation): string { return HISTORY_NAMES[app] ?? app; }
export function normalizeApplication(value: unknown): unknown {
  for (const [application, legacy] of Object.entries(HISTORY_NAMES)) if (value === legacy) return application;
  return value;
}
