import { t } from "@/i18n";
import { documentIdentityKey } from "./document-identity";
import type { DocxEditorApi } from "./artifact-docx-editor";
export type DocxRecovery = {
  key: string;
  buffer: ArrayBuffer;
  baseUpdatedAt: number | null;
  savedAt: number;
};

// IndexedDB holds document bytes without localStorage's small synchronous quota.
// One ordered queue prevents a slow checkpoint from resurrecting a saved draft.
let queue: Promise<unknown> = Promise.resolve();

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("legalwork-docx-recovery", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("drafts")) request.result.createObjectStore("drafts", { keyPath: "key" });
      if (!request.result.objectStoreNames.contains("versions")) request.result.createObjectStore("versions", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function operation<T>(run: (store: IDBObjectStore, transaction: IDBTransaction) => IDBRequest<T>, storeName = "drafts", additionalStores: string[] = []): Promise<T> {
  const next = queue.catch(() => undefined).then(async () => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction([storeName, ...additionalStores], "readwrite");
      const request = run(transaction.objectStore(storeName), transaction);
      transaction.oncomplete = () => { db.close(); resolve(request.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error(t("artifact.draft_recovery_failed"))); };
      transaction.onerror = () => { /* onabort handles the failure. */ };
    });
  });
  queue = next;
  return next;
}

export function matchesDocxRecoveryKey(candidate: string, key: string, legacyKey?: string) {
  if (candidate === key || candidate === legacyKey) return true;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return false;
    const url = new URL(parsed[0]);
    // Only local workspaces could create DOCX checkpoints under the old scheme.
    // Never infer a remote worker's identity from a loopback forwarding address.
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/" && documentIdentityKey(parsed[0], parsed[1], true) === key;
  } catch { return false; }
}

function recoveryFromRecord(value: unknown): DocxRecovery | null {
  if (!value || typeof value !== "object" || !("buffer" in value) || !(value.buffer instanceof ArrayBuffer) ||
      !("key" in value) || typeof value.key !== "string" || !("savedAt" in value) || typeof value.savedAt !== "number" ||
      !("baseUpdatedAt" in value) || (value.baseUpdatedAt !== null && typeof value.baseUpdatedAt !== "number")) return null;
  return { key: value.key, buffer: value.buffer, savedAt: value.savedAt, baseUpdatedAt: value.baseUpdatedAt };
}

export async function readDocxRecovery(key: string, legacyKey?: string): Promise<DocxRecovery | null> {
  let recovered: DocxRecovery | null = null;
  // Migrate atomically, including checkpoints from earlier local API ports.
  // Delete migrated aliases so a later save/discard cannot resurrect them.
  await operation((store, transaction) => {
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      const matching = keys.result.filter((candidate): candidate is string => typeof candidate === "string" && matchesDocxRecoveryKey(candidate, key, legacyKey));
      let remaining = matching.length;
      const drafts: DocxRecovery[] = [];
      for (const candidate of matching) {
        const request = store.get(candidate);
        request.onsuccess = () => {
          const draft = recoveryFromRecord(request.result);
          if (draft) drafts.push(draft);
          if (--remaining || !drafts.length) return;
          drafts.sort((a, b) => b.savedAt - a.savedAt);
          recovered = { ...drafts[0], key };
          if (drafts.every(item => item.key === key)) return;
          store.put(recovered);
          for (const item of drafts) if (item.key !== key) store.delete(item.key);
          // Retain superseded checkpoints in the existing bounded local history.
          if (drafts.length > 1) {
            const versions = transaction.objectStore("versions");
            const history = versions.get(key);
            history.onsuccess = () => versions.put({ key, versions: [
              ...drafts.slice(1).map(item => ({ savedAt: item.savedAt, buffer: item.buffer })),
              ...versionsFromRecord(history.result),
            ].sort((a, b) => b.savedAt - a.savedAt).slice(0, 5) });
          }
        };
      }
    };
    return keys;
  }, "drafts", ["versions"]);
  return recovered;
}

export async function writeDocxRecovery(draft: DocxRecovery) {
  await operation((store) => store.put(draft));
}

export async function removeDocxRecovery(key: string) {
  await operation((store) => store.delete(key));
}

export type DocxVersion = { savedAt: number; buffer: ArrayBuffer; automatic?: boolean };

function versionsFromRecord(value: unknown): DocxVersion[] {
  if (!value || typeof value !== "object" || !("versions" in value) || !Array.isArray(value.versions)) return [];
  return value.versions.filter((item): item is DocxVersion => !!item && typeof item === "object" &&
    "savedAt" in item && typeof item.savedAt === "number" && "buffer" in item && item.buffer instanceof ArrayBuffer);
}

export async function readDocxVersions(key: string): Promise<DocxVersion[]> {
  return versionsFromRecord(await operation((store) => store.get(key), "versions"));
}

export function appendDocxVersion(versions: DocxVersion[], buffer: ArrayBuffer, automatic: boolean, now: number): DocxVersion[] {
  // Keep the bucket's start time so continuous saving eventually starts a new
  // checkpoint instead of replacing the same one for the entire session.
  const coalesce = automatic && versions[0]?.automatic && now - versions[0].savedAt < 5 * 60_000;
  return [{ savedAt: coalesce ? versions[0].savedAt : now, buffer, automatic }, ...versions.slice(coalesce ? 1 : 0)].slice(0, 5);
}

export async function keepDocxVersion(key: string, buffer: ArrayBuffer, automatic = false) {
  // Read/append within one transaction so saves in two windows cannot drop a version.
  await operation((store) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const versions = versionsFromRecord(request.result);
      store.put({ key, versions: appendDocxVersion(versions, buffer, automatic, Date.now()) });
    };
    return request;
  }, "versions");
}

/** Await queued draft writes before giving another window editing ownership. */
export async function drainDocxRecovery() { await queue; }
/**
 * The editor while the user still has to decide about a kept draft. Agent
 * tools get the reason instead of "still loading", so the agent asks the user
 * rather than looking for the document elsewhere on the computer.
 */
export function draftDecisionPendingApi(name: string): DocxEditorApi {
  const error = `${name} has an unsaved draft kept on this device. The user must choose "Recover draft" or "Discard draft and open file" in LegalWork's editor before the document can be read or edited. Ask the user to decide. Do not look for the document elsewhere or inspect the app.`;
  return {
    save: async () => false,
    flushSave: async () => false,
    drain: async () => {},
    revision: () => 0,
    isDirty: () => true,
    getBuffer: async () => null,
    executeAgentTool: async () => ({ success: false, error }),
    discardRecovery: async () => {},
  };
}
