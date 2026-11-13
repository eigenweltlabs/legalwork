import type { LauncherWorkspaceContext } from "@legalwork/types/launcher";
import type { SessionPanelState } from "@/react-app/domains/session/panel/panel-tab-store";
import { documentControlTarget } from "@/react-app/domains/session/panel/document-control-target";

export function workspaceContextSnapshot(input: { workspace: { id: string; name: string }; panel?: Pick<SessionPanelState, "tabs" | "panes" | "focusedPaneId">; folder?: string; selection?: string; lastDocumentId?: string | null; now: number }): { context: LauncherWorkspaceContext; documentId: string | null } {
  const { workspace, panel } = input;
  const pane = panel?.panes.find(item => item.id === panel.focusedPaneId) ?? panel?.panes[0];
  const focused = panel?.tabs.find(item => item.id === pane?.activeTabId);
  const visible = panel?.panes.flatMap(pane => panel.tabs.filter(tab => tab.id === pane.activeTabId && tab.type === "artifact").map(tab => tab.id)) ?? [];
  const documentId = documentControlTarget(visible, focused?.id, input.lastDocumentId ?? null);
  const tab = panel?.tabs.find(item => item.id === documentId);
  const source = tab?.type === "artifact" ? tab.sourceProject : undefined;
  const path = tab?.type === "artifact" ? source?.path ?? tab.value : undefined;
  const document = path && tab?.type === "artifact" ? { workspaceId: source?.projectId ?? workspace.id, path, name: tab.label, revision: tab.updatedAt ? String(tab.updatedAt) : null } : undefined;
  return { documentId, context: { workspaceId: workspace.id, workspaceName: workspace.name, paneId: pane?.id,
    folder: input.folder ?? (document?.workspaceId === workspace.id ? path?.split("/").slice(0, -1).join("/") : undefined),
    sessionId: focused?.type === "chat" ? focused.sessionId : undefined, document,
    selection: focused?.type === "artifact" ? input.selection?.slice(0, 200_000) || undefined : undefined, capturedAt: input.now } };
}
