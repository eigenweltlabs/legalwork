import type { LegalMemoryTreeFile, LegalworkServerClient } from "./legalwork-server";

export const LEGALMEMORY_FILE_DRAG_TYPE = "application/x-legalwork-legalmemory-file";

export type LegalMemoryFileDragItem = Pick<
  LegalMemoryTreeFile,
  "document_id" | "name" | "path" | "source_id" | "source_object_id"
>;

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
    : new Error("The downloaded LegalMemory file is not ready yet.");
}
