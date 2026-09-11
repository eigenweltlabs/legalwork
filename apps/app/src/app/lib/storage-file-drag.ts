import type { LegalworkServerClient } from "./legalwork-server";
import type { StorageEntry, StorageRoot, StorageWorkingCopy } from "@legalwork/types/file-storage";

/**
 * Drag payload for a file that lives in a connected storage root (S3, SMB,
 * WebDAV, ...). Kept separate from the LegalMemory drag type because a raw
 * storage object has no LegalMemory document id: it is addressed by its
 * connection plus a path, and only becomes readable once checked out.
 */
export const STORAGE_FILE_DRAG_TYPE = "application/x-legalwork-storage-file";

export type StorageFileDragItem = {
  connectionId: string;
  connectionName: string;
  path: string;
  name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasStorageFileDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(STORAGE_FILE_DRAG_TYPE);
}

export function writeStorageFileDrag(dataTransfer: DataTransfer, root: StorageRoot, entry: StorageEntry): void {
  const item: StorageFileDragItem = {
    connectionId: root.id,
    connectionName: root.name,
    path: entry.path,
    name: entry.name,
  };
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(STORAGE_FILE_DRAG_TYPE, JSON.stringify(item));
  dataTransfer.setData("text/plain", entry.path);
}

export function readStorageFileDrag(dataTransfer: DataTransfer): StorageFileDragItem | null {
  const raw = dataTransfer.getData(STORAGE_FILE_DRAG_TYPE);
  if (!raw) return null;
  try {
    const item: unknown = JSON.parse(raw);
    if (!isRecord(item)) return null;
    const { connectionId, connectionName, path, name } = item;
    if (
      typeof connectionId !== "string" ||
      typeof connectionName !== "string" ||
      typeof path !== "string" ||
      typeof name !== "string" ||
      !connectionId ||
      !path
    ) return null;
    return { connectionId, connectionName, path, name };
  } catch {
    return null;
  }
}

/**
 * Check the storage object out into the workspace and wait until the ordinary
 * workspace-file reader can see it, so the mention we insert resolves to a real
 * local path instead of a transient miss. Mirrors materializeLegalMemoryFile.
 */
export async function materializeStorageFile(
  client: LegalworkServerClient,
  workspaceId: string,
  item: StorageFileDragItem,
): Promise<StorageWorkingCopy> {
  const copy = await client.checkoutStorageFile(workspaceId, item.connectionId, item.path);
  let readinessError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await client.downloadWorkspaceFile(workspaceId, copy.localPath);
      return copy;
    } catch (error) {
      readinessError = error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
    }
  }
  throw readinessError instanceof Error ? readinessError : new Error(copy.localPath);
}
