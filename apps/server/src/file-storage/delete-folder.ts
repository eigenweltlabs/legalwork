import type { StorageEntry } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import { storagePath, type StorageAdapter } from "./common.js";

/** Snapshot every page before deleting, since offset-based pages shift after a deletion. */
export async function deleteFolderTree(adapter: Pick<StorageAdapter, "list" | "deleteFile">, path: string, removeEmpty: (path: string) => Promise<void>) {
  storagePath(path, false);
  if (!adapter.deleteFile) throw new ApiError(400, "storage_delete_unsupported", "This connection does not support deleting files.");
  const entries: StorageEntry[] = [];
  const folders = [path];
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const children = new Set<string>();
    do {
      const page = await adapter.list(folder, cursor);
      for (const item of page.entries) {
        storagePath(item.path, false);
        if (item.path.split("/").slice(0, -1).join("/") !== folder || children.has(item.path))
          throw new ApiError(502, "storage_invalid_response", "Storage returned an invalid folder listing.");
        children.add(item.path);
        entries.push(item);
        if (item.kind === "folder") folders.push(item.path);
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ApiError(502, "storage_invalid_response", "Storage repeated a folder page.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  // Only remove empty directories. Files added after the snapshot stop removal.
  for (const item of entries) if (item.kind === "file") await adapter.deleteFile(item.path);
  for (const folder of folders.reverse()) await removeEmpty(folder);
}
