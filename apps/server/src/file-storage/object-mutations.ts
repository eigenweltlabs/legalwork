import { ApiError } from "../errors.js";
import { conflict, storagePath, type StorageAdapter } from "./common.js";

export type StoredObject = { path: string; version: string };
type Objects = {
  list(prefix: string): Promise<StoredObject[]>;
  stat(path: string): Promise<StoredObject | null>;
  copy(source: StoredObject, destination: string): Promise<void>;
  remove(source: StoredObject): Promise<void>;
};

/** Object stores have prefixes, not directories. Never delete until every copy succeeds. */
export function objectMutations(objects: Objects): Pick<StorageAdapter, "rename" | "deleteFile" | "deleteFolder"> {
  return {
    async deleteFolder(path) {
      const prefix = `${storagePath(path, false)}/`;
      const originals = await objects.list(prefix);
      if (!originals.length) throw new ApiError(404, "storage_not_found", "Folder not found.");
      if (originals.some((item) => !item.path.startsWith(prefix)))
        throw new ApiError(502, "storage_invalid_response", "Storage returned an invalid folder listing.");
      // Preserve a concurrent edit instead of deleting a newer object version.
      for (const object of originals) await objects.remove(object);
      if ((await objects.list(prefix)).length)
        throw new ApiError(409, "storage_folder_changed", "The folder changed while being deleted. Refresh to see the remaining files.");
    },
    async deleteFile(path) {
      const source = await objects.stat(path);
      if (!source) throw new ApiError(404, "storage_not_found", "File not found.");
      await objects.remove(source);
    },
    async rename(path, destination, kind) {
      if (await objects.stat(destination) || (await objects.list(`${destination}/`)).length) conflict();
      const source = kind === "file" ? await objects.stat(path) : null;
      const originals = kind === "file" ? (source ? [source] : []) : await objects.list(`${path}/`);
      if (!originals.length) throw new ApiError(404, "storage_not_found", "File or folder not found.");
      let copied = 0;
      try {
        for (const object of originals) {
          await objects.copy(object, destination + object.path.slice(path.length));
          copied++;
        }
        // Detect changes during a long folder copy before removing any originals.
        const current = kind === "folder" ? await objects.list(`${path}/`) : [await objects.stat(path)];
        const versions = new Map(current.flatMap((item) => item ? [[item.path, item.version]] : []));
        if (versions.size !== originals.length || originals.some((item) => versions.get(item.path) !== item.version)) conflict();
        for (const object of originals) await objects.remove(object);
      } catch (error) {
        if (!copied) throw error;
        // No rollback deletion: a destination may already have been edited by another client.
        throw new ApiError(409, "storage_rename_incomplete", "The rename did not finish. Files may exist under both names. Refresh both locations and inspect them before retrying; do not delete either copy automatically.");
      }
    },
  };
}
