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

const unsavedDocuments = new Map<string, { name: string; isDirty: () => boolean; discard?: () => void }>();

export function artifactDocumentKey(workspaceId: string, sessionId: string, targetId: string) {
  return JSON.stringify([workspaceId, sessionId, targetId]);
}

export function registerUnsavedDocument(key: string, name: string, isDirty: () => boolean, discard?: () => void) {
  const entry = { name, isDirty, discard };
  unsavedDocuments.set(key, entry);
  return () => {
    if (unsavedDocuments.get(key) === entry) unsavedDocuments.delete(key);
  };
}

export function confirmDiscardDocuments(key?: string, confirm?: (message: string) => boolean) {
  const entries = [...unsavedDocuments.entries()].filter(([id, entry]) => (!key || id === key) && entry.isDirty());
  const names = entries.map(([, entry]) => entry.name);
  if (!names.length) return true;
  const ask = confirm ?? ((message: string) => window.confirm(message));
  if (!ask(`Discard unsaved changes to ${names.join(", ")}? Save the document first to keep your changes.`)) return false;
  for (const [, entry] of entries) entry.discard?.();
  return true;
}
