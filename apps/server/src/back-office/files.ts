import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeDbPath } from "../runtime-db.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import type { BackOfficeStore } from "./store.js";
import { durableWrite } from "./audit-storage.js";
import { localBackOfficeHistoryPage } from "./history.js";
import { z, canonicalBackOfficeAudit } from "./schema.js";
import {
  BackOfficeFileSchema,
  BackOfficeFilesSchema,
  BACK_OFFICE_FILE_LIMIT,
  BackOfficeRecordSchema,
  type BackOfficeActor,
  type BackOfficeFile,
  type BackOfficeHistoryItem,
} from "./schema.js";

export function fileField(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  recordId: string,
  fieldId: string,
  write = false,
  objectId?: string,
) {
  store.requireAccount(scope, actor);
  const stored = store.raw(scope, recordId);
  const now = new Date().toISOString();
  const record =
    stored ??
    (write && objectId
      ? BackOfficeRecordSchema.parse({
          id: recordId,
          objectId,
          values: {},
          revision: 0,
          schemaRevision: store.model(scope).revision,
          ownerId: actor.userId,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        })
      : null);
  const object = store
    .model(scope)
    .objects.find((item) => item.id === record?.objectId && !item.archived);
  const field = object?.fields.find(
    (item) => item.id === fieldId && item.type === "file",
  );
  if (
    !record ||
    !object ||
    !field ||
    !store.canRead(scope, record, actor) ||
    (field.visibility === "finance" && !actor.finance) ||
    (field.visibility === "private" && record.ownerId !== actor.userId)
  )
    throw new ApiError(
      404,
      "back_office_file",
      "This file field is unavailable.",
    );
  if (write && (!actor.edit || record.archivedAt))
    throw new ApiError(
      403,
      "back_office_file",
      "You cannot attach files to this record.",
    );
  return { record, object, field };
}
export function encryptedFilePath(config: ServerConfig, file: BackOfficeFile, scope: string, keyId: string) {
  return join(
    dirname(runtimeDbPath(config)),
    "back-office-files-v2",
    createHash("sha256").update(scope).digest("hex"),
    keyId,
    file.recordId,
    file.id,
    file.sha256,
  );
}
const associatedData = (scope: string, file: BackOfficeFile) => Buffer.from(canonicalBackOfficeAudit({ domain: "LegalWork.BackOffice.File.v1", scope, file }));
function decryptFile(serialized: string, key: Buffer, scope: string, file: BackOfficeFile) {
  const envelope = z.object({ version: z.literal(1), nonce: z.string(), tag: z.string(), data: z.string() }).strict().parse(JSON.parse(serialized));
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  cipher.setAAD(associatedData(scope, file));
  cipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const bytes = Buffer.concat([cipher.update(Buffer.from(envelope.data, "base64")), cipher.final()]);
  verifyFile(file, bytes);
  return bytes;
}
export function verifyFile(file: BackOfficeFile, bytes: Uint8Array) {
  if (
    bytes.byteLength !== file.size ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new ApiError(
      409,
      "back_office_file",
      "The file content does not match its saved version.",
    );
}
export async function cacheFile(
  config: ServerConfig,
  file: BackOfficeFile,
  bytes: Uint8Array,
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
) {
  verifyFile(file, bytes);
  const { keyId, key } = store.prepareFileManifest(scope, actor, file);
  const path = encryptedFilePath(config, file, scope, keyId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(scope, file));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  durableWrite(path, dirname(path), { version: 1, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") }, true);
  decryptFile(await readFile(path, "utf8"), key, scope, file);
  store.commitFileManifest(scope, actor, file.id, keyId);
}
export async function cachedFile(
  config: ServerConfig,
  file: BackOfficeFile,
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
): Promise<Uint8Array | null> {
  store.requireAccount(scope, actor);
  const manifest = store.fileManifest(scope, file.id);
  if (!manifest || !manifest.ready || canonicalBackOfficeAudit(BackOfficeFileSchema.parse(manifest)) !== canonicalBackOfficeAudit(file)) return null;
  const key = store.journal.storage.fileKey(manifest.keyId);
  if (!key || createHash("sha256").update(key).digest("hex") !== manifest.keyHash) throw new Error("The attachment key is missing or changed. Preserve the data before recovery.");
  try {
    const bytes = decryptFile(await readFile(encryptedFilePath(config, file, scope, manifest.keyId), "utf8"), key, scope, file);
    store.requireAccount(scope, actor);
    return bytes;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
const contentTypes: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};
export async function attachFile(
  config: ServerConfig,
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  recordId: string,
  fieldId: string,
  name: string,
  bytes: Uint8Array,
  objectId?: string,
) {
  fileField(store, scope, actor, recordId, fieldId, true, objectId);
  if (!bytes.byteLength || bytes.byteLength > BACK_OFFICE_FILE_LIMIT)
    throw new ApiError(
      413,
      "back_office_file_size",
      "Choose a non-empty file up to 10 MB.",
    );
  const file = BackOfficeFileSchema.parse({
    id: randomUUID(),
    recordId,
    fieldId,
    name,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType:
      contentTypes[name.split(".").at(-1)?.toLowerCase() ?? ""] ??
      "application/octet-stream",
  });
  await cacheFile(config, file, bytes, store, scope, actor);
  fileField(store, scope, actor, recordId, fieldId, true, objectId);
  return file;
}
export function attachedFile(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  recordId: string,
  fieldId: string,
  fileId: string,
) {
  const { record } = fileField(store, scope, actor, recordId, fieldId);
  const file = BackOfficeFilesSchema.parse(record.values[fieldId] ?? []).find(
    (item) => item.id === fileId,
  );
  if (!file)
    throw new ApiError(
      404,
      "back_office_file",
      "The attachment is unavailable.",
    );
  return file;
}

/** Resolve an exact historic version through the same old/current permission filter as History. */
export function historicalFile(store: BackOfficeStore, scope: string, actor: BackOfficeActor, recordId: string, fieldId: string, fileId: string, eventId: string) {
  store.requireAccount(scope, actor);
  const evidence = localBackOfficeHistoryPage(store, scope, actor, { type: "record", id: recordId }, 100);
  // Select by signed event identity, including histories beyond the first page.
  let page = evidence;
  while (true) {
    const file = fileFromHistory(page.items, recordId, fieldId, fileId, eventId);
    if (file) return file;
    if (!page.nextCursor) break;
    page = localBackOfficeHistoryPage(store, scope, actor, { type: "record", id: recordId }, 100, page.nextCursor);
  }
  throw new ApiError(404, "back_office_file", "This historical attachment is unavailable with your current access.");
}

export function fileFromHistory(items: BackOfficeHistoryItem[], recordId: string, fieldId: string, fileId: string, eventId: string) {
  const item = items.find(item => item.eventId === eventId);
  if (!item) return null;
  for (const value of [item.before, item.after]) {
    const record = BackOfficeRecordSchema.safeParse(value);
    if (!record.success || record.data.id !== recordId) continue;
    const files = BackOfficeFilesSchema.safeParse(record.data.values[fieldId]);
    const file = files.success ? files.data.find(file => file.id === fileId && file.recordId === recordId && file.fieldId === fieldId) : null;
    if (file) return file;
  }
  return null;
}

/** Import pre-encryption copies only for scopes still retaining readable references, then remove the old cache. */
export async function migrateLegacyFiles(config: ServerConfig, store: BackOfficeStore) {
  const directory = join(dirname(runtimeDbPath(config)), "back-office-files");
  try { await readdir(directory); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const scopes = store.db.all("SELECT scope FROM bo_models").map(row => String(row.scope));
  for (const scope of scopes) {
    const actor = scope === "local" ? { userId: "local", edit: true, model: true, finance: true } : store.currentCachedActor(scope);
    if (!actor) continue;
    const files = new Map<string, BackOfficeFile>();
    const collect = (value: unknown): void => {
      if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
        try { const decoded: unknown = JSON.parse(value); collect(decoded); } catch { /* Ordinary field text is not an attachment reference. */ }
        return;
      }
      const file = BackOfficeFileSchema.safeParse(value);
      if (file.success) { files.set(file.data.id, file.data); return; }
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    store.journal.evidence(scope).entries.forEach(entry => collect(entry.payload));
    for (const file of files.values()) {
      const path = join(directory, file.recordId, file.id, file.sha256);
      try { await cacheFile(config, file, await readFile(path), store, scope, actor); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
  }
  await rm(directory, { recursive: true, force: true });
}
