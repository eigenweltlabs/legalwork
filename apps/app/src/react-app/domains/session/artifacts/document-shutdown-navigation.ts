import { usePanelTabStore, workspacePanelKey, type ArtifactPanelTab, type PanelTab } from "../panel/panel-tab-store";
import { workflowsPanelKey } from "../panel/panel-scope";
import { useUiStateStore } from "../../../shell/ui-state-store";
import { workspaceSessionRoute, workspaceSettingsRoute } from "../../../shell/workspace-routes";

type Navigate = (path: string) => void;
function open(scope: string, tab: PanelTab, route: string, navigate: Navigate) {
  usePanelTabStore.getState().openTab(scope, tab);
  useUiStateStore.getState().setSidePanelState(scope, "panel");
  navigate(route);
}
export function openUnsavedWorkflow(workspaceId: string, tab: PanelTab, navigate: Navigate) {
  open(workflowsPanelKey(workspaceId), tab, workspaceSettingsRoute(workspaceId, "workflows"), navigate);
}
export function openUnsavedArtifact(sessionId: string, workspaceId: string, tab: ArtifactPanelTab, navigate: Navigate) {
  const projectId = tab.sourceProject?.projectId ?? (sessionId.startsWith("workspace:") ? sessionId.slice("workspace:".length) : workspaceId);
  open(workspacePanelKey(projectId), tab, `${workspaceSessionRoute(projectId)}?view=workspace`, navigate);
}
