import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { seedHostApprovalState } from "../domains/session/sync/session-sync";
import type { RouteWorkspace } from "./route-workspaces";

export type ApprovalWorkspace = { id: string; workspaceType?: RouteWorkspace["workspaceType"] };

export const hostApprovalScope = (baseUrl: string, workspaceId: string) =>
  `host-approvals:${JSON.stringify([baseUrl.replace(/\/+$/, ""), workspaceId])}`;

/** Each host owns its credentials, snapshot and failure state. */
export async function refreshHostApprovals(client: LegalworkServerClient | null, workspaces: readonly ApprovalWorkspace[],
  current: () => boolean) {
  const local = { localClient: client, baseUrl: client?.baseUrl, token: client?.token };
  const sources = workspaces.flatMap(workspace => {
    const endpoint = resolveWorkspaceEndpoint(workspace, local);
    return endpoint?.client.canApprove ? [endpoint] : [];
  });
  // Reuse a fetch only for the same client object. Never merge different credentials.
  const reads = new Map<LegalworkServerClient, ReturnType<LegalworkServerClient["pendingHostApprovals"]>>();
  await Promise.allSettled(sources.map(async endpoint => {
    let read = reads.get(endpoint.client);
    if (!read) { read = endpoint.client.pendingHostApprovals(); reads.set(endpoint.client, read); }
    const result = await read;
    if (current()) seedHostApprovalState(hostApprovalScope(endpoint.baseUrl, endpoint.workspaceId),
      result.items.filter(request => request.workspaceId === endpoint.workspaceId),
      { workspaceId: endpoint.workspaceId, baseUrl: endpoint.opencodeBaseUrl });
  }));
}
