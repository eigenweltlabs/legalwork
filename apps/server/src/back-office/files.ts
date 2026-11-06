import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeDbPath } from "../runtime-db.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import type { BackOfficeStore } from "./store.js";
import {
  BackOfficeFileSchema,
  BackOfficeFilesSchema,
  BACK_OFFICE_FILE_LIMIT,
  BackOfficeRecordSchema,
  type BackOfficeActor,
  type BackOfficeFile,
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
function filePath(config: ServerConfig, file: BackOfficeFile) {
  return join(
    dirname(runtimeDbPath(config)),
    "back-office-files",
    file.recordId,
    file.id,
    file.sha256,
  );
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
) {
  verifyFile(file, bytes);
  const path = filePath(config, file);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    verifyFile(file, await readFile(path));
  }
}
export async function cachedFile(
  config: ServerConfig,
  file: BackOfficeFile,
): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(filePath(config, file));
    verifyFile(file, bytes);
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
  await cacheFile(config, file, bytes);
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
