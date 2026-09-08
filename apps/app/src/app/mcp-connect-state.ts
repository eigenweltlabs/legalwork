import { getMcpIdentityKey } from "./mcp-identity";
import { MCP_QUICK_CONNECT, type McpDirectoryInfo } from "./constants";
import type { McpServerEntry, McpStatus } from "./types";
import { classifyMcpOAuthError } from "./mcp-oauth-errors";

/** The saved connection is authoritative; the directory supplies display metadata. */
export function mcpAuthEntryFromServer(entry: McpServerEntry): McpDirectoryInfo {
  const catalog = MCP_QUICK_CONNECT.find(
    (candidate) => getMcpIdentityKey(candidate) === entry.name || candidate.name === entry.name,
  );
  return {
    ...catalog,
    name: catalog?.name ?? entry.name,
    description: catalog?.description ?? "",
    id: entry.name,
    serverName: entry.name,
    type: "remote",
    url: entry.config.url,
    headers: entry.config.headers,
    oauth: entry.config.oauth !== false,
    oauthConfig: entry.config.oauth || undefined,
  };
}

export type McpConnectOutcome = "auth" | "connected" | "failed" | "pending";

export function mcpConnectOutcome(
  entry: McpDirectoryInfo,
  status: McpStatus | undefined,
  hasHeaders: boolean,
): McpConnectOutcome {
  const oauthAllowed = (entry.type ?? "remote") === "remote" && !hasHeaders && entry.oauth !== false;
  const authError = status?.status === "failed" ? classifyMcpOAuthError(status.error) : "unknown";
  // A transport handshake can succeed without credentials. An explicit OAuth
  // connection still needs the authorization flow to verify sign-in.
  if (oauthAllowed && (
    entry.oauth || entry.oauthConfig || status?.status === "needs_auth" ||
    status?.status === "needs_client_registration" ||
    authError === "client_registration_required" || authError === "invalid_client"
  )) {
    return "auth";
  }
  if (status?.status === "connected") return "connected";
  if (status?.status === "failed" || status?.status === "disabled" || status?.status === "needs_auth" || status?.status === "needs_client_registration") {
    return "failed";
  }
  return "pending";
}
