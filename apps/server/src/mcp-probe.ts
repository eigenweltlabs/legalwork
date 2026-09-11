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
 *   expects a static credential such as an API key in a request header.
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
  let challenge: string | null = null;
  let authRequired = false;
  try {
    const response = await request(url.toString(), {
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
    result.reachable = true;
    const type = contentType(response);
    if (response.ok && (type.includes("application/json") || type.includes("text/event-stream"))) {
      await discardBody(response);
      result.transport = "streamable-http";
      result.auth = "none";
      steps.push({ id: "connect", status: response.status, ok: true });
      return result;
    }
    if (response.status === 401 || response.status === 403) {
      challenge = response.headers.get("www-authenticate");
      authRequired = true;
      await discardBody(response);
      steps.push({ id: "connect", status: response.status, ok: true, detail: "sign-in required" });
    } else if (response.status === 404 || response.status === 405) {
      await discardBody(response);
      // Legacy HTTP+SSE servers only answer GET on their SSE endpoint.
      const sse = await request(url.toString(), {
        method: "GET",
        headers: { accept: "text/event-stream", ...(options.headers ?? {}) },
      });
      const sseType = contentType(sse);
      await discardBody(sse);
      if (sse.ok && sseType.includes("text/event-stream")) {
        result.transport = "sse";
        result.auth = "none";
        steps.push({ id: "connect", status: sse.status, ok: true });
        return result;
      }
      if (sse.status === 401 || sse.status === 403) {
        challenge = sse.headers.get("www-authenticate");
        authRequired = true;
        steps.push({ id: "connect", status: sse.status, ok: true, detail: "sign-in required" });
      } else {
        steps.push({ id: "connect", status: response.status, ok: false, detail: "no MCP endpoint answered here" });
        result.error = `The server answered HTTP ${response.status} and does not look like an MCP endpoint.`;
        return result;
      }
    } else {
      await discardBody(response);
      steps.push({
        id: "connect",
        status: response.status,
        ok: false,
        detail: response.ok ? "unexpected content type" : `HTTP ${response.status}`,
      });
      result.error = response.ok
        ? "The server answered, but not with an MCP response."
        : `The server answered HTTP ${response.status}.`;
      return result;
    }
  } catch (error) {
    steps.push({ id: "connect", status: null, ok: false, detail: error instanceof Error ? error.message : String(error) });
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
  if (!authRequired) return result;

  // 2. Protected resource metadata → the authorization server. Servers from
  // before protected resource metadata host the authorization server on the
  // MCP origin, which is where the search ends up without metadata.
  let resourceMetadataUrl: string | null = null;
  let authorizationServer = new URL(url.origin);
  let lastStatus: number | null = null;
  for (const candidate of protectedResourceMetadataCandidates(url, resourceMetadataFromChallenge(challenge))) {
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
