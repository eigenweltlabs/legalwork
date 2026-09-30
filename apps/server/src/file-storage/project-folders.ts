import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { StorageInput, StoragePage } from "@legalwork/types/file-storage";
import type { ProjectRemoteFolder } from "@legalwork/types/workspace";
import { ApiError } from "../errors.js";
import { findEntry, storagePath, type FolderReference, type StorageAdapter } from "./common.js";

/** A scope is attached only after the server resolves a reference against this member's connection. */
export const projectFolderScopes = new WeakMap<StorageInput, FolderReference>();
export function connectionFingerprint(input: StorageInput) {
  // A digest of the connection's namespace, never its authentication material.
  const { config } = input;
  const identity = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "accessKeyId").sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
export async function captureFolder(adapter: StorageAdapter, path: string, rootName: string): Promise<FolderReference> {
  storagePath(path);
  if (adapter.folderReference) return adapter.folderReference(path);
  if (path) {
    const entry = await findEntry(adapter, path, "folder");
    if (!entry) throw new ApiError(404, "storage_not_found", "The folder is missing or you no longer have access.");
    return { path, name: entry.name };
  }
  await adapter.list("");
  return { path: "", name: rootName };
}
export async function resolveFolder(adapter: StorageAdapter, folder: FolderReference) {
  if (adapter.resolveFolder) return storagePath(await adapter.resolveFolder(folder));
  if (folder.id) throw new ApiError(409, "storage_reference_unsupported", "This connection cannot resolve the folder's native identity.");
  return (await captureFolder(adapter, folder.path, folder.name)).path;
}

/** A linked location is a read-only virtual root. Provider paths never escape into project logic. */
export async function scopedFolderAdapter(adapter: StorageAdapter, reference: FolderReference): Promise<StorageAdapter> {
  const root = await resolveFolder(adapter, reference);
  const full = (path: string) => [root, storagePath(path)].filter(Boolean).join("/");
  const page = <T extends StoragePage>(value: T, scope: string): T => ({ ...value, entries: value.entries.flatMap((entry) => {
    if (scope && !entry.path.startsWith(`${scope}/`)) return [];
    const path = root ? entry.path.slice(root.length + 1) : entry.path;
    storagePath(path, false);
    return [{ ...entry, path }];
  }) });
  const denied = async (): Promise<never> => { throw new ApiError(403, "storage_read_only", "Project folder links are read-only references. Manage files in their source storage."); };
  return {
    list: async (path, cursor) => page(await adapter.list(full(path), cursor), full(path)),
    ...(adapter.listFiles ? { listFiles: async (path: string, cursor?: string, signal?: AbortSignal) => page(await adapter.listFiles!(full(path), cursor, signal), full(path)) } : {}),
    ...(adapter.searchCapabilities ? { searchCapabilities: () => adapter.searchCapabilities!() } : {}),
    ...(adapter.search ? { search: async (input) => ({ ...page(await adapter.search!({ ...input, path: full(input.path) }), full(input.path)), path: input.path }) } : {}),
    stat: (path) => adapter.stat(full(path)),
    read: (path) => adapter.read(full(path)),
    download: (path, destination) => adapter.download(full(path), destination),
    write: denied, upload: denied, mkdir: denied,
  };
}

const bindingSchema = z.object({ workspaceId: z.string(), folderId: z.string().uuid(), sourceWorkspaceId: z.string(), connectionId: z.string(), referenceKey: z.string() });
function referenceKey(folder: ProjectRemoteFolder) {
  return createHash("sha256").update(JSON.stringify([folder.connectionFingerprint, folder.folder.namespace, folder.folder.id ?? folder.folder.path])).digest("hex");
}
/** Device-local authorization selected by the user, never inside project.json or team sync. */
export class ProjectFolderBindings {
  private pending = Promise.resolve();
  readonly path: string;
  constructor(storagePath: string) { this.path = join(dirname(storagePath), "project-folder-bindings.json"); }
  private async all() {
    try { return z.array(bindingSchema).parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new ApiError(500, "storage_bindings_unreadable", "Local folder connections could not be read.");
    }
  }
  async source(workspaceId: string, folder: ProjectRemoteFolder) {
    return (await this.all()).find((binding) => binding.workspaceId === workspaceId && binding.folderId === folder.id && binding.connectionId === folder.connectionId && binding.referenceKey === referenceKey(folder))?.sourceWorkspaceId;
  }
  async save(workspaceId: string, folder: ProjectRemoteFolder, sourceWorkspaceId: string) {
    const operation = this.pending.catch(() => undefined).then(async () => {
      const values = (await this.all()).filter((binding) => binding.workspaceId !== workspaceId || binding.folderId !== folder.id);
      values.push({ workspaceId, folderId: folder.id, sourceWorkspaceId, connectionId: folder.connectionId, referenceKey: referenceKey(folder) });
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(values), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.pending = operation;
    return operation;
  }
}
