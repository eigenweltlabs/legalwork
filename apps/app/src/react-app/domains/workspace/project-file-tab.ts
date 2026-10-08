import type { ProjectFileSource } from "@legalwork/types/project-files";
import type { ArtifactPanelTab } from "../session/panel/panel-tab-store";
import { classifyOpenTarget } from "../session/artifacts/open-target";

export function projectFileTab(source: ProjectFileSource): ArtifactPanelTab {
  return {
    id: `project-file:${JSON.stringify([source.projectId, source.workspaceId, source.connectionId ?? null, source.path])}`,
    type: "artifact", label: source.name, preview: classifyOpenTarget(source.name, "file"),
    value: source.connectionId ? undefined : source.path, sourceProject: source,
  };
}
