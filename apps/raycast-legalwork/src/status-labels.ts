import type { LauncherCoverage } from "@legalwork/types/launcher";

const german = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).language === "de";

export function label(english: string, deutsch: string) {
  return german ? deutsch : english;
}

export const completedLabel = label("✓ Done", "✓ Erledigt");

export const coverageLabels = {
  complete: label("Complete", "Vollständig"),
  partial: label("Partial results", "Teilergebnisse"),
  "filename-only": label("File names only", "Nur Dateinamen"),
  indexing: label("Indexing, file names only", "Indexierung läuft, bisher nur Dateinamen"),
  searching: label("Searching…", "Suche läuft…"),
  unavailable: label("Unavailable", "Nicht verfügbar"),
  offline: "Offline",
} satisfies Record<LauncherCoverage, string>;
