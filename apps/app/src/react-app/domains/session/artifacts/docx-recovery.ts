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

function operation<T>(run: (store: IDBObjectStore) => IDBRequest<T>, storeName = "drafts"): Promise<T> {
  const next = queue.catch(() => undefined).then(async () => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const request = run(transaction.objectStore(storeName));
      transaction.oncomplete = () => { db.close(); resolve(request.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("Draft recovery storage failed")); };
      transaction.onerror = () => { /* onabort handles the failure. */ };
    });
  });
  queue = next;
  return next;
}

export async function readDocxRecovery(key: string): Promise<DocxRecovery | null> {
  const value: unknown = await operation((store) => store.get(key));
  if (!value || typeof value !== "object" || !("buffer" in value) || !(value.buffer instanceof ArrayBuffer) ||
      !("key" in value) || value.key !== key || !("savedAt" in value) || typeof value.savedAt !== "number" ||
      !("baseUpdatedAt" in value) || (value.baseUpdatedAt !== null && typeof value.baseUpdatedAt !== "number")) return null;
  return { key, buffer: value.buffer, savedAt: value.savedAt, baseUpdatedAt: value.baseUpdatedAt };
}

export async function writeDocxRecovery(draft: DocxRecovery) {
  await operation((store) => store.put(draft));
}

export async function removeDocxRecovery(key: string) {
  await operation((store) => store.delete(key));
}

export type DocxVersion = { savedAt: number; buffer: ArrayBuffer };

function versionsFromRecord(value: unknown): DocxVersion[] {
  if (!value || typeof value !== "object" || !("versions" in value) || !Array.isArray(value.versions)) return [];
  return value.versions.filter((item): item is DocxVersion => !!item && typeof item === "object" &&
    "savedAt" in item && typeof item.savedAt === "number" && "buffer" in item && item.buffer instanceof ArrayBuffer);
}

export async function readDocxVersions(key: string): Promise<DocxVersion[]> {
  return versionsFromRecord(await operation((store) => store.get(key), "versions"));
}

export async function keepDocxVersion(key: string, buffer: ArrayBuffer) {
  // Read/append within one transaction so saves in two windows cannot drop a version.
  await operation((store) => {
    const request = store.get(key);
    request.onsuccess = () => {
      store.put({ key, versions: [{ savedAt: Date.now(), buffer }, ...versionsFromRecord(request.result)].slice(0, 5) });
    };
    return request;
  }, "versions");
}
