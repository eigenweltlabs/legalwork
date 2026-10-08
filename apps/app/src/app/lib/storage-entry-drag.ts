import type { StorageEntry, StorageRoot } from "@legalwork/types/file-storage";
import { writeStorageFileDrag } from "./storage-file-drag";

export const STORAGE_ENTRY_DRAG_TYPE = "application/x-legalwork-storage-entry";
const scopeType = (workspaceId: string) => `application/x-legalwork-storage-entry-${encodeURIComponent(workspaceId).toLowerCase()}`;
export function hasStorageEntryDragForWorkspace(data: Pick<DataTransfer, "types">, workspaceId: string) {
  return data.types.includes(STORAGE_ENTRY_DRAG_TYPE) && data.types.includes(scopeType(workspaceId));
}
export type StorageEntryDragItem = {
  workspaceId: string;
  connectionId: string;
  path: string;
  kind: "file" | "folder";
  writable: boolean;
};

export function hasStorageEntryDrag(data: DataTransfer) {
  return Array.from(data.types).includes(STORAGE_ENTRY_DRAG_TYPE);
}

export function writeStorageEntryDrag(data: DataTransfer, workspaceId: string, root: StorageRoot, entry: StorageEntry): StorageEntryDragItem {
  const item: StorageEntryDragItem = { workspaceId, connectionId: root.id, path: entry.path, kind: entry.kind, writable: root.writable };
  if (entry.kind === "file") writeStorageFileDrag(data, root, entry);
  data.effectAllowed = "copy";
  data.setData(STORAGE_ENTRY_DRAG_TYPE, JSON.stringify(item));
  data.setData(scopeType(workspaceId), workspaceId);
  data.setData("text/plain", entry.path);
  return item;
}

export function readStorageEntryDrag(data: DataTransfer): StorageEntryDragItem | null {
  try {
    const item: unknown = JSON.parse(data.getData(STORAGE_ENTRY_DRAG_TYPE));
    if (!item || typeof item !== "object" || !("workspaceId" in item) || !("connectionId" in item) || !("path" in item) || !("kind" in item) || !("writable" in item)) return null;
    const { workspaceId, connectionId, path, kind, writable } = item;
    if (typeof workspaceId !== "string" || !workspaceId || typeof connectionId !== "string" || !connectionId ||
      typeof path !== "string" || !path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") ||
      (kind !== "file" && kind !== "folder") || typeof writable !== "boolean") return null;
    return { workspaceId, connectionId, path, kind, writable };
  } catch {
    return null;
  }
}

export function canDropStorageEntry(item: StorageEntryDragItem, workspaceId: string, root: StorageRoot, folder: string) {
  if (!root.writable || item.workspaceId !== workspaceId) return false;
  if (root.id !== item.connectionId) return true;
  const destination = folder ? `${folder}/${item.path.split("/").at(-1)}` : item.path.split("/").at(-1);
  return destination !== item.path && (item.kind !== "folder" || (folder !== item.path && !folder.startsWith(`${item.path}/`)));
}
