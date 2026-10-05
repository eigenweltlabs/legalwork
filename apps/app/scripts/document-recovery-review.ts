// Browser-only IndexedDB integration check with unique, disposable identities.
import { readDocxRecovery, readDocxVersions, removeDocxRecovery, writeDocxRecovery } from "../src/react-app/domains/session/artifacts/docx-recovery";
import { documentIdentityKey } from "../src/react-app/domains/session/artifacts/document-identity";

export async function checkDocumentRecovery() {
  const id = `review-${crypto.randomUUID()}`;
  const oldKey = JSON.stringify(["http://127.0.0.1:41234", id]);
  const olderKey = JSON.stringify(["http://localhost:41233", id]);
  const legacy = JSON.stringify([id, "Agreement.docx"]);
  const key = documentIdentityKey("http://127.0.0.1:51234", id, true);
  const unrelated = JSON.stringify(["https://another-server.test:41234", id]);
  const draft = (key: string, savedAt: number) => ({ key, savedAt, baseUpdatedAt: 42, buffer: new Uint8Array([savedAt]).buffer });
  const checks: string[] = [];
  const check = (condition: boolean, label: string) => { if (!condition) throw new Error(label); checks.push(label); };
  try {
    await writeDocxRecovery(draft(oldKey, 3));
    await writeDocxRecovery(draft(olderKey, 2));
    await writeDocxRecovery(draft(legacy, 1));
    await writeDocxRecovery(draft(unrelated, 4));
    const restored = await readDocxRecovery(key, legacy);
    check(restored?.key === key && new Uint8Array(restored.buffer)[0] === 3, "Previous-port draft recovered with exact bytes");
    check(restored?.baseUpdatedAt === 42, "Original conflict baseline retained");
    check((await readDocxVersions(key)).map(version => new Uint8Array(version.buffer)[0]).join() === "2,1", "Older checkpoints retained in history");
    check((await readDocxRecovery(unrelated))?.savedAt === 4, "Other server draft untouched");
    check((await readDocxRecovery(key))?.savedAt === 3, "Stable-key reload recovers the same draft");
    await removeDocxRecovery(key);
    check(await readDocxRecovery(key, legacy) === null, "Save/discard does not resurrect migrated drafts");
    await writeDocxRecovery(draft(key, 5));
    await writeDocxRecovery(draft(oldKey, 3));
    check((await readDocxRecovery(key))?.savedAt === 5, "Existing newer stable checkpoint wins");
    return checks.join("\n");
  } finally {
    for (const item of [key, oldKey, olderKey, legacy, unrelated]) await removeDocxRecovery(item);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("legalwork-docx-recovery", 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("versions", "readwrite");
        transaction.objectStore("versions").delete(key);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }
}
