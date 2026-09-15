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
 * The check persists nothing and registers nothing. `registerMcpClient` below
 * is the one write: when a connector is added with automatic OAuth, it
 * registers a client the way the engine would, so a provider that refuses
 * says so, in its own words, before anything is saved.
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
    /** Where a client registers itself, when the authorization server advertises that. */
    registrationEndpoint: string | null;
    /** Scopes the resource metadata lists; a registration asks for them, as the engine does. */
    scopesSupported: string[];
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
  let scopesSupported: string[] = [];
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
      const scopes = json.scopes_supported;
      scopesSupported = Array.isArray(scopes) ? scopes.filter((item): item is string => typeof item === "string") : [];
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
    const registrationEndpoint =
      typeof json.registration_endpoint === "string" && json.registration_endpoint.length > 0 ? json.registration_endpoint : null;
    result.auth = "oauth";
    result.oauth = {
      resourceMetadataUrl,
      authorizationServer: authorizationServer.toString(),
      dynamicRegistration: registrationEndpoint !== null,
      clientIdMetadataDocuments: json.client_id_metadata_document_supported === true,
      registrationEndpoint,
      scopesSupported,
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
      registrationEndpoint: null,
      scopesSupported,
    };
    return result;
  }
  result.auth = "credentials";
  return result;
}

/**
 * The engine's loopback OAuth callback. Mirrors apps/app/src/app/mcp-custom-connector.ts
 * and apps/desktop/electron/mcp-oauth-callback.mjs; a registered client must allow it.
 */
export const MCP_OAUTH_REDIRECT_URI = "http://127.0.0.1:19876/mcp/oauth/callback";

export type McpRegisteredClient = { clientId: string; clientSecret?: string };

export type McpRegisterClientResult =
  | { registered: true; client: McpRegisteredClient; registrationEndpoint: string }
  | {
      registered: false;
      /** `unsupported`: nowhere to register; `refused`: the provider answered no; `unreachable`: it did not answer. */
      reason: "unsupported" | "refused" | "unreachable";
      status: number | null;
      /** The provider's own words where it gave any. */
      message: string;
    };

/**
 * What a provider said when it refused: the OAuth error fields first, then the
 * generic envelope Auth0 and others answer with, `{"statusCode":403,"error":"Forbidden","message":"…"}`,
 * whose `message` the MCP SDK drops. A page of HTML is not a message.
 */
export function registrationRefusalMessage(status: number, body: string): string {
  const text = body.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      for (const field of ["error_description", "message", "error"]) {
        const value = parsed[field];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
      }
    }
  } catch {
    // Not JSON: the text is the message.
  }
  return text && !text.startsWith("<") ? text.slice(0, 300) : `HTTP ${status}`;
}

/**
 * Register LegalWork with the server's sign-in provider the way the engine
 * would (RFC 7591, the engine's redirect URI, a public client), before the
 * connector is saved. A provider may advertise registration and still refuse
 * it; Auth0 keeps it off by default. Found out here, the refusal comes with
 * the provider's reason instead of a failed connect later. The registered
 * client is saved with the connector as its pre-registered client, so the
 * engine signs in with it rather than registering a second one.
 */
export async function registerMcpClient(input: string, options: McpProbeOptions = {}): Promise<McpRegisterClientResult> {
  const probe = await probeMcpServer(input, options);
  const endpoint = probe.oauth?.registrationEndpoint ?? null;
  if (probe.auth !== "oauth" || !endpoint) {
    return {
      registered: false,
      reason: "unsupported",
      status: null,
      message: probe.error ?? "The sign-in provider does not offer automatic registration.",
    };
  }
  const scope = probe.oauth?.scopesSupported.join(" ");
  const metadata = {
    client_name: "LegalWork",
    redirect_uris: [MCP_OAUTH_REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(scope ? { scope } : {}),
  };
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(metadata),
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    return { registered: false, reason: "unreachable", status: null, message: error instanceof Error ? error.message : String(error) };
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return { registered: false, reason: "refused", status: response.status, message: registrationRefusalMessage(response.status, text) };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Answered below as a missing client ID.
  }
  const info = isRecord(parsed) ? parsed : {};
  const clientId = typeof info.client_id === "string" ? info.client_id.trim() : "";
  if (!clientId) {
    return { registered: false, reason: "refused", status: response.status, message: "The sign-in provider answered without a client ID." };
  }
  // A secret the provider issued is used as the engine uses one it registered
  // itself, unless it has already expired (0 means never).
  const expiresAt = typeof info.client_secret_expires_at === "number" ? info.client_secret_expires_at : 0;
  const secret =
    typeof info.client_secret === "string" && info.client_secret && (expiresAt === 0 || expiresAt > Date.now() / 1000)
      ? info.client_secret
      : undefined;
  return { registered: true, client: { clientId, ...(secret ? { clientSecret: secret } : {}) }, registrationEndpoint: endpoint };
}
