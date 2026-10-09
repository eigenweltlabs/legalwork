import { hasProjectFileDrag, readProjectFilesDrag } from "@/app/lib/project-file-drag";
import { projectFileTab } from "../../workspace/project-file-tab";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { hasWorkspaceFileDrag, readWorkspaceFileDrag } from "@/app/lib/workspace-file-drag";
import { hasStorageFileDrag, readStorageFileDrag } from "@/app/lib/storage-file-drag";
import { hasLegalMemoryFileDrag, readLegalMemoryFileDrag, materializeLegalMemoryFile } from "@/app/lib/legalmemory-file";
import { t } from "@/i18n";
import { classifyOpenTarget } from "../artifacts/open-target";
import { importViewerFile } from "./import-viewer-file";
import { storageFileTab } from "./storage-file-tab";
import type { ArtifactPanelTab } from "./panel-tab-store";

export function hasViewerFileDrag(data: DataTransfer) {
  return hasProjectFileDrag(data) || hasWorkspaceFileDrag(data) || hasStorageFileDrag(data) || hasLegalMemoryFileDrag(data) || data.types.includes("Files");
}

/** Read drag data synchronously: browsers clear its contents after drop returns. */
export function readViewerFileDrop(data: DataTransfer) {
  return {
    projects: readProjectFilesDrag(data),
    workspace: readWorkspaceFileDrag(data),
    storage: readStorageFileDrag(data),
    memory: readLegalMemoryFileDrag(data),
    files: Array.from(data.files),
  };
}

type DropClient = Pick<LegalworkServerClient, "storageRoots" | "legalMemoryOpen" | "downloadWorkspaceFile" | "writeWorkspaceBinaryFile">;

export async function* viewerFileTabs(client: DropClient, workspaceId: string, drop: ReturnType<typeof readViewerFileDrop>): AsyncGenerator<ArtifactPanelTab> {
  if (drop.projects.length) {
    for (const source of drop.projects) yield projectFileTab(source);
  } else if (drop.workspace) {
    if (drop.workspace.workspaceId !== workspaceId) throw new Error(t("side_panel.drop_other_workspace"));
    const { path, name } = drop.workspace;
    yield { id: `file:${path}`, type: "artifact", label: name, value: path, preview: classifyOpenTarget(path, "file") };
  } else if (drop.storage) {
    const { connectionId, path, name } = drop.storage;
    const root = (await client.storageRoots(workspaceId)).roots.find((root) => root.id === connectionId);
    if (!root) throw new Error(t("side_panel.drop_storage_unavailable"));
    // The normal storage viewer checks out the file and retains cloud-save controls.
    yield storageFileTab(workspaceId, root, { path, name, kind: "file", size: null, modifiedAt: null });
  } else if (drop.memory) {
    const file = await materializeLegalMemoryFile(client, workspaceId, drop.memory.document_id);
    yield { id: `file:${file.path}`, type: "artifact", label: drop.memory.name, value: file.path, preview: classifyOpenTarget(file.path, "file") };
  } else {
    for (const file of drop.files) yield await importViewerFile(client, workspaceId, file);
  }
}
