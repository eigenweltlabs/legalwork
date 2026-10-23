import type { ViewRecord } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint, type LocalServerHandle } from "@/app/lib/workspace-endpoint";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { wikiWorkspaceRoute, workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { workspacePanelKey, type PanelTabStore } from "../session/panel/panel-tab-store";
import { viewPanelTab } from "./view-reference";

/** Select the saved file in its owner's workspace, without changing the source workspace. */
export async function openSavedView(options: {
  client: Pick<LegalworkServerClient, "baseUrl" | "listWikis">;
  view: Pick<ViewRecord, "owner" | "id" | "title">;
  workspaces: RouteWorkspace[];
  localServer: LocalServerHandle;
  panels: Pick<PanelTabStore, "migrateWorkspace" | "openTab">;
}): Promise<string | null> {
  const { client, view, workspaces, localServer, panels } = options;
  let workspaceId: string | undefined;
  if (view.owner.kind === "wiki") {
    // Wiki routes belong to the local wiki registry; a remote ID must not open a namesake.
    if (client.baseUrl !== localServer.baseUrl?.replace(/\/+$/, "")) return null;
    workspaceId = (await client.listWikis()).items.find(wiki => wiki.id === view.owner.id)?.workspaceId;
  } else {
    workspaceId = workspaces.find(workspace => {
      const endpoint = resolveWorkspaceEndpoint(workspace, localServer);
      return endpoint?.workspaceId === view.owner.id && endpoint.client.baseUrl === client.baseUrl;
    })?.id;
  }
  if (!workspaceId) return null;

  // Dock legacy tabs first so migration cannot steal focus from the requested dashboard.
  panels.migrateWorkspace(workspaceId);
  panels.openTab(workspacePanelKey(workspaceId), viewPanelTab(client.baseUrl, { owner: view.owner, viewId: view.id }, view.title));
  return view.owner.kind === "wiki" ? wikiWorkspaceRoute(workspaceId) : `${workspaceSessionRoute(workspaceId)}?view=workspace`;
}
