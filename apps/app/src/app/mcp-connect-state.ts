import { getMcpIdentityKey } from "./mcp-identity";
import { MCP_QUICK_CONNECT, type McpDirectoryInfo } from "./constants";
import type { McpServerEntry, McpStatus } from "./types";
import { classifyMcpOAuthError } from "./mcp-oauth-errors";
import { connectorUsesOAuth, isCredentialHeader } from "@legalwork/types/connector-config";

/** The saved connection is authoritative; the directory supplies display metadata. */
export function mcpAuthEntryFromServer(entry: McpServerEntry): McpDirectoryInfo {
  const catalog = MCP_QUICK_CONNECT.find(
    (candidate) => getMcpIdentityKey(candidate) === entry.name || candidate.name === entry.name || Boolean(candidate.url && candidate.url === entry.config.url),
  );
  return {
    ...catalog,
    name: catalog?.name ?? entry.name.replace(/^.+-[a-f0-9]{8}-plugin-(?:global|[a-f0-9]{8})-(.+)-[a-f0-9]{6}$/i, "$1").replace(/[-_]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()),
    description: catalog?.description ?? "",
    id: entry.name,
    serverName: entry.name,
    type: entry.config.type,
    url: entry.config.url,
    headers: entry.config.headers,
    oauth: connectorUsesOAuth(entry.config),
    oauthConfig: entry.config.oauth || undefined,
    ...(entry.configured ? { existingConfig: entry.config, configured: entry.configured, editable: entry.editable } : {}),
  };
}

export type McpConnectOutcome = "auth" | "connected" | "failed" | "pending";

export function mcpConnectOutcome(
  entry: McpDirectoryInfo,
  status: McpStatus | undefined,
  hasHeaders: boolean,
): McpConnectOutcome {
  // Static headers usually mean a token-authed server that must not start OAuth,
  // unless the entry asks for OAuth explicitly: then the headers ride along.
  const credentialHeaders = hasHeaders && (!entry.headers || Object.keys(entry.headers).some(isCredentialHeader));
  const oauthAllowed =
    (entry.type ?? "remote") === "remote" &&
    entry.oauth !== false &&
    (!credentialHeaders || entry.oauth === true || Boolean(entry.oauthConfig));
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
