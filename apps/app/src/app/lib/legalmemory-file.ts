import type { LegalMemoryTreeFile, LegalMemoryTreeFolder, LegalworkServerClient } from "./legalwork-server";
import { t } from "@/i18n";

export const LEGALMEMORY_FILE_DRAG_TYPE = "application/x-legalwork-legalmemory-file";
export const LEGALMEMORY_FOLDER_DRAG_TYPE = "application/x-legalwork-legalmemory-folder";

export type LegalMemoryFileDragItem = Pick<
  LegalMemoryTreeFile,
  "document_id" | "name" | "path" | "source_id" | "source_object_id"
>;

export type LegalMemoryFolderDragItem = {
  name: string;
  /** Tree path of the folder, in whatever shape its source uses. */
  path: string;
  source_id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasLegalMemoryFileDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(LEGALMEMORY_FILE_DRAG_TYPE);
}

export function writeLegalMemoryFileDrag(dataTransfer: DataTransfer, file: LegalMemoryTreeFile): void {
  const item: LegalMemoryFileDragItem = {
    document_id: file.document_id,
    name: file.name,
    path: file.path,
    source_id: file.source_id,
    source_object_id: file.source_object_id,
  };
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(LEGALMEMORY_FILE_DRAG_TYPE, JSON.stringify(item));
  dataTransfer.setData("text/plain", `legalmemory://document/${encodeURIComponent(file.document_id)}`);
}

export function readLegalMemoryFileDrag(dataTransfer: DataTransfer): LegalMemoryFileDragItem | null {
  const raw = dataTransfer.getData(LEGALMEMORY_FILE_DRAG_TYPE);
  if (!raw) return null;
  try {
    const item: unknown = JSON.parse(raw);
    if (!isRecord(item)) return null;
    const documentId = item.document_id;
    const name = item.name;
    const path = item.path;
    const sourceId = item.source_id;
    const sourceObjectId = item.source_object_id;
    if (
      typeof documentId !== "string" ||
      typeof name !== "string" ||
      typeof path !== "string" ||
      typeof sourceId !== "string" ||
      typeof sourceObjectId !== "string"
    ) return null;
    return {
      document_id: documentId,
      name,
      path,
      source_id: sourceId,
      source_object_id: sourceObjectId,
    };
  } catch {
    return null;
  }
}

export function hasLegalMemoryFolderDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(LEGALMEMORY_FOLDER_DRAG_TYPE);
}

export function writeLegalMemoryFolderDrag(
  dataTransfer: DataTransfer,
  sourceId: string,
  folder: LegalMemoryTreeFolder,
): void {
  const item: LegalMemoryFolderDragItem = {
    name: folder.name,
    path: folder.path,
    source_id: sourceId,
  };
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(LEGALMEMORY_FOLDER_DRAG_TYPE, JSON.stringify(item));
  dataTransfer.setData("text/plain", folder.name);
}

export function readLegalMemoryFolderDrag(dataTransfer: DataTransfer): LegalMemoryFolderDragItem | null {
  const raw = dataTransfer.getData(LEGALMEMORY_FOLDER_DRAG_TYPE);
  if (!raw) return null;
  try {
    const item: unknown = JSON.parse(raw);
    if (!isRecord(item)) return null;
    const name = item.name;
    const path = item.path;
    const sourceId = item.source_id;
    if (typeof name !== "string" || typeof path !== "string" || typeof sourceId !== "string") return null;
    return { name, path, source_id: sourceId };
  } catch {
    return null;
  }
}

/**
 * Copy every document under a LegalMemory folder into the workspace in one
 * server call. Unlike a single file there is nothing to poll for: the mention
 * references the folder, and the agent lists it when it reads.
 */
export async function materializeLegalMemoryFolder(
  client: LegalworkServerClient,
  workspaceId: string,
  folder: LegalMemoryFolderDragItem,
) {
  return client.legalMemoryOpenFolder(workspaceId, {
    source_id: folder.source_id,
    path: folder.path,
    name: folder.name,
  });
}

/**
 * Pull an authorized LegalMemory original into the workspace and wait until the
 * normal workspace-file reader can see it. The short readiness poll prevents
 * the artifact panel from caching a transient miss immediately after export.
 */
export async function materializeLegalMemoryFile(
  client: LegalworkServerClient,
  workspaceId: string,
  documentId: string,
) {
  const result = await client.legalMemoryOpen(workspaceId, { document_id: documentId });
  let readinessError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await client.downloadWorkspaceFile(workspaceId, result.path);
      return result;
    } catch (error) {
      readinessError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
  }
  throw readinessError instanceof Error
    ? readinessError
    : new Error(t("legalmemory.file_not_ready"));
}
