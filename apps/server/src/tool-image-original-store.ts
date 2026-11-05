import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { engineStorageDir } from "./engine-storage.js";
import { openSqlite, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { ApiError } from "./errors.js";
import { toolImageOriginal, type ToolImageOriginal, type ToolImageOriginalReference, type ToolImageCaptureInput } from "./tool-image-original-schema.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { isAbsolute, relative, sep } from "node:path";
import { imageSize } from "image-size";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const cursor = z.object({ sessionID: z.string(), after: z.number().int().nonnegative().safe(), through: z.number().int().nonnegative().safe() }).strict();
const row = z.object({ seq: z.number().int().positive().safe(), metadata: z.string() });
const missing = () => new ApiError(404, "tool_image_original_unavailable", "This original image is unavailable in the authorized chat history.");
function header(bytes: Uint8Array): ToolImageOriginal["header"] {
  try {
    const value = imageSize(bytes);
    if (!Number.isSafeInteger(value.width) || value.width <= 0 || !Number.isSafeInteger(value.height) || value.height <= 0 || !value.type) return { status: "unavailable" };
    const orientation = value.type === "jpg" && value.orientation !== undefined ? value.orientation : null;
    const swapped = orientation !== null && orientation >= 5 && orientation <= 8;
    return { status: "available", encodedWidth: value.width, encodedHeight: value.height, type: value.type, orientation, orientationSource: orientation === null ? "not-exposed" : "jpeg-exif",
      cropCoordinates: ["jpg", "png", "webp"].includes(value.type) ? { status: "header-derived-expectation", coordinateSpace: "decoded-raster-pixels",
        expectedWidth: swapped ? value.height : value.width, expectedHeight: swapped ? value.width : value.height,
        orientationPolicy: value.type === "jpg" ? "jpeg-exif-applied" : "png-webp-metadata-unhandled", decoder: "@napi-rs/canvas",
        qualification: "The crop worker validates actual decoded dimensions and format before processing." } : { status: "unsupported-format" } };
  } catch { return { status: "unavailable" }; }
}

/** Opaque bytes never enter the project. The current native session, not this
 * captured directory, is checked by the route before any reference is usable. */
export function toolImageOriginalStore(config: ServerConfig) {
  const root = join(engineStorageDir(config), "tool-image-originals");
  async function privateRoot() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Original image storage must be a private directory.");
    const actual = await realpath(root);
    for (const workspace of config.workspaces) {
      const part = relative(await canonicalFilePath(workspace.directory?.trim() || workspace.path), actual);
      if (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`)) throw new Error("Original image storage must be outside project folders.");
    }
    await chmod(root, 0o700);
    return actual;
  }
  async function privateDirectory(parent: string, name: string) {
    const path = join(parent, name);
    await mkdir(path, { mode: 0o700 }).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("Original image storage cannot follow symbolic links.");
    await chmod(path, 0o700);
    return path;
  }
  const sessionDirectory = async (storageNamespace: string, sessionID: string) => privateDirectory(await privateDirectory(await privateRoot(), sha256(storageNamespace)), sha256(sessionID));
  async function database() {
    const actual = await privateRoot(), path = join(actual, "index.sqlite");
    const before = await lstat(path).catch(error => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; });
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) throw new Error("Original image index must be a private regular file.");
    const db = await openSqlite(path);
    try {
      const after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || await realpath(path) !== path
        || before && (before.dev !== after.dev || before.ino !== after.ino)) throw new Error("Original image index changed while opening it.");
      await chmod(path, 0o600);
      db.exec("CREATE TABLE IF NOT EXISTS tool_image_originals (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, storage_namespace TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, call_id TEXT NOT NULL, ordinal INTEGER NOT NULL, metadata TEXT NOT NULL)");
      if (!db.all("PRAGMA table_info(tool_image_originals)").some(value => value.name === "storage_namespace")) db.exec("ALTER TABLE tool_image_originals ADD COLUMN storage_namespace TEXT NOT NULL DEFAULT 'unverified'");
      db.exec("CREATE INDEX IF NOT EXISTS tool_image_originals_session ON tool_image_originals(session_id,seq)");
      if (db.all("PRAGMA table_info(tool_image_deleted_sessions)").length && !db.all("PRAGMA table_info(tool_image_deleted_sessions)").some(value => value.name === "storage_namespace")) {
        // Old draft tombstones had no proven engine identity. Preserve their
        // table for diagnostics, never treat them as another engine's deletion.
        db.exec("ALTER TABLE tool_image_deleted_sessions RENAME TO tool_image_unverified_draft_deletions");
      }
      db.exec("CREATE TABLE IF NOT EXISTS tool_image_reference_deletions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sha256 TEXT NOT NULL, storage_namespace TEXT NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS tool_image_deleted_sessions (storage_namespace TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(storage_namespace,session_id))");
      return db;
    } catch (error) { db.close(); throw error; }
  }
  function notDeleted(db: SqliteHandle, storageNamespace: string, sessionID: string) {
    if (storageNamespace !== "unverified" && db.get("SELECT session_id FROM tool_image_deleted_sessions WHERE storage_namespace=? AND session_id=?", [storageNamespace, sessionID])) throw missing();
  }
  async function capture(sessionID: string, input: ToolImageCaptureInput, bytes: Uint8Array,
    source: { directory: string; projectID: string; workspaceID: string; linkage: ToolImageOriginal["source"]["linkage"]; storageNamespace?: string }, signal: AbortSignal,
    beforeCommit: () => Promise<void>) {
    signal.throwIfAborted();
    const storageNamespace = source.storageNamespace ?? "unverified";
    const initial = await database(); try { notDeleted(initial, storageNamespace, sessionID); } finally { initial.close(); }
    const id = randomUUID(), directory = await sessionDirectory(storageNamespace, sessionID), temporary = join(directory, `${id}.pending`), destination = join(directory, `${id}.bin`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Original image storage cannot follow symbolic links.");
    let committed = false;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, signal });
      const file = await open(temporary, "r+"); try { await file.sync(); } finally { await file.close(); }
      await beforeCommit(); signal.throwIfAborted();
      await rename(temporary, destination);
      const renamed = await open(destination, "r+"); try { await renamed.sync(); } finally { await renamed.close(); }
      const db = await database();
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          notDeleted(db, storageNamespace, sessionID);
          const previous = z.object({ value: z.number().int().nonnegative().safe() }).parse(db.get("SELECT COALESCE(MAX(ordinal),0) AS value FROM tool_image_originals WHERE storage_namespace=? AND session_id=? AND message_id=? AND call_id=?", [storageNamespace, sessionID, input.messageID, input.callID]));
          const metadata: ToolImageOriginal = { reference: { id, sessionID, sha256: sha256(bytes) }, bytes: bytes.byteLength, mime: input.mime,
            ...(input.name === undefined ? {} : { name: input.name }), header: header(bytes), provenance: "pre-normalization-tool-original",
            source: { messageID: input.messageID, outerCallID: input.callID, tool: input.tool, contentIndex: input.contentIndex, captureOrdinal: previous.value + 1,
              linkage: source.linkage, storageNamespace, capturedDirectory: source.directory, capturedProjectID: source.projectID, capturedWorkspaceID: source.workspaceID, capturedAt: Date.now() } };
          db.run("INSERT INTO tool_image_originals (id,storage_namespace,session_id,message_id,call_id,ordinal,metadata) VALUES (?,?,?,?,?,?,?)", [id, storageNamespace, sessionID, input.messageID, input.callID, metadata.source.captureOrdinal, JSON.stringify(metadata)]);
          db.exec("COMMIT"); committed = true; return metadata;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      } finally { db.close(); }
    } finally {
      await rm(temporary, { force: true });
      if (!committed) await rm(destination, { force: true });
    }
  }
  async function pending(sessionID: string, messageID: string, callID: string) {
    const db = await database();
    try { return db.all("SELECT metadata FROM tool_image_originals WHERE session_id=? AND message_id=? AND call_id=? ORDER BY ordinal", [sessionID, messageID, callID]).map(value => toolImageOriginal.parse(JSON.parse(z.object({ metadata: z.string() }).parse(value).metadata))); }
    finally { db.close(); }
  }
  async function page(sessionID: string, encoded?: string) {
    const db = await database();
    try {
      let after = 0, through: number;
      if (encoded) {
        let payload: unknown;
        try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString()); } catch { throw new ApiError(400, "invalid_original_image_cursor", "Use a cursor returned for this exact image list."); }
        const decoded = cursor.safeParse(payload);
        if (!decoded.success || decoded.data.sessionID !== sessionID) throw new ApiError(400, "invalid_original_image_cursor", "Use a cursor returned for this exact image list.");
        ({ after, through } = decoded.data);
      } else through = z.object({ value: z.number().int().nonnegative().safe() }).parse(db.get("SELECT COALESCE(MAX(seq),0) AS value FROM tool_image_originals WHERE session_id=?", [sessionID])).value;
      // A page bounds metadata work, never total records or original image bytes.
      const records = db.all("SELECT seq,metadata FROM tool_image_originals AS image WHERE session_id=? AND seq>? AND seq<=? AND NOT EXISTS(SELECT 1 FROM tool_image_deleted_sessions AS deleted WHERE deleted.storage_namespace=image.storage_namespace AND deleted.session_id=image.session_id) AND NOT EXISTS(SELECT 1 FROM tool_image_reference_deletions AS deletion WHERE deletion.id=image.id) ORDER BY seq LIMIT 100", [sessionID, after, through]).map(value => row.parse(value));
      const last = records.at(-1)?.seq ?? through;
      return { images: records.map(value => toolImageOriginal.parse(JSON.parse(value.metadata))),
        nextCursor: last < through ? Buffer.from(JSON.stringify({ sessionID, after: last, through })).toString("base64url") : null };
    } finally { db.close(); }
  }
  async function metadata(reference: ToolImageOriginalReference) {
    const db = await database();
    try {
      const value = db.get("SELECT metadata FROM tool_image_originals WHERE id=? AND session_id=?", [reference.id, reference.sessionID]);
      if (!value) throw missing();
      if (db.get("SELECT id FROM tool_image_reference_deletions WHERE id=?", [reference.id])) throw missing();
      const result = toolImageOriginal.parse(JSON.parse(z.object({ metadata: z.string() }).parse(value).metadata));
      notDeleted(db, result.source.storageNamespace, reference.sessionID);
      if (result.reference.sha256 !== reference.sha256) throw missing();
      return result;
    } finally { db.close(); }
  }
  async function read(reference: ToolImageOriginalReference, signal: AbortSignal) {
    const image = await metadata(reference); signal.throwIfAborted();
    const path = join(await sessionDirectory(image.source.storageNamespace, reference.sessionID), `${reference.id}.bin`), before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== path) throw missing();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const after = await file.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile()) throw missing();
      const bytes = await file.readFile(); signal.throwIfAborted();
      if (bytes.byteLength !== image.bytes || sha256(bytes) !== reference.sha256) throw missing();
      return { image, bytes };
    } finally { await file.close(); }
  }
  async function removeSessions(storageNamespace: string, sessionIDs: readonly string[]) {
    if (!storageNamespace || storageNamespace === "unverified") throw new Error("Session-wide image cleanup requires a verified managed engine namespace.");
    // Capture always opens the index before writing. An active capture therefore
    // gets a tombstone; one starting later must recheck the actual native call.
    if (!sessionIDs.length || !await hasIndex()) return;
    const db = await database();
    try {
      for (const sessionID of sessionIDs) {
        // Durable deletion intent also rejects a late capture. A failed removal
        // remains explicit and can be retried without reconstructing history.
        db.run("INSERT OR IGNORE INTO tool_image_deleted_sessions(storage_namespace,session_id) VALUES (?,?)", [storageNamespace, sessionID]);
        await rm(await sessionDirectory(storageNamespace, sessionID), { recursive: true, force: true });
        db.run("DELETE FROM tool_image_originals WHERE storage_namespace=? AND session_id=?", [storageNamespace, sessionID]);
      }
    } finally { db.close(); }
  }
  async function hasIndex() {
    const value = await lstat(join(root, "index.sqlite")).catch(error => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; });
    if (value && (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1)) throw new Error("Original image index must be a private regular file.");
    return value !== undefined;
  }
  async function indexedSessionIDs(storageNamespace: string) {
    if (!await hasIndex()) return [];
    const db = await database();
    try { return db.all("SELECT DISTINCT session_id FROM tool_image_originals WHERE storage_namespace=?", [storageNamespace]).map(value => z.object({ session_id: z.string() }).parse(value).session_id); }
    finally { db.close(); }
  }
  async function deletedSessionIDs(storageNamespace: string) {
    if (!await hasIndex()) return [];
    const db = await database();
    try { return db.all("SELECT session_id FROM tool_image_deleted_sessions WHERE storage_namespace=?", [storageNamespace]).map(value => z.object({ session_id: z.string() }).parse(value).session_id); }
    finally { db.close(); }
  }
  async function retryReferenceDeletions() {
    if (!await hasIndex()) return;
    const db = await database();
    try {
      const deletion = z.object({ id: z.uuid(), session_id: z.string(), sha256: z.string(), storage_namespace: z.string() });
      for (const value of db.all("SELECT id,session_id,sha256,storage_namespace FROM tool_image_reference_deletions")) {
        const item = deletion.parse(value);
        // Exact prior app deletion intent remains authoritative even after the
        // native session is gone or its manual connection is unavailable.
        await rm(join(await sessionDirectory(item.storage_namespace, item.session_id), `${item.id}.bin`), { force: true });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.run("DELETE FROM tool_image_originals WHERE id=? AND session_id=?", [item.id, item.session_id]);
          db.run("DELETE FROM tool_image_reference_deletions WHERE id=?", [item.id]);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    } finally { db.close(); }
  }
  async function removeReferences(references: readonly ToolImageOriginalReference[]) {
    if (!references.length) return;
    const db = await database();
    try {
      for (const reference of references) {
        const row = db.get("SELECT metadata FROM tool_image_originals WHERE id=? AND session_id=?", [reference.id, reference.sessionID]);
        if (!row) continue;
        const image = toolImageOriginal.parse(JSON.parse(z.object({ metadata: z.string() }).parse(row).metadata));
        if (image.reference.sha256 !== reference.sha256) throw missing();
        db.run("INSERT OR IGNORE INTO tool_image_reference_deletions(id,session_id,sha256,storage_namespace) VALUES (?,?,?,?)",
          [reference.id, reference.sessionID, reference.sha256, image.source.storageNamespace]);
      }
    } finally { db.close(); }
    await retryReferenceDeletions();
  }
  return { capture, pending, page, metadata, read, removeSessions, removeReferences, retryReferenceDeletions, hasIndex, indexedSessionIDs, deletedSessionIDs };
}
