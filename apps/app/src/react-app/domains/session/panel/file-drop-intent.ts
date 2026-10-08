import { hasProjectFileDrag, projectFileDragBelongsHere } from "@/app/lib/project-file-drag";
import { WORKSPACE_FILE_DRAG_TYPE } from "@/app/lib/workspace-file-drag";
import { STORAGE_FILE_DRAG_TYPE } from "@/app/lib/storage-file-drag";
import { hasStorageEntryDragForWorkspace } from "@/app/lib/storage-entry-drag";

/** Explicit attachment/folder controls take priority over opening a workspace tab. */
export function isFileIntakeTarget(kind: string | undefined, data: Pick<DataTransfer, "types">, projectId?: string | null) {
  if (kind === undefined) return false;
  if (kind === "composer") return true;
  // Legacy intake can use an own-project single-file payload, never interpret a
  // foreign relative path or quietly import only the first file of a batch.
  if (hasProjectFileDrag(data) && (!projectId || !projectFileDragBelongsHere(data, projectId))) return false;
  if (kind.startsWith("storage:")) return hasStorageEntryDragForWorkspace(data, kind.slice(8)) || data.types.includes("Files");
  if (kind === "review") return data.types.includes(WORKSPACE_FILE_DRAG_TYPE) || data.types.includes(STORAGE_FILE_DRAG_TYPE) || !hasProjectFileDrag(data);
  if (kind === "task") return data.types.includes(STORAGE_FILE_DRAG_TYPE) || data.types.includes("Files");
  return false;
}
