import type { McpDirectoryInfo } from "./constants";
import type { LegalworkMcpProbeResult } from "./lib/legalwork-server";
import { t } from "@/i18n";

/**
 * The "Add custom connector" flow, minus the React: what the server's check
 * means for the person adding a connector, and what config their answers turn
 * into. Mirrors how the MCP authorization spec lets a server signal its needs
 * (see apps/server/src/mcp-probe.ts): anonymous access, OAuth with automatic
 * or pre-registered clients, or a static credential when no OAuth metadata is
 * published. Sign-in itself is never a choice here — an OAuth connector signs
 * in right after it is added.
 */
export type CustomConnectorProbe = LegalworkMcpProbeResult;

export type CustomConnectorOAuthClient = "automatic" | "own";

export type CustomConnectorForm = {
  name: string;
  url: string;
  oauthClient: CustomConnectorOAuthClient;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  apiKeyHeader: string;
};

export const DEFAULT_API_KEY_HEADER = "Authorization";

/** The engine's loopback callback; a pre-registered OAuth client must allow it. */
export const MCP_OAUTH_REDIRECT_URI = "http://127.0.0.1:19876/mcp/oauth/callback";

export type CustomConnectorVerdict = "signin" | "open" | "credentials" | "unreachable" | "unknown";

export function probeVerdict(probe: CustomConnectorProbe): CustomConnectorVerdict {
  if (!probe.reachable) return "unreachable";
  if (probe.auth === "oauth") return "signin";
  if (probe.auth === "none") return "open";
  if (probe.auth === "credentials") return "credentials";
  return "unknown";
}

/** Automatic registration when the sign-in provider offers it, otherwise the firm's own client. */
export function defaultOAuthClient(probe: CustomConnectorProbe | null): CustomConnectorOAuthClient {
  return probe?.oauth?.dynamicRegistration ? "automatic" : "own";
}

/** A bare key in the Authorization header is a bearer token; a value naming its scheme is kept. */
export function apiKeyHeaderValue(header: string, value: string): string {
  const trimmed = value.trim();
  if (header.trim().toLowerCase() !== "authorization") return trimmed;
  return /^[A-Za-z][A-Za-z0-9._~+/-]*\s+\S/.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function apiKeyHeaders(form: CustomConnectorForm): Record<string, string> | undefined {
  const apiKey = form.apiKey.trim();
  if (!apiKey) return undefined;
  const header = form.apiKeyHeader.trim() || DEFAULT_API_KEY_HEADER;
  return { [header]: apiKeyHeaderValue(header, apiKey) };
}

/** The connector entry to save. Throws with a message for the person when something is missing. */
export function buildCustomConnectorEntry(form: CustomConnectorForm, probe: CustomConnectorProbe | null): McpDirectoryInfo {
  const name = form.name.trim();
  if (!name) throw new Error(t("mcp.name_required"));
  const url = form.url.trim();
  if (!url) throw new Error(t("mcp.url_or_command_required"));
  const entry: McpDirectoryInfo = { name, description: "", type: "remote", url };
  const verdict = probe ? probeVerdict(probe) : "unknown";

  if (verdict === "signin") {
    if (form.oauthClient === "automatic" && probe?.oauth?.dynamicRegistration) return { ...entry, oauth: true };
    const clientId = form.clientId.trim();
    if (!clientId) throw new Error(t("add_mcp.client_id_required"));
    const clientSecret = form.clientSecret.trim();
    return { ...entry, oauth: true, oauthConfig: { clientId, ...(clientSecret ? { clientSecret } : {}) } };
  }

  const headers = apiKeyHeaders(form);
  if (verdict === "credentials" && !headers) throw new Error(t("add_mcp.api_key_required"));
  // An open server, or one the check could not read: the engine finds out on
  // connect. A key the person typed anyway rides along as a header.
  return headers ? { ...entry, headers } : entry;
}
