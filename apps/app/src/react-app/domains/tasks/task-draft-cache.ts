import { artifactDocumentKey, registerUnsavedDocument } from "../session/artifacts/docx-document-state";
import { createTaskDraft, type TaskDraft } from "./task-draft";

type TaskText = { id: string; title: string; description: string };
type Entry = { draft: TaskDraft; dispose: () => void };
const scopes = new Map<string, { owners: number; entries: Map<string, Entry> }>();

export function taskDraftScope(baseUrl: string, workspaceId: string, projectId: string | undefined, embedded: boolean) {
  return `task-overview:${JSON.stringify([baseUrl, workspaceId, projectId ?? null, embedded])}`;
}

function stateFor(scope: string) {
  let state = scopes.get(scope);
  if (!state) { state = { owners: 0, entries: new Map() }; scopes.set(scope, state); }
  return state;
}

function pruneLater(scope: string) {
  // React StrictMode releases and immediately reacquires effects. Waiting one
  // microtask also lets a returning pane claim a still-running save safely.
  queueMicrotask(() => {
    const state = scopes.get(scope);
    if (!state || state.owners) return;
    for (const [id, entry] of state.entries) {
      if (entry.draft.isDirty()) continue;
      entry.dispose();
      state.entries.delete(id);
    }
    if (!state.entries.size) scopes.delete(scope);
  });
}

/** A scope may be mounted more than once. Dirty entries outlive every owner. */
export function retainTaskDraftScope(scope: string) {
  stateFor(scope).owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const state = scopes.get(scope);
    if (state) state.owners--;
    pruneLater(scope);
  };
}

export function getTaskDraft(scope: string, workspaceId: string, task: TaskText) {
  const state = stateFor(scope);
  const existing = state.entries.get(task.id);
  if (existing) return existing.draft;
  const draft = createTaskDraft(task);
  // These drafts survive navigation; unrelated panel guards must not discard them.
  const unregister = registerUnsavedDocument(artifactDocumentKey(workspaceId, scope, `task:${task.id}`), task.title, draft.isDirty, draft.discard, true, { scopedOnly: true });
  const unsubscribe = draft.subscribe(() => pruneLater(scope));
  state.entries.set(task.id, { draft, dispose: () => { unsubscribe(); unregister(); } });
  return draft;
}

export function hasTaskDrafts() {
  return [...scopes.values()].some(state => [...state.entries.values()].some(entry => entry.draft.isDirty()));
}

// This protection belongs to retained drafts, not the currently visible pane.
if (typeof window !== "undefined") {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasTaskDrafts()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  import.meta.hot?.dispose(() => window.removeEventListener("beforeunload", beforeUnload));
}
