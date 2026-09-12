import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform, Writable } from "node:stream";
import type {
  StorageEntry,
  StoragePage,
  StorageSearch,
  StorageSearchPage,
  StorageCapabilities,
} from "@legalwork/types/file-storage";
import { STORAGE_MAX_FILE_BYTES, STORAGE_PAGE_SIZE } from "./schema.js";
import { ApiError } from "../errors.js";

export type FileInfo = { size: number; version: string; contentType?: string; writable?: boolean; name?: string };
export type FileData = FileInfo & { data: Buffer };
export type DownloadedFile = FileInfo & { sha256: string };
export type WriteCondition = { version?: string; createOnly?: boolean };
export interface StorageAdapter {
  list(path: string, cursor?: string): Promise<StoragePage>;
  /** Flat metadata listing for object stores; avoids walking virtual folders. */
  listFiles?(path: string, cursor?: string, signal?: AbortSignal): Promise<StoragePage>;
  searchCapabilities?(): Promise<StorageCapabilities["search"]>;
  search?(input: StorageSearch): Promise<StorageSearchPage>;
  stat(path: string): Promise<FileInfo | null>;
  read(path: string): Promise<FileData>;
  download(path: string, destination?: string): Promise<DownloadedFile>;
  write(path: string, data: Buffer, contentType: string, condition: WriteCondition): Promise<void>;
  upload(path: string, source: string, contentType: string, condition: WriteCondition): Promise<void>;
  mkdir(path: string): Promise<void>;
  close?(): Promise<void>;
}

export function storagePath(value: string, allowRoot = true): string {
  if (value === "" && allowRoot) return "";
  if (
    !value ||
    value.length > 4096 ||
    /[\\\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ApiError(
      400,
      "invalid_storage_path",
      "Use a relative path without empty segments, traversal, backslashes, or control characters.",
    );
  }
  return value;
}

export function objectPrefix(prefix: string) {
  const clean = prefix.replace(/\/+$/, "");
  return clean ? `${storagePath(clean)}/` : "";
}

export function entry(
  path: string,
  kind: "file" | "folder",
  size: number | null = null,
  modifiedAt: string | null = null,
): StorageEntry {
  return { path: storagePath(path, false), name: path.split("/").at(-1)!, kind, size, modifiedAt };
}

export function pageEntries(entries: StorageEntry[], cursor?: string): StoragePage {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new ApiError(400, "invalid_storage_cursor", "Invalid folder page.");
  const sorted = entries.sort(
    (a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || a.name.localeCompare(b.name),
  );
  return {
    entries: sorted.slice(offset, offset + STORAGE_PAGE_SIZE),
    ...(offset + STORAGE_PAGE_SIZE < sorted.length ? { nextCursor: String(offset + STORAGE_PAGE_SIZE) } : {}),
  };
}

export function ensureFileSize(size: number) {
  if (size > STORAGE_MAX_FILE_BYTES)
    throw new ApiError(
      413,
      "storage_file_too_large",
      "This file is too large for an inline response. Open a workspace copy or use a streaming transfer.",
    );
}

export function boundedSink() {
  const chunks: Buffer[] = [];
  let size = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > STORAGE_MAX_FILE_BYTES)
        return callback(
          new ApiError(
            413,
            "storage_file_too_large",
            "This file is too large for an inline response. Open a workspace copy instead.",
          ),
        );
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { sink, data: () => Buffer.concat(chunks) };
}

export async function collectStream(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const data = Buffer.from(chunk);
      size += data.length;
      ensureFileSize(size);
      chunks.push(data);
    }
    return Buffer.concat(chunks);
  } finally {
    if (stream instanceof Readable) stream.destroy();
  }
}

export const hashVersion = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Both callback-based protocols and Node streams share the same bounded sink. */
export async function receiveWith(produce: (sink: Writable) => Promise<unknown>, destination?: string) {
  const hash = createHash("sha256");
  let size = 0;
  let created = false;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const sink = destination
    ? createWriteStream(destination, { flags: "wx", mode: 0o600 })
    : new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
  sink.once("open", () => {
    created = true;
  });
  const completed = pipeline(meter, sink);
  // Attach a handler before the producer starts so early disk failures are observed.
  completed.catch(() => undefined);
  try {
    await produce(meter);
    meter.end();
    await completed;
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    meter.destroy(error instanceof Error ? error : new Error("Transfer failed"));
    await completed.catch(() => undefined);
    if (created && destination) await unlink(destination).catch(() => undefined);
    throw error;
  }
}
export const receiveFile = (stream: AsyncIterable<Uint8Array | string>, destination?: string) =>
  receiveWith((sink) => pipeline(stream, sink), destination);
export const sourceStream = (source: Buffer | string) =>
  typeof source === "string" ? createReadStream(source) : Readable.from(source);
export const sourceSize = async (source: Buffer | string) =>
  typeof source === "string" ? (await stat(source)).size : source.length;
export function conflict(): never {
  throw new ApiError(
    409,
    "storage_conflict",
    "This file already exists or changed since you opened it. Reload it before saving, or upload under a different name.",
  );
}
export function checkCondition(info: FileInfo | null, condition: WriteCondition) {
  if ((condition.createOnly && info) || (condition.version && info?.version !== condition.version)) conflict();
}

export function providerError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const record = typeof error === "object" && error !== null ? error : {};
  const status =
    "statusCode" in record
      ? record.statusCode
      : "status" in record
        ? record.status
        : "code" in record
          ? record.code
          : undefined;
  const metadata =
    "$metadata" in record && typeof record.$metadata === "object" && record.$metadata !== null ? record.$metadata : {};
  const httpStatus =
    "httpStatusCode" in metadata
      ? metadata.httpStatusCode
      : "code" in record && typeof record.code === "string" && record.code.startsWith("E")
        ? record.code
        : status;
  if (["409", "412", "EEXIST", "PreconditionFailed"].includes(String(httpStatus)))
    return new ApiError(
      409,
      "storage_conflict",
      "The file or folder already exists or has changed. Reload before saving.",
    );
  if (["404", "ENOENT", "NoSuchKey", "NotFound", "2", "550"].includes(String(httpStatus)))
    return new ApiError(404, "storage_not_found", "The file or folder was not found, or access was denied.");
  if (["401", "403", "EACCES", "EPERM", "AccessDenied", "AuthenticationFailed", "530"].includes(String(httpStatus)))
    return new ApiError(
      403,
      "storage_access_denied",
      "Storage access was denied. Check the credentials and permissions in Integrations.",
    );
  // Provider messages can include signed URLs, passwords, or service-account JSON.
  return new ApiError(
    502,
    "storage_unavailable",
    "Could not connect to this storage or complete the request. Check the address, sign-in details, connection fingerprint, and folder permissions, then retry.",
  );
}

export async function missingAsNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (providerError(error).status === 404) return null;
    throw error;
  }
}

export function unsupportedSearch(): never {
  throw new ApiError(
    400,
    "storage_search_unsupported",
    "This connection does not support that search mode. Check its capabilities or browse folders instead.",
  );
}

/** Prefix queries may end in /, but cannot escape the selected folder/root. */
export function searchPrefix(input: StorageSearch): string {
  const query = input.query.replace(/\/$/, "");
  storagePath(query, false);
  return (input.path ? `${input.path}/` : "") + input.query;
}
