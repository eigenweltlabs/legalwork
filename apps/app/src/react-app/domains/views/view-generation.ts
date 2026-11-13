import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ViewRecordSchema, ViewPreviewSchema, type ViewRecord, type ViewSummary, type ViewPreview } from "@legalwork/types/views";
import type { ViewPanelTab } from "./view-reference";
import { t } from "@/i18n";

export type ViewDraftTab = { id: string; type: "view-draft"; serverUrl: string; generationId: string; label: string };
export type ViewGeneration = { serverUrl: string; workspaceId: string; sessionId: string; toolCallId: string; replacesId?: string; sourceTab?: ViewPanelTab; layoutEdit?: boolean; title: string; program: string; status: "streaming" | "failed" | "preview" | "saved"; error?: string; preview?: ViewPreview; saved?: ViewRecord | ViewSummary };
export function viewGenerationId(serverUrl: string, sessionId: string, toolCallId: string) { return `view-generation:${JSON.stringify([serverUrl, sessionId, toolCallId])}`; }
/** Each edit keeps its own save receipt, while the original tab follows its revision chain. */
export function latestDraftId(id: string, entries: Record<string, ViewGeneration>) {
  const revisions = Object.entries(entries).filter(([, entry]) => entry.replacesId && entry.status !== "failed");
  const seen = new Set([id]);
  for (;;) {
    const next = revisions.findLast(([, entry]) => entry.replacesId === id);
    if (!next || seen.has(next[0])) return id;
    id = next[0];
    seen.add(id);
  }
}
export function draftRootId(id: string, entries: Record<string, ViewGeneration>) {
  const seen = new Set([id]);
  for (;;) {
    const parent = entries[id]?.replacesId;
    if (!parent || seen.has(parent)) break;
    id = parent;
    seen.add(id);
  }
  return id;
}
export function viewDraftTab(id: string, generation: ViewGeneration): ViewDraftTab {
  const root = draftRootId(id, useViewGenerationStore.getState().entries);
  return { id: root, type: "view-draft", generationId: root, serverUrl: generation.serverUrl, label: generation.title };
}
export function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function viewProgramInput(value: unknown) {
  const input = record(value) && record(value.input) ? value.input : value;
  return record(input) ? { program: typeof input.program === "string" ? input.program : "", title: typeof input.title === "string" ? input.title : "Creating view…" } : { program: "", title: "Creating view…" };
}
export function viewToolOutcome(output: unknown): { view: ViewRecord } | { preview: ViewPreview } | { error: string } {
  let value = output;
  if (typeof output === "string") {
    // Runtime reminders are appended after tool JSON, including in saved history.
    // Strip only that trailing envelope; malformed or incomplete JSON must still fail.
    const json = output.replace(/(?:\n\n<system-reminder topic="[^"\r\n]+">\n[\s\S]*?\n<\/system-reminder>)+\s*$/u, "");
    try { value = JSON.parse(json); } catch { return { error: t("views.preview_missing") }; }
  }
  if (record(value) && value.ok === false) return { error: typeof value.error === "string" ? value.error : record(value.error) && typeof value.error.message === "string" ? value.error.message : t("views.generation_failed") };
  const preview = ViewPreviewSchema.safeParse(value);
  if (preview.success) return { preview: preview.data };
  const parsed = ViewRecordSchema.strip().safeParse(record(value) && value.view ? value.view : value);
  return parsed.success ? { view: parsed.data } : { error: t("views.preview_missing") };
}
const savedSummarySchema = ViewRecordSchema.pick({ id: true, title: true, mode: true, updatedAt: true, revision: true, owner: true }).strip();
type GenerationState = {
  entries: Record<string, ViewGeneration>;
  savedResults: Record<string, ViewSummary>;
  update(id: string, next: ViewGeneration): void;
  fail(id: string, error: string): void;
  markSaved(id: string, view: ViewRecord): void;
  forgetSession(sessionId: string): void;
};
export const useViewGenerationStore = create<GenerationState>()(persist((set) => ({
  entries: {}, savedResults: {},
  forgetSession: (sessionId) => set(state => ({ entries: Object.fromEntries(Object.entries(state.entries).filter(([, entry]) => entry.sessionId !== sessionId)) })),
  update: (id, next) => set(state => ({ entries: { ...state.entries, [id]: next } })),
  fail: (id, error) => set(state => { const current = state.entries[id]; return current?.status === "streaming" ? { entries: { ...state.entries, [id]: { ...current, status: "failed", error } } } : state; }),
  markSaved: (id, view) => set(state => ({
    entries: state.entries[id] ? { ...state.entries, [id]: { ...state.entries[id], status: "saved", saved: view, error: undefined } } : state.entries,
    savedResults: Object.fromEntries(Object.entries({ ...state.savedResults, [id]: savedSummarySchema.parse(view) }).slice(-200)),
  })),
}), {
  name: "legalwork.view-save-results",
  partialize: state => ({ savedResults: state.savedResults }),
  merge: (stored, current) => {
    if (!record(stored) || !record(stored.savedResults)) return current;
    const savedResults: Record<string, ViewSummary> = {};
    for (const [id, value] of Object.entries(stored.savedResults).slice(-200)) {
      const parsed = savedSummarySchema.safeParse(value);
      if (parsed.success) savedResults[id] = parsed.data;
    }
    return { ...current, savedResults };
  },
}));
/** Resolve the generation in place, retaining the pane and tab order. Only saved tabs persist. */
export function replaceGenerationTab<T extends { id: string }>(tabs: T[], draftId: string, saved: ViewPanelTab): (T | ViewPanelTab)[] {
  return tabs.flatMap<T | ViewPanelTab>(tab => tab.id === draftId ? [saved] : tab.id === saved.id ? [] : [tab]);
}
