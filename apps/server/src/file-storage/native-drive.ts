import type { StorageEntry, StorageSearch, StorageSearchPage } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import { checkCondition, collectStream, conflict, receiveFile, storagePath, type FileInfo, type FolderReference, type StorageAdapter, type WriteCondition } from "./common.js";

export type DriveItem = {
  id: string; name: string; folder: boolean; parents: string[]; size: number; version: string;
  contentType: string; modifiedAt?: string; webUrl?: string; exported?: boolean; readOnly?: boolean; targetId?: string;
};
export type DriveDriver = {
  root: DriveItem; namespace: string | (() => Promise<string>);
  get: (id: string) => Promise<DriveItem>;
  /** Whole-account file reads use provider-authorized IDs; writes still resolve the full path. */
  readById?: boolean;
  /** Account-wide identity paths can fetch metadata concurrently, then validate every edge in order. */
  parallelMetadata?: boolean;
  children: (id: string, cursor?: string) => Promise<{ items: DriveItem[]; nextCursor?: string; truncated?: boolean }>;
  contains?: (parent: DriveItem, item: DriveItem) => Promise<boolean>;
  lookup?: (parent: DriveItem, name: string) => Promise<DriveItem | null>;
  relativePath?: (item: DriveItem) => Promise<string>;
  searchPath?: (item: DriveItem, input: StorageSearch) => Promise<string>;
  download: (item: DriveItem) => Promise<Response>;
  upload: (parent: DriveItem, name: string, current: DriveItem | null, source: Buffer | string, contentType: string, condition: WriteCondition) => Promise<void>;
  mkdir: (parent: DriveItem, name: string) => Promise<void>;
  copyFile?: (item: DriveItem, parent: DriveItem, name: string) => Promise<void>;
  /** Obtain a provider conditional token for the resolved revision, never a synthetic ETag. */
  conditionalVersion?: (item: DriveItem) => Promise<string>;
  rename: (item: DriveItem, parent: DriveItem, name: string) => Promise<void>;
  remove: (item: DriveItem, version?: string) => Promise<void>;
  search?: (parent: DriveItem, input: StorageSearch) => Promise<{ items: DriveItem[]; nextCursor?: string; truncated?: boolean }>;
  searchScope?: "folder" | "subtree";
};
const missing = () => new ApiError(404, "storage_not_found", "This file or folder is no longer available in the selected drive.");
const ambiguous = () => new ApiError(409, "storage_ambiguous_path", "Several files have this name. Refresh Memory Drive and choose the file by its listed identity.");
/** Paths carry provider IDs; display names remain separate and same-name Google files stay distinct. */
export function nativeSegment(item: Pick<DriveItem, "id" | "name">) {
  const name = item.name.replace(/[\/\\\x00-\x1f\x7f]/g, "_");
  return `~lw~${Buffer.from(item.id).toString("base64url")}~${name}`;
}
function segmentId(value: string) {
  if (!value.startsWith("~lw~")) return undefined;
  const encoded = /^~lw~([A-Za-z0-9_-]+)~/.exec(value)?.[1];
  if (!encoded) throw new ApiError(400, "invalid_storage_path", "Invalid file identity. Refresh Memory Drive.");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded || decoded.length > 1000) throw new ApiError(400, "invalid_storage_path", "Invalid file identity.");
  return decoded.toString();
}
/** The provider identity stays in the remote path, never in a local working-copy filename. */
export function nativeFilename(path: string) {
  const name = storagePath(path, false).split("/").at(-1)!;
  return segmentId(name) ? storagePath(name.replace(/^~lw~[A-Za-z0-9_-]+~/, ""), false) : name;
}
function info(item: DriveItem): FileInfo {
  const usableVersion = /^(?:W\/)?"[^"\r\n]+"$/.test(item.version) && !item.version.startsWith("W/");
  return { size: item.size, version: item.version, contentType: item.contentType, writable: usableVersion && !item.exported && !item.readOnly, exported: item.exported };
}
function requireFile(item: DriveItem) {
  if (item.folder) throw new ApiError(415, "storage_unsupported_file", "Choose a file to open.");
}
function requireVersion(item: DriveItem) {
  if (item.readOnly) throw new ApiError(403, "storage_read_only", "This location or shortcut cannot be changed. Open the original file in its drive.");
  if (!info(item).writable && !item.exported) throw new ApiError(409, "storage_conditional_write_unsupported", "The provider did not supply a safe file version. Refresh before changing this file.");
  if (!/^(?:W\/)?"[^"\r\n]+"$/.test(item.version) || item.version.startsWith("W/")) throw new ApiError(409, "storage_conditional_write_unsupported", "The provider did not supply a safe file version. Refresh before changing this file.");
}
export function nativeDriveAdapter(driver: DriveDriver): StorageAdapter {
  const namespace = async () => typeof driver.namespace === "function" ? driver.namespace() : driver.namespace;
  const conditionalItem = async (item: DriveItem) => {
    if (item.readOnly) requireVersion(item);
    const guarded = driver.conditionalVersion ? { ...item, version: await driver.conditionalVersion(item) } : item;
    requireVersion(guarded);
    return guarded;
  };
  const childrenByName = async (parent: DriveItem, name: string) => {
    let cursor: string | undefined;
    let found: DriveItem | undefined;
    const seen = new Set<string>();
    do {
      const page = await driver.children(parent.id, cursor);
      for (const item of page.items) if (item.name === name) { if (found) throw ambiguous(); found = item; }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new ApiError(502, "storage_invalid_response", "The drive repeated a folder page.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return found ?? await driver.lookup?.(parent, name) ?? null;
  };
  const resolve = async (path: string) => {
    let current = await driver.get(driver.root.id);
    if (!current.folder) throw missing();
    const segments = storagePath(path).split("/").filter(Boolean);
    const identities = driver.parallelMetadata ? segments.map(segmentId) : [];
    const metadata: PromiseSettledResult<DriveItem>[] = [];
    if (driver.parallelMetadata && identities.every(id => id !== undefined)) {
      for (let index = 0; index < identities.length; index += 8)
        metadata.push(...await Promise.allSettled(identities.slice(index, index + 8).map(id => driver.get(id))));
    }
    const seen = new Set([current.id]);
    for (const [index, segment] of segments.entries()) {
      if (!current.folder) throw missing();
      const result = metadata[index];
      if (result?.status === "rejected") throw result.reason;
      const id = identities[index] ?? segmentId(segment);
      const next = result?.status === "fulfilled" ? result.value : id ? await driver.get(id) : await childrenByName(current, segment);
      if (!next || !(driver.contains ? await driver.contains(current, next) : next.parents.includes(current.id))) throw missing();
      if (seen.has(next.id)) throw new ApiError(502, "storage_invalid_response", "The drive returned a folder or shortcut cycle.");
      seen.add(next.id);
      current = next;
    }
    return current;
  };
  const existing = async (path: string) => {
    try { return await resolve(path); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  };
  const readItem = async (path: string) => {
    const parts = storagePath(path, false).split("/");
    const id = driver.readById ? segmentId(parts.at(-1)!) : undefined;
    return id ? driver.get(id) : resolve(path);
  };
  const parentAndName = async (path: string) => {
    const parts = storagePath(path, false).split("/");
    const name = parts.pop()!;
    const parent = await resolve(parts.join("/"));
    if (!parent.folder) throw missing();
    return { parent, name };
  };
  const relativePath = async (item: DriveItem): Promise<string> => {
    if (driver.relativePath) return driver.relativePath(item);
    const parts: string[] = [];
    const seen = new Set<string>();
    let current = item;
    while (current.id !== driver.root.id) {
      if (seen.has(current.id) || parts.length >= 100 || current.parents.length !== 1) throw missing();
      seen.add(current.id); parts.unshift(nativeSegment(current));
      current = await driver.get(current.parents[0]!);
      if (!current.folder) throw missing();
    }
    return parts.join("/");
  };
  const entry = (item: DriveItem, path: string): StorageEntry => ({
    id: item.id, name: item.name, path, kind: item.folder ? "folder" : "file", size: item.folder ? null : item.size,
    modifiedAt: item.modifiedAt ?? null, version: item.version, ...(item.webUrl ? { webUrl: item.webUrl } : {}), ...(item.exported ? { exported: true } : {}),
  });
  const upload = async (path: string, source: Buffer | string, type: string, condition: WriteCondition) => {
    const { parent, name } = await parentAndName(path);
    const current = await existing(path);
    checkCondition(current ? info(current) : null, condition);
    if (current?.folder) conflict();
    if (current?.readOnly) requireVersion(current);
    if (current?.exported) throw new ApiError(403, "storage_export_read_only", "This is an exported Google document. Save a separate Office or workspace copy; the native document cannot be replaced with exported bytes.");
    if (current) { requireVersion(current); if (!condition.version) conflict(); }
    if (!current && segmentId(name)) throw missing();
    await driver.upload(parent, current?.name ?? name, current, source, type, condition);
  };
  return {
    async findEntry(path, kind) {
      const item = await existing(path);
      if (!item || (kind && kind !== (item.folder ? "folder" : "file"))) return null;
      return entry(item, path);
    },
    async list(path, cursor) {
      const folder = await resolve(path);
      if (!folder.folder) throw missing();
      const page = await driver.children(folder.id, cursor);
      return { entries: page.items.map((item) => entry(item, [path, nativeSegment(item)].filter(Boolean).join("/"))), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.truncated ? { truncated: true } : {}) };
    },
    async folderReference(path) {
      const item = await resolve(path);
      if (!item.folder) throw missing();
      return { path: await relativePath(item), id: item.id, name: item.name, namespace: await namespace() };
    },
    async resolveFolder(reference: FolderReference) {
      if (!reference.id || reference.namespace !== await namespace()) throw new ApiError(409, "storage_namespace_changed", "The folder's account or drive changed. Relink the folder.");
      const item = await driver.get(reference.id);
      if (!item.folder) throw missing();
      return relativePath(item);
    },
    searchCapabilities: async () => ({ modes: driver.search ? ["name", "content"] : [], pagination: true, scope: driver.searchScope ?? "folder" }),
    ...(driver.search ? { async search(input: StorageSearch): Promise<StorageSearchPage> {
      if (input.mode === "path_prefix") throw new ApiError(400, "storage_search_unsupported", "Use name or content search for this drive.");
      const page = await driver.search!(await resolve(input.path), input);
      const entries: StorageEntry[] = [];
      for (const item of page.items) {
        const path = driver.searchPath ? await driver.searchPath(item, input) : await relativePath(item);
        if (input.path && !path.startsWith(`${input.path}/`)) continue;
        entries.push(entry(item, path));
      }
      return { entries, nextCursor: page.nextCursor, truncated: page.truncated, scope: driver.searchScope ?? "folder", path: input.path };
    } } : {}),
    async stat(path) { const item = await existing(path); return item && !item.folder ? info(item) : null; },
    async read(path) {
      const item = await readItem(path); requireFile(item);
      const response = await driver.download(item);
      if (!response.body) throw new ApiError(502, "storage_invalid_response", "The provider returned no file content.");
      const data = await collectStream(response.body);
      const after = await readItem(path); if (after.version !== item.version || after.targetId !== item.targetId) conflict();
      return { ...info(item), size: data.length, data };
    },
    async download(path, destination) {
      const item = await readItem(path); requireFile(item);
      const response = await driver.download(item);
      if (!response.body) throw new ApiError(502, "storage_invalid_response", "The provider returned no file content.");
      const result = await receiveFile(response.body, destination);
      const after = await readItem(path); if (after.version !== item.version || after.targetId !== item.targetId) conflict();
      return { ...info(item), ...result };
    },
    write: upload, upload,
    ...(driver.copyFile ? { async copyFile(path: string, destination: string) {
      const item = await resolve(path); requireFile(item);
      const { parent, name } = await parentAndName(destination);
      if (segmentId(name)) throw new ApiError(400, "invalid_storage_name", "Use a destination filename, not an existing file identity.");
      if (await childrenByName(parent, name)) conflict();
      await driver.copyFile!(item, parent, name);
    } } : {}),
    async mkdir(path) {
      const { parent, name } = await parentAndName(path);
      if (segmentId(name)) throw new ApiError(400, "invalid_storage_name", "Use a new folder name, not an existing folder identity.");
      if (await childrenByName(parent, name)) conflict();
      await driver.mkdir(parent, name);
    },
    async rename(path, destination, kind) {
      const item = await resolve(path); const { parent, name } = await parentAndName(destination);
      if ((item.folder ? "folder" : "file") !== kind) throw missing();
      if (await childrenByName(parent, name)) conflict();
      if (parent.id === item.id || (item.folder && (await relativePath(parent)).startsWith(`${await relativePath(item)}/`))) conflict();
      await driver.rename(await conditionalItem(item), parent, name);
    },
    async deleteFile(path, condition = {}) {
      const item = await resolve(path); requireFile(item); checkCondition(info(item), condition);
      const guarded = await conditionalItem(item);
      await driver.remove(guarded, guarded.version);
    },
    async deleteFolder(path, recursive = false) {
      storagePath(path, false); const item = await resolve(path); if (!item.folder) throw missing();
      if (!recursive) { const page = await driver.children(item.id); if (page.items.length || page.nextCursor) conflict(); }
      const guarded = await conditionalItem(item);
      await driver.remove(guarded, guarded.version);
    },
  };
}
