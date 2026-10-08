import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApiError } from "../errors.js";
import { openSqlite, type SqliteHandle } from "../runtime-db.js";
import { BlobSchema, type BlobReference } from "./schema.js";

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
export type StoredObject = { data: Buffer; revision: string };
export interface SyncObjects {
  get(key: string): Promise<StoredObject | null>;
  stat(key: string): Promise<string | null>;
  put(key: string, data: Buffer, expected: string | null): Promise<string>;
  close?(): void;
}

export function syncConflict(): never {
  throw new ApiError(409, "storage_conflict", "The cloud copy changed. Sync again before retrying.");
}

/** Local integration backend with the same cross-process CAS contract as GCS. */
export class DirectoryObjects implements SyncObjects {
  private constructor(private root: string, private db: SqliteHandle) {}
  static async open(root: string) {
    await mkdir(join(root, "objects"), { recursive: true });
    const db = await openSqlite(join(root, "index.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, hash TEXT NOT NULL, revision INTEGER NOT NULL)");
    return new DirectoryObjects(root, db);
  }
  async stat(key: string) {
    const row = this.db.get("SELECT revision FROM objects WHERE key = ?", [key]);
    return row ? String(row.revision) : null;
  }
  async get(key: string) {
    const row = this.db.get("SELECT hash, revision FROM objects WHERE key = ?", [key]);
    if (!row) return null;
    return { data: await readFile(join(this.root, "objects", String(row.hash))), revision: String(row.revision) };
  }
  async put(key: string, data: Buffer, expected: string | null) {
    const hash = digest(data);
    const temporary = join(this.root, "objects", randomUUID());
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, join(this.root, "objects", hash));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.get("SELECT revision FROM objects WHERE key = ?", [key]);
      if ((row ? String(row.revision) : null) !== expected) syncConflict();
      const revision = Number(row?.revision ?? 0) + 1;
      this.db.run("INSERT INTO objects VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, revision = excluded.revision", [key, hash, revision]);
      this.db.exec("COMMIT");
      return String(revision);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close?.(); }
}

export function isConflict(error: unknown) { return error instanceof ApiError && error.code === "storage_conflict"; }

export async function putBlob(store: SyncObjects, source: Buffer | string): Promise<BlobReference> {
  const hash = createHash("sha256");
  const chunks: string[] = [];
  let size = 0;
  const file = typeof source === "string" ? await open(source, "r") : null;
  try {
    while (true) {
      const bytes = Buffer.allocUnsafe(CHUNK_BYTES);
      const count = file ? (await file.read(bytes, 0, bytes.length, size)).bytesRead : Math.min(bytes.length, source.length - size);
      if (!count) break;
      if (!file && Buffer.isBuffer(source)) source.copy(bytes, 0, size, size + count);
      const chunk = bytes.subarray(0, count);
      hash.update(chunk); size += count;
      const sha = digest(chunk); chunks.push(sha);
      if (await store.stat(`blobs/${sha}`) === null) {
        try { await store.put(`blobs/${sha}`, chunk, null); }
        catch (error) { if (!isConflict(error)) throw error; }
      }
    }
  } finally { await file?.close(); }
  return BlobSchema.parse({ sha256: hash.digest("hex"), size, chunks });
}

/** Verify every chunk and the complete file, then publish via atomic rename. */
export async function getBlob(store: SyncObjects, reference: BlobReference, destination: string) {
  const parsed = BlobSchema.parse(reference);
  if (parsed.chunks.length !== Math.ceil(parsed.size / CHUNK_BYTES)) throw new Error("Invalid blob chunk count");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (const sha of parsed.chunks) {
      const chunk = await store.get(`blobs/${sha}`);
      if (!chunk || chunk.data.length > CHUNK_BYTES || digest(chunk.data) !== sha) throw new Error("Missing or corrupt sync chunk");
      hash.update(chunk.data); size += chunk.data.length;
      await file.writeFile(chunk.data);
    }
    if (size !== parsed.size || hash.digest("hex") !== parsed.sha256) throw new Error("Sync file checksum mismatch");
    await file.sync(); await file.close();
    await rename(temporary, destination);
  } catch (error) { await file.close().catch(() => {}); throw error; }
  finally { await rm(temporary, { force: true }); }
}
