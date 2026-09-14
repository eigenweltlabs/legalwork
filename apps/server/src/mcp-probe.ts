/**
 * Ask a remote MCP server how it wants to be connected, before anything is
 * saved — the check the "Add custom connector" dialog shows step by step.
 *
 * The MCP authorization spec (basic/authorization) defines the signals:
 *
 * - An `initialize` request answered 2xx means the server accepts anonymous
 *   requests: no sign-in.
 * - 401 (or 403) means the server wants credentials. An OAuth server MUST
 *   publish Protected Resource Metadata (RFC 9728), pointed to by
 *   `WWW-Authenticate: Bearer resource_metadata="…"` or served at the
 *   well-known URI, path-aware first (`/.well-known/oauth-protected-resource/
 *   <path>`), then at the root. Its `authorization_servers` lead to the
 *   Authorization Server Metadata (RFC 8414 / OpenID discovery, tried in the
 *   spec's priority order). Older servers (2025-03-26) publish AS metadata on
 *   the MCP origin itself, so that is the last resort.
 * - AS metadata says how a client may register: `registration_endpoint`
 *   (Dynamic Client Registration, what the bundled engine uses),
 *   `client_id_metadata_document_supported` (CIMD, which the engine does not
 *   speak), or neither, in which case only a pre-registered client works.
 * - 401 with no OAuth metadata anywhere is outside the OAuth flow: the server
 *   expects a static credential such as an API key in a request header. A 403
 *   without any challenge is not read that way — that is a refusal, not a
 *   request for credentials.
 *
 * People paste what a vendor's page shows, which is not always the endpoint:
 * some servers live at `/mcp` or `/sse` under the pasted host, others at the
 * root of the host whose `/mcp` returns 404. When the pasted address does not
 * answer like an MCP endpoint, those siblings are tried and the address that
 * answered is reported back.
 *
 * Nothing here is persisted and no registration is performed; the engine's own
 * discovery runs again when the user signs in.
 */
import { ApiError } from "./errors.js";

export type McpProbeStepId = "connect" | "resource_metadata" | "authorization_server";

export type McpProbeStep = {
  id: McpProbeStepId;
  /** HTTP status of the decisive response, null when no response arrived. */
  status: number | null;
  ok: boolean;
  detail?: string;
};

/** How the server wants to be connected. */
export type McpProbeAuth = "none" | "oauth" | "credentials" | "unknown";

export type McpProbeResult = {
  /** The address that answered — the pasted one, or a sibling path that did. */
  url: string;
  reachable: boolean;
  transport: "streamable-http" | "sse" | null;
  auth: McpProbeAuth;
  oauth?: {
    resourceMetadataUrl: string | null;
    authorizationServer: string | null;
    /** The authorization server registers clients on the fly (RFC 7591). */
    dynamicRegistration: boolean;
    /** The authorization server accepts Client ID Metadata Documents. */
    clientIdMetadataDocuments: boolean;
  };
  steps: McpProbeStep[];
  error?: string;
};

export type McpProbeOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

const PROTOCOL_VERSION = "2025-06-18";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMcpProbeUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "invalid_payload", "url is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError(400, "invalid_payload", "url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(400, "invalid_payload", "url must use http or https");
  }
  return url;
}

/** `resource_metadata="…"` from a WWW-Authenticate challenge, if present. */
export function resourceMetadataFromChallenge(header: string | null): string | null {
  if (!header) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header) ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
  if (!match) return null;
  try {
    return new URL(match[1]).toString();
  } catch {
    return null;
  }
}

/** Well-known locations for the protected resource metadata, in the spec's order. */
export function protectedResourceMetadataCandidates(resource: URL, fromChallenge: string | null): string[] {
  const candidates: string[] = [];
  if (fromChallenge) candidates.push(fromChallenge);
  const path = resource.pathname.replace(/\/+$/, "");
  if (path && path !== "/") candidates.push(`${resource.origin}/.well-known/oauth-protected-resource${path}`);
  candidates.push(`${resource.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(candidates)];
}

/** Well-known locations for the authorization server metadata, in the spec's order. */
export function authorizationServerMetadataCandidates(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, "");
  if (path && path !== "/") {
    return [
      `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuer.origin}/.well-known/openid-configuration${path}`,
      `${issuer.origin}${path}/.well-known/openid-configuration`,
    ];
  }
  return [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
}

/** Sibling addresses worth trying when the pasted one does not answer like an MCP endpoint. */
export function siblingEndpointCandidates(url: URL): string[] {
  const path = url.pathname.replace(/\/+$/, "");
  const siblings = ["/mcp", "/sse", ""].filter((candidate) => candidate !== path);
  return siblings.map((candidate) => `${url.origin}${candidate || "/"}`);
}

function contentType(response: Response): string {
  return (response.headers.get("content-type") ?? "").toLowerCase();
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

export async function probeMcpServer(input: string, options: McpProbeOptions = {}): Promise<McpProbeResult> {
  const url = parseMcpProbeUrl(input);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? fetch;
  const steps: McpProbeStep[] = [];
  const result: McpProbeResult = { url: url.toString(), reachable: false, transport: null, auth: "unknown", steps };

  const request = (target: string, init: RequestInit) =>
    doFetch(target, { ...init, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });

  const readJson = async (target: string): Promise<{ status: number; json: Record<string, unknown> | null }> => {
    try {
      const response = await request(target, { method: "GET", headers: { accept: "application/json" } });
      if (!response.ok) {
        await discardBody(response);
        return { status: response.status, json: null };
      }
      const parsed: unknown = await response.json().catch(() => null);
      return { status: response.status, json: isRecord(parsed) ? parsed : null };
    } catch {
      return { status: 0, json: null };
    }
  };

  // 1. The MCP endpoint itself: an anonymous `initialize`.
  type Attempt =
    | { kind: "open"; status: number; transport: "streamable-http" | "sse" }
    | { kind: "auth"; status: number; challenge: string | null }
    | { kind: "refused"; status: number }
    | { kind: "not_mcp"; status: number; detail: string }
    | { kind: "unreachable"; message: string };
  const attempt = async (target: string): Promise<Attempt> => {
    try {
      const response = await request(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...(options.headers ?? {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "LegalWork", version: "probe" } },
        }),
      });
      const type = contentType(response);
      await discardBody(response);
      if (response.ok && (type.includes("application/json") || type.includes("text/event-stream"))) {
        return { kind: "open", status: response.status, transport: "streamable-http" };
      }
      if (response.status === 401) return { kind: "auth", status: 401, challenge: response.headers.get("www-authenticate") };
      if (response.status === 403) {
        const challenge = response.headers.get("www-authenticate");
        return challenge ? { kind: "auth", status: 403, challenge } : { kind: "refused", status: 403 };
      }
      if (response.status === 404 || response.status === 405) {
        // Legacy HTTP+SSE servers only answer GET on their SSE endpoint.
        const sse = await request(target, { method: "GET", headers: { accept: "text/event-stream", ...(options.headers ?? {}) } });
        const sseType = contentType(sse);
        await discardBody(sse);
        if (sse.ok && sseType.includes("text/event-stream")) return { kind: "open", status: sse.status, transport: "sse" };
        if (sse.status === 401 || (sse.status === 403 && sse.headers.get("www-authenticate"))) {
          return { kind: "auth", status: sse.status, challenge: sse.headers.get("www-authenticate") };
        }
        return { kind: "not_mcp", status: response.status, detail: "no MCP endpoint answered here" };
      }
      return {
        kind: "not_mcp",
        status: response.status,
        detail: response.ok ? "unexpected content type" : `HTTP ${response.status}`,
      };
    } catch (error) {
      return { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
    }
  };

  let outcome = await attempt(url.toString());
  let answered = url;
  if (outcome.kind === "not_mcp") {
    for (const sibling of siblingEndpointCandidates(url)) {
      const alternative = await attempt(sibling);
      if (alternative.kind === "not_mcp" || alternative.kind === "unreachable") continue;
      outcome = alternative;
      answered = new URL(sibling);
      break;
    }
  }
  result.url = answered.toString();
  const foundElsewhere = answered.toString() !== url.toString() ? `found at ${answered.toString()}` : undefined;

  if (outcome.kind === "unreachable") {
    steps.push({ id: "connect", status: null, ok: false, detail: outcome.message });
    result.error = outcome.message;
    return result;
  }
  result.reachable = true;
  if (outcome.kind === "open") {
    result.transport = outcome.transport;
    result.auth = "none";
    steps.push({ id: "connect", status: outcome.status, ok: true, detail: foundElsewhere });
    return result;
  }
  if (outcome.kind === "refused") {
    steps.push({ id: "connect", status: outcome.status, ok: false, detail: "refused without a sign-in challenge" });
    result.error = "The server refused the request (HTTP 403) without saying how to sign in.";
    return result;
  }
  if (outcome.kind === "not_mcp") {
    steps.push({ id: "connect", status: outcome.status, ok: false, detail: outcome.detail });
    result.error = outcome.detail === "unexpected content type"
      ? "The server answered, but not with an MCP response."
      : `The server answered HTTP ${outcome.status} and does not look like an MCP endpoint.`;
    return result;
  }
  const challenge = outcome.challenge;
  steps.push({ id: "connect", status: outcome.status, ok: true, detail: foundElsewhere ?? "sign-in required" });
  const resource = answered;


  // 2. Protected resource metadata → the authorization server. Servers from
  // before protected resource metadata host the authorization server on the
  // MCP origin, which is where the search ends up without metadata.
  let resourceMetadataUrl: string | null = null;
  let authorizationServer = new URL(resource.origin);
  let lastStatus: number | null = null;
  for (const candidate of protectedResourceMetadataCandidates(resource, resourceMetadataFromChallenge(challenge))) {
    const { status, json } = await readJson(candidate);
    lastStatus = status || lastStatus;
    const servers = json?.authorization_servers;
    const first = Array.isArray(servers) ? servers.find((item): item is string => typeof item === "string") : undefined;
    if (!json || !first) continue;
    try {
      authorizationServer = new URL(first);
      resourceMetadataUrl = candidate;
      steps.push({ id: "resource_metadata", status, ok: true });
      break;
    } catch {
      // A malformed issuer; keep looking.
    }
  }
  if (!resourceMetadataUrl) {
    steps.push({ id: "resource_metadata", status: lastStatus, ok: false, detail: "no protected resource metadata" });
  }

  // 3. Authorization server metadata → how clients may register.
  let metadataStatus: number | null = null;
  for (const candidate of authorizationServerMetadataCandidates(authorizationServer)) {
    const { status, json } = await readJson(candidate);
    metadataStatus = status || metadataStatus;
    if (!json || typeof json.authorization_endpoint !== "string") continue;
    steps.push({ id: "authorization_server", status, ok: true });
    result.auth = "oauth";
    result.oauth = {
      resourceMetadataUrl,
      authorizationServer: authorizationServer.toString(),
      dynamicRegistration: typeof json.registration_endpoint === "string" && json.registration_endpoint.length > 0,
      clientIdMetadataDocuments: json.client_id_metadata_document_supported === true,
    };
    return result;
  }
  steps.push({ id: "authorization_server", status: metadataStatus, ok: false, detail: "no authorization server metadata" });
  if (resourceMetadataUrl) {
    // The resource names an authorization server we could not read: still
    // OAuth, but only a client registered out of band can work.
    result.auth = "oauth";
    result.oauth = {
      resourceMetadataUrl,
      authorizationServer: authorizationServer.toString(),
      dynamicRegistration: false,
      clientIdMetadataDocuments: false,
    };
    return result;
  }
  result.auth = "credentials";
  return result;
}
