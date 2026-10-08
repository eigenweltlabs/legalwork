import type { LegalworkTask } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint, type LocalServerHandle } from "@/app/lib/workspace-endpoint";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { workspacePanelKey, type PanelTabStore } from "../session/panel/panel-tab-store";

/** Open only on the server that owns the task; stale project links must not navigate. */
export function openTaskProject(options: {
  projectId: string;
  task: Pick<LegalworkTask, "id" | "title">;
  workspaces: RouteWorkspace[];
  sourceBaseUrl: string | undefined;
  localServer: LocalServerHandle;
  panels: Pick<PanelTabStore, "migrateWorkspace" | "openTab">;
}): string | null {
  const project = options.workspaces.find(workspace => {
    const endpoint = resolveWorkspaceEndpoint(workspace, options.localServer);
    return endpoint?.workspaceId === options.projectId && endpoint.client.baseUrl === options.sourceBaseUrl;
  });
  if (!project) return null;

  // Migrate before selecting: docking legacy tabs afterwards would steal focus.
  options.panels.migrateWorkspace(project.id);
  options.panels.openTab(workspacePanelKey(project.id), {
    id: `task:${options.task.id}`, type: "task", taskId: options.task.id, label: options.task.title,
  });
  return `${workspaceSessionRoute(project.id)}?view=workspace`;
}
