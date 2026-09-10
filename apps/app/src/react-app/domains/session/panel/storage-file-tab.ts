import type { StorageEntry, StorageRoot } from "@legalwork/types/file-storage";
import { classifyOpenTarget } from "../artifacts/open-target";
import type { ArtifactPanelTab } from "./panel-tab-store";

export type StorageFileSource = {
  workspaceId: string;
  root: StorageRoot;
  file: StorageEntry;
};

export function storageFileTab(workspaceId: string, root: StorageRoot, file: StorageEntry): ArtifactPanelTab {
  return {
    id: `storage:${JSON.stringify([workspaceId, root.id, file.path])}`,
    type: "artifact",
    label: file.name,
    preview: classifyOpenTarget(file.name, "file"),
    storage: { workspaceId, root, file },
  };
}
