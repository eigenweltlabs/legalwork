import type { ProjectFileSource } from "@legalwork/types/project-files";
import { launcherOpenSchema } from "@legalwork/types/launcher";
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { projectFileTab } from "@/react-app/domains/workspace/project-file-tab";
import { usePanelTabStore, workspacePanelKey } from "@/react-app/domains/session/panel/panel-tab-store";
import { getElectronBrowser } from "@/react-app/domains/session/panel/utils";
import { t } from "@/i18n";

export function launcherBrowserRoute(workspaceId: string, paneId?: string) {
  return `${workspaceSessionRoute(workspaceId)}?view=workspace&launcherBrowser=${encodeURIComponent(paneId ?? "")}`;
}
/** Create the native tab in the destination window, then place it in that workspace. */
export async function acceptLauncherBrowser(workspaceId: string, paneId?: string) {
  const browser = getElectronBrowser();
  if (!browser?.createTab || !browser.getState) throw new Error(t("side_panel.desktop_only_title"));
  const { tabId } = await browser.createTab();
  const state = await browser.getState();
  const tab = state?.tabs?.find(item => item.id === tabId);
  if (!tab) throw new Error(t("launcher.browser.failed"));
  const panels = usePanelTabStore.getState(), scope = workspacePanelKey(workspaceId);
  const pane = panels.sessions[scope]?.panes.find(item => item.id === paneId);
  panels.openTab(scope, tab, pane?.id, undefined, { preview: false });
}

export function launcherFileRoute(source: ProjectFileSource, destination = source.projectId, paneId?: string) {
  return `${workspaceSessionRoute(destination)}?view=workspace&launcherOpen=${encodeURIComponent(JSON.stringify({ source, destination, paneId }))}`;
}
/** Open a durable tab; the existing store handles pane policy and unsaved editors. */
export function acceptLauncherFile(value: unknown, workspaceId: string) {
  const input = launcherOpenSchema.parse(value);
  if (input.destination !== workspaceId) throw new Error("The destination project changed. Choose where to open again.");
  const panels = usePanelTabStore.getState(), scope = workspacePanelKey(workspaceId);
  if (input.paneId && !panels.sessions[scope]?.panes.some(pane => pane.id === input.paneId)) throw new Error("The destination pane was closed. Choose where to open again.");
  // A source-owned tab is read-only outside its original project.
  const tab = input.source.projectId === workspaceId
    ? { ...projectFileTab(input.source), sourceProject: undefined, value: input.source.path }
    : projectFileTab(input.source);
  const pane = panels.sessions[scope]?.panes.find(item => item.id === input.paneId);
  const inChat = panels.sessions[scope]?.tabs.some(item => item.id === pane?.activeTabId && item.type === "chat");
  panels.openTab(scope, tab, inChat ? undefined : input.paneId, undefined, { preview: false, besideChat: inChat });
}
