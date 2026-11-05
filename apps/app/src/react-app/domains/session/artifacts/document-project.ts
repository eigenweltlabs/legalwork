import { workspaceBootstrap } from "@/app/lib/desktop";
import { createLegalworkServerClient } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { isDesktopRuntime, normalizeDirectoryPath } from "@/app/utils";
import { resolveLegalworkConnection } from "../../../shell/legalwork-connection";
import type { DocumentProject } from "./document-runtime-store";

/** Resolves tasks that are not in the sidebar cache, including when the app
 * starts on Settings. No route, tab, or selected-project state is consulted. */
export async function resolveDocumentProject(sessionId: string): Promise<DocumentProject> {
  const connection = await resolveLegalworkConnection();
  const client = createLegalworkServerClient({ baseUrl: connection.normalizedBaseUrl, token: connection.resolvedToken, hostToken: connection.resolvedHostToken });
  const workspaces = isDesktopRuntime() && connection.source === "desktop-runtime" ? (await workspaceBootstrap()).workspaces ?? [] : (await client.listWorkspaces()).items;
  const candidates = workspaces.flatMap(workspace => {
    const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl: connection.normalizedBaseUrl, token: connection.resolvedToken });
    if (!endpoint) return [];
    return [(async () => {
      const { item } = await endpoint.client.getSession(endpoint.workspaceId, sessionId);
      if (!endpoint.isRemote && normalizeDirectoryPath(item.directory) !== normalizeDirectoryPath(workspace.path || "")) throw new Error("Different project");
      return { projectId: workspace.id, workspaceId: endpoint.workspaceId, workspaceRoot: workspace.path || "", client: endpoint.client, isRemoteWorkspace: endpoint.isRemote };
    })()];
  });
  try { return await Promise.any(candidates); }
  catch { throw new Error("The task's project is unavailable. Its data could not be loaded from the project server."); }
}
