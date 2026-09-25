import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { runtimeStorageDir } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import { ReviewLibraryEntrySchema, SaveReviewLibrarySchema, type ReviewColumn, type ReviewLibraryEntry } from "./schema.js";
import { atomicJson, missing, readJson, serialized } from "./storage.js";

type Starter = { id: string; kind: ReviewColumn["kind"]; tags: string[]; en: [string, string, string[]?]; de: [string, string, string[]?] };
const STARTERS: Starter[] = [
  { id: "parties", kind: "text", tags: ["general", "nda", "lease"], en: ["Parties", "Identify the legal names of all contracting parties."], de: ["Vertragsparteien", "Nenne die vollständigen Namen aller Vertragsparteien."] },
  { id: "governing-law", kind: "text", tags: ["general", "nda"], en: ["Governing law", "Which law governs this agreement? Include any exceptions."], de: ["Anwendbares Recht", "Welches Recht gilt für diesen Vertrag? Berücksichtige Ausnahmen."] },
  { id: "assignment", kind: "yes_no", tags: ["general", "nda"], en: ["Assignment without consent", "Does the contract expressly permit assignment without the other party's consent? Assess exceptions and schedules together with the main clause."], de: ["Abtretung ohne Zustimmung", "Erlaubt der Vertrag ausdrücklich eine Abtretung ohne Zustimmung der anderen Partei? Prüfe Ausnahmen und Anlagen zusammen mit der Hauptklausel."] },
  { id: "confidentiality", kind: "classification", tags: ["nda"], en: ["Confidentiality", "How are the confidentiality obligations allocated between the parties?", ["Mutual", "One-way", "Not addressed", "Unclear"]], de: ["Vertraulichkeit", "Wie sind die Geheimhaltungspflichten zwischen den Parteien verteilt?", ["Gegenseitig", "Einseitig", "Nicht geregelt", "Unklar"]] },
  { id: "renewal", kind: "yes_no", tags: ["lease", "general"], en: ["Automatic renewal", "Does this agreement renew automatically unless a party gives notice? Include any schedule or amendment that changes renewal."], de: ["Automatische Verlängerung", "Verlängert sich der Vertrag automatisch, wenn keine Partei kündigt? Berücksichtige Anlagen und Änderungen zur Verlängerung."] },
  { id: "notice", kind: "text", tags: ["lease"], en: ["Notice period", "State the notice period and deadline for ordinary termination, including relevant exceptions."], de: ["Kündigungsfrist", "Nenne Frist und Termin der ordentlichen Kündigung einschließlich relevanter Ausnahmen."] },
  { id: "unusual-clause", kind: "classification", tags: ["due-diligence"], en: ["Unusual provisions", "Assess whether the contract contains a material obligation buried in an unrelated section, a surprising exception, or an ambiguously drafted provision. Compare the main provision with definitions, schedules and additions. Distinguish possible issues from established legal conclusions.", ["Potential issue", "No issue identified", "Needs review"]], de: ["Ungewöhnliche Klauseln", "Prüfe wesentliche Pflichten an unerwarteten Stellen, überraschende Ausnahmen und unklare Formulierungen. Vergleiche Hauptklauseln, Definitionen, Anlagen und Ergänzungen. Unterscheide mögliche Auffälligkeiten von gesicherten rechtlichen Schlussfolgerungen.", ["Mögliche Auffälligkeit", "Keine Auffälligkeit erkannt", "Prüfung erforderlich"]] },
  { id: "dd-findings", kind: "text", tags: ["due-diligence"], en: ["Diligence findings", "Identify potentially surprising, disguised or ambiguously drafted material provisions, including handwritten additions. Combine all related passages and cite each contributing page or region. Explain why each candidate needs attention. Distinguish observed handwriting from an established contractual amendment, and ordinary or non-substantive notes from material provisions. Illegible or missing evidence requires human review."], de: ["DD-Feststellungen", "Finde potenziell überraschende, verkappte oder unklar formulierte wesentliche Klauseln einschließlich handschriftlicher Ergänzungen. Führe zusammengehörige Passagen zusammen und belege jede beitragende Seite oder Region. Erkläre den Prüfbedarf. Unterscheide erkennbare Handschrift von einer nachgewiesenen Vertragsänderung sowie gewöhnliche oder unwesentliche Notizen von wesentlichen Regelungen. Unleserliche oder fehlende Belege erfordern menschliche Prüfung."] },
];

export function builtinReviewLibrary(language: "en" | "de"): ReviewLibraryEntry[] {
  const columns = STARTERS.map(item => {
    const [label, question, options = []] = item[language];
    const id = `builtin-${item.id}-${language}`;
    return { id, version: 1, name: label, description: question, tags: item.tags, language, source: "builtin", updatedAt: 0,
      columns: [{ key: item.id, label, question, kind: item.kind, options, hint: "", libraryId: id, libraryVersion: 1, libraryColumnKey: item.id }] } satisfies ReviewLibraryEntry;
  });
  const sets = [
    { key: "nda", names: { en: "NDA review", de: "NDA-Prüfung" } },
    { key: "lease", names: { en: "Lease review", de: "Mietvertragsprüfung" } },
    { key: "due-diligence", names: { en: "Due diligence", de: "Due Diligence" } },
  ];
  return [...columns, ...sets.map(set => ({ id: `builtin-set-${set.key}-${language}`, version: 1, name: set.names[language], description: "", tags: [set.key], language, source: "builtin", updatedAt: 0,
    columns: columns.filter(entry => entry.tags.includes(set.key)).flatMap(entry => entry.columns),
  } satisfies ReviewLibraryEntry))];
}

export class ReviewLibrary {
  constructor(private config: ServerConfig) {}
  private async path() {
    const root = join(runtimeStorageDir(this.config), "review-library");
    await mkdir(root, { recursive: true, mode: 0o700 });
    return join(await realpath(root), "entries.json");
  }
  private async personal() {
    try { return await readJson(await this.path(), z.array(ReviewLibraryEntrySchema)); }
    catch (error) { if (missing(error)) return []; throw error; }
  }
  async list(language: "en" | "de") { return [...builtinReviewLibrary(language), ...await this.personal()]; }
  async save(raw: unknown) {
    const input = SaveReviewLibrarySchema.parse(raw);
    return serialized(await this.path(), async () => {
      const entries = await this.personal();
      const existing = input.id ? entries.find(item => item.id === input.id) : undefined;
      if (input.id && !existing) throw new ApiError(404, "review_library_not_found", "Saved prompt not found.");
      if (existing && existing.version !== input.version) throw new ApiError(409, "review_library_conflict", "This saved prompt has changed. Reload it before saving.");
      const id = existing?.id ?? randomUUID(), version = (existing?.version ?? 0) + 1;
      const entry: ReviewLibraryEntry = { ...input, id, version, source: "personal", updatedAt: Date.now(), columns: input.columns.map(column => ({ ...column, libraryId: id, libraryVersion: version, libraryColumnKey: column.key })) };
      await atomicJson(await this.path(), [...entries.filter(item => item.id !== id), entry]);
      return entry;
    });
  }
  async remove(id: string) {
    z.string().uuid().parse(id);
    await serialized(await this.path(), async () => atomicJson(await this.path(), (await this.personal()).filter(entry => entry.id !== id)));
  }
}
