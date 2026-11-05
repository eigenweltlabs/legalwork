/** Resolve supported project requests through the selected LegalWork server. */

import { isRetiredRemoteWorkspace } from "@legalwork/types/workspace";
import {
  buildLegalworkWorkspaceBaseUrl,
  createLegalworkServerClient,
  type LegalworkServerClient,
} from "./legalwork-server";

export type ResolvedWorkspaceEndpoint = {
  /** Host URL of the LegalWork server that owns this workspace (no `/workspace` mount). */
  baseUrl: string;
  /** Auth token for that server. May be empty for unauthenticated local servers. */
  token: string;
  /** Host credential is present only for the local server owning this workspace. */
  hostToken?: string;
  /** Workspace id as the owning server expects it in URL paths. No `rem_` prefix. */
  workspaceId: string;
  /** Kept false for components that also render a manual server connection. */
  isRemote: false;
  /** LegalworkServerClient bound to {@link baseUrl}/{@link token}. */
  client: LegalworkServerClient;
  /** Mounted base url: `<baseUrl>/workspace/<workspaceId>`. No trailing slash. */
  mountedBaseUrl: string;
  /** OpenCode SDK base url: `<mountedBaseUrl>/opencode`. */
  opencodeBaseUrl: string;
};

export type LocalServerHandle = {
  localClient?: LegalworkServerClient | null;
  baseUrl: string | null | undefined;
  token: string | null | undefined;
  hostToken?: string | null;
};

type WorkspaceEndpointInput = { id: string; workspaceType?: string | null } | null | undefined;

/**
 * Retired remote records never produce a usable server-side project ID.
 */
export function workspaceServerId(workspace: WorkspaceEndpointInput): string {
  if (!workspace) return "";
  const id = workspace.id.trim();
  return isRetiredRemoteWorkspace(workspace) ? "" : id;
}

/**
 * Resolve the right server endpoint for a workspace. Returns null when the
 * project is retired or no LegalWork server is connected yet. The returned object's `client`, `mountedBaseUrl`, and
 * `opencodeBaseUrl` are ready to use for any workspace-scoped API call.
 */
export function resolveWorkspaceEndpoint(
  workspace: WorkspaceEndpointInput,
  localServer: LocalServerHandle,
): ResolvedWorkspaceEndpoint | null {
  if (!workspace) return null;

  if (isRetiredRemoteWorkspace(workspace)) return null;

  const localBaseUrl = (localServer.baseUrl ?? "").trim();
  if (!localBaseUrl) return null;
  const localToken = (localServer.token ?? "").trim();
  const hostToken = localServer.hostToken?.trim() || undefined;
  const workspaceId = workspace.id.trim();
  const client = localServer.localClient?.baseUrl === localBaseUrl.replace(/\/+$/, "") ? localServer.localClient : createLegalworkServerClient({
    baseUrl: localBaseUrl,
    token: localToken || undefined,
    hostToken,
  });
  const mountedBaseUrl = (
    buildLegalworkWorkspaceBaseUrl(localBaseUrl, workspaceId) ?? localBaseUrl
  ).replace(/\/+$/, "");
  return {
    baseUrl: localBaseUrl,
    token: localToken,
    hostToken,
    workspaceId,
    isRemote: false,
    client,
    mountedBaseUrl,
    opencodeBaseUrl: `${mountedBaseUrl}/opencode`,
  };
}
