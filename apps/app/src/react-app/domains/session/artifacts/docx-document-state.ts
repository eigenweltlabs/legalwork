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

type UnsavedDocument = { name: string; isDirty: () => boolean; discard?: () => void; retainOnSwitch: boolean; scopedOnly: boolean };
const unsavedDocuments = new Map<string, UnsavedDocument>();
let approvedDocuments = new Set<UnsavedDocument>();
let discardedDocuments = new Set<UnsavedDocument>();
type DiscardPrompt = { names: string[]; proceed: () => void; settled: Promise<boolean>; settle: (accepted: boolean) => void };
let discardPrompt: DiscardPrompt | null = null;
const promptListeners = new Set<() => void>();
export const getDocumentDiscardPrompt = () => discardPrompt;
/** Async imports must wait for the complete decision before advancing their batch. */
export async function waitForDocumentDiscardPrompt() {
  while (discardPrompt) if (!await discardPrompt.settled) return false;
  return true;
}
export function subscribeDocumentDiscardPrompt(listener: () => void) {
  promptListeners.add(listener);
  return () => { promptListeners.delete(listener); };
}
export function resolveDocumentDiscardPrompt(accepted: boolean) {
  const prompt = discardPrompt;
  discardPrompt = null;
  promptListeners.forEach(listener => listener());
  try { if (accepted) prompt?.proceed(); } finally { prompt?.settle(accepted); }
}

export function hasUnsavedSessionDocument(sessionId: string, targetId: string) {
  const suffix = JSON.stringify([sessionId, targetId]).slice(1);
  return [...unsavedDocuments].some(([id, entry]) => (id === targetId || id.endsWith(suffix)) && entry.isDirty());
}

export function artifactDocumentKey(workspaceId: string, sessionId: string, targetId: string) {
  return JSON.stringify([workspaceId, sessionId, targetId]);
}

export function registerUnsavedDocument(key: string, name: string, isDirty: () => boolean, discard?: () => void, retainOnSwitch = false, options?: { scopedOnly: boolean }) {
  const entry = { name, isDirty, discard, retainOnSwitch, scopedOnly: options?.scopedOnly ?? false };
  unsavedDocuments.set(key, entry);
  return () => {
    if (unsavedDocuments.get(key) === entry) unsavedDocuments.delete(key);
  };
}

export function confirmDiscardDocuments(key?: string, confirm?: (message: string) => boolean, switching = false, retry?: () => void) {
  return confirmDiscard((id, entry) => key ? id === key : !entry.scopedOnly, confirm, switching, retry);
}

/** Resume the action only after consent, rechecking the live draft registrations. */
export function discardDocumentsThen(action: () => void, key?: string, switching = false) {
  if (confirmDiscardDocuments(key, undefined, switching, () => discardDocumentsThen(action, key, switching))) action();
}

/** Guard only the documents shown in one pane, named by session and target id.
 * With two panes open, switching a tab in one must not discard the other's draft. */
export function confirmDiscardSessionDocuments(
  sessionId: string,
  targetIds: Array<string | null>,
  confirm?: (message: string) => boolean,
  switching = false,
  retry?: () => void,
) {
  // artifactDocumentKey is a JSON array, so the last two elements form a
  // suffix no workspace id can imitate. Workflow editors register under
  // their bare tab id.
  const suffixes = targetIds.flatMap((targetId) => targetId ? [JSON.stringify([sessionId, targetId]).slice(1)] : []);
  return confirmDiscard((id) => targetIds.includes(id) || suffixes.some((suffix) => id.endsWith(suffix)), confirm, switching, retry);
}

function confirmDiscard(matches: (key: string, entry: UnsavedDocument) => boolean, confirm?: (message: string) => boolean, switching = false, retry?: () => void) {
  const entries = [...unsavedDocuments.entries()].filter(([id, entry]) => matches(id, entry) && !(switching && entry.retainOnSwitch) && entry.isDirty());
  const names = entries.map(([, entry]) => entry.name);
  if (!names.length) return true;
  if (!entries.every(([, entry]) => approvedDocuments.has(entry))) {
    if (confirm) {
      if (!confirm(`Discard unsaved changes to ${names.join(", ")}? Save the document first to keep your changes.`)) return false;
    } else {
      if (retry && !discardPrompt) {
        let settle = (_accepted: boolean) => {};
        const settled = new Promise<boolean>(resolve => { settle = resolve; });
        discardPrompt = { names, settled, settle, proceed: () => {
          const previousApproved = approvedDocuments, previousDiscarded = discardedDocuments;
          approvedDocuments = new Set(entries.map(([, entry]) => entry));
          discardedDocuments = new Set();
          try { retry(); } finally { approvedDocuments = previousApproved; discardedDocuments = previousDiscarded; }
        } };
        // Store guards also run inside state updaters; notify React after they finish.
        queueMicrotask(() => promptListeners.forEach(listener => listener()));
      }
      return false;
    }
  }
  for (const [, entry] of entries) {
    if (approvedDocuments.has(entry)) {
      if (discardedDocuments.has(entry)) continue;
      discardedDocuments.add(entry);
    }
    entry.discard?.();
  }
  return true;
}
