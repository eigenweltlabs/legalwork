export type DocxSnapshot = {
  kind: "binary";
  data: ArrayBuffer;
  contentType: string | null;
  updatedAt: number | null;
  revision: number;
};

/** Keep the loaded version while editing so an agent refresh cannot erase a draft
 * or advance the version used by the server's optimistic concurrency check. */
export function reconcileDocxSnapshot(
  current: DocxSnapshot | null,
  incoming: DocxSnapshot,
  hasUnsavedChanges: boolean,
): DocxSnapshot {
  if (!current) return incoming;
  if (hasUnsavedChanges || current.revision === incoming.revision ||
      (current.updatedAt !== null && current.updatedAt === incoming.updatedAt)) return current;
  return incoming;
}

/** A local save updates the baseline without replacing the live editor/undo stack. */
export function savedDocxSnapshot(current: DocxSnapshot, data: ArrayBuffer, updatedAt: number | null): DocxSnapshot {
  return { ...current, data, updatedAt };
}

const unsavedDocuments = new Map<string, { name: string; isDirty: () => boolean; discard?: () => void; retainOnSwitch: boolean }>();

export function artifactDocumentKey(workspaceId: string, sessionId: string, targetId: string) {
  return JSON.stringify([workspaceId, sessionId, targetId]);
}

export function registerUnsavedDocument(key: string, name: string, isDirty: () => boolean, discard?: () => void, retainOnSwitch = false) {
  const entry = { name, isDirty, discard, retainOnSwitch };
  unsavedDocuments.set(key, entry);
  return () => {
    if (unsavedDocuments.get(key) === entry) unsavedDocuments.delete(key);
  };
}

export function confirmDiscardDocuments(key?: string, confirm?: (message: string) => boolean, switching = false) {
  return confirmDiscard((id) => !key || id === key, confirm, switching);
}

/** Guard only the documents shown in one pane, named by session and target id.
 * With two panes open, switching a tab in one must not discard the other's draft. */
export function confirmDiscardSessionDocuments(
  sessionId: string,
  targetIds: Array<string | null>,
  confirm?: (message: string) => boolean,
  switching = false,
) {
  // artifactDocumentKey is a JSON array, so the last two elements form a
  // suffix no workspace id can imitate. Workflow editors register under
  // their bare tab id.
  const suffixes = targetIds.flatMap((targetId) => targetId ? [JSON.stringify([sessionId, targetId]).slice(1)] : []);
  return confirmDiscard((id) => targetIds.includes(id) || suffixes.some((suffix) => id.endsWith(suffix)), confirm, switching);
}

function confirmDiscard(matches: (key: string) => boolean, confirm?: (message: string) => boolean, switching = false) {
  const entries = [...unsavedDocuments.entries()].filter(([id, entry]) => matches(id) && !(switching && entry.retainOnSwitch) && entry.isDirty());
  const names = entries.map(([, entry]) => entry.name);
  if (!names.length) return true;
  const ask = confirm ?? ((message: string) => window.confirm(message));
  if (!ask(`Discard unsaved changes to ${names.join(", ")}? Save the document first to keep your changes.`)) return false;
  for (const [, entry] of entries) entry.discard?.();
  return true;
}
