#!/usr/bin/env node
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3978);
const issuer = process.env.ISSUER || `http://${host}:${port}`;
const autoApprove = process.env.AUTO_APPROVE !== "0";
const dynamicRegistration = process.env.DYNAMIC_REGISTRATION !== "0";
const normalizeLoopbackCallback = process.env.NORMALIZE_LOOPBACK_CALLBACK === "1";
const accessTokenTtlSeconds = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 3600);
const rotateRefreshTokens = process.env.ROTATE_REFRESH_TOKENS !== "0";
const omitRefreshTokenOnRefresh = process.env.OMIT_REFRESH_TOKEN_ON_REFRESH === "1";
const refreshDelayMs = Number(process.env.REFRESH_DELAY_MS || 0);
const revokeFamilyOnReuse = process.env.REFRESH_REUSE_REVOKES_FAMILY === "1";
const legacySse = process.env.LEGACY_SSE === "1";
const sseSessions = new Map();

const clients = new Map();
const codes = new Map();
const tokens = new Map();
const refreshTokens = new Map();
const usedRefreshTokens = new Map();
const revokedFamilies = new Set();
const stats = { authorizationGrants: 0, refreshGrants: 0, rejectedRefreshGrants: 0, resourceLists: 0, revokedFamilies: 0, refreshAttempts: 0, toolCalls: 0, cancelledCalls: 0 };
let refreshMode = "ok";
const pendingTools = new Map();
const requests = [];
if (process.env.CLIENT_ID) {
  clients.set(process.env.CLIENT_ID, {
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "content-type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readForm(req) {
  const raw = await readBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

function record(req, url) {
  const entry = {
    id: requests.length + 1,
    method: req.method,
    path: url.pathname,
    url: `${url.pathname}${url.search}`,
    at: new Date().toISOString(),
  };
  requests.push(entry);
  console.log(`[mock-oauth-mcp] ${entry.method} ${entry.path}`);
}

function protectedResourceMetadata() {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
  };
}

let requiredScope = "";

function authorizationServerMetadata() {
  return {
    issuer,
    ...(process.env.OAUTH_ISSUER_PARAMETER === "1" ? { authorization_response_iss_parameter_supported: true } : {}),
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    ...(process.env.CLIENT_METADATA_DOCUMENT_SUPPORTED === "1" ? { client_id_metadata_document_supported: true } : {}),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["mcp:read", "mcp:write"],
  };
}

function normalizedCallback(value) {
  if (!normalizeLoopbackCallback) return value;
  const url = new URL(value);
  if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  return url.toString();
}

function redirectWithCode(res, params) {
  const requestedRedirect = params.get("redirect_uri");
  if (!requestedRedirect) {
    json(res, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
    return;
  }
  const redirectUri = normalizedCallback(requestedRedirect);
  if (normalizeLoopbackCallback && !clients.get(params.get("client_id"))?.redirect_uris?.includes(redirectUri)) {
    json(res, 400, { error: "invalid_request", error_description: "The redirect_uri parameter does not match the client's registered redirect URLs." });
    return;
  }

  const code = `mock-code-${randomUUID()}`;
  codes.set(code, {
    clientId: params.get("client_id") || "mock-client",
    codeChallenge: params.get("code_challenge") || null,
    codeChallengeMethod: params.get("code_challenge_method") || "plain",
    scope: params.get("scope") || "mcp:read mcp:write",
    redirectUri,
  });

  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  if (process.env.OAUTH_ISSUER_PARAMETER === "1") callback.searchParams.set("iss", issuer);
  const state = params.get("state");
  if (state) callback.searchParams.set("state", state);

  res.writeHead(302, { location: callback.toString() });
  res.end();
}

function authorize(req, res, url) {
  if (!clients.has(url.searchParams.get("client_id"))) {
    json(res, 400, { error: "invalid_client", error_description: "Unknown OAuth client" });
    return;
  }
  if (autoApprove) {
    redirectWithCode(res, url.searchParams);
    return;
  }

  const approveUrl = new URL(`${issuer}/approve`);
  for (const [key, value] of url.searchParams) approveUrl.searchParams.set(key, value);
  text(res, 200, `<!doctype html>
<html>
  <head><title>Mock MCP OAuth</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto;">
    <h1>Mock MCP OAuth</h1>
    <p>This fake OAuth provider is for LegalWork MCP end-to-end tests.</p>
    <form method="post" action="${approveUrl.pathname}${approveUrl.search}">
      <button style="font: inherit; padding: 10px 14px;">Approve LegalWork</button>
    </form>
  </body>
</html>`);
}

async function registerClient(req, res) {
  if (!dynamicRegistration) {
    json(res, 400, {
      error: "invalid_client_metadata",
      error_description: "Dynamic client registration is not supported. Only pre-registered MCP trusted partners are allowed.",
    });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  const clientId = `mock-client-${randomUUID()}`;
  const client = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: body.token_endpoint_auth_method || "none",
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp:read mcp:write",
  };
  clients.set(clientId, client);
  json(res, 201, client);
}

async function issueToken(req, res) {
  const form = await readForm(req);
  const authorization = req.headers.authorization || "";
  const credentials = authorization.startsWith("Basic ")
    ? Buffer.from(authorization.slice(6), "base64").toString().split(":")
    : [form.client_id, form.client_secret];
  const client = clients.get(credentials[0]);
  if (!client || (client.client_secret && credentials[1] !== client.client_secret)) {
    json(res, 401, { error: "invalid_client" });
    return;
  }
  const grantType = form.grant_type || "authorization_code";
  let family = randomUUID();

  if (grantType === "authorization_code") {
    const grant = codes.get(form.code);
    if (!grant) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    if (grant.clientId !== client.client_id) {
      json(res, 400, { error: "invalid_grant", error_description: "Code belongs to another client" });
      return;
    }
    if (normalizeLoopbackCallback && (!form.redirect_uri || normalizedCallback(form.redirect_uri) !== grant.redirectUri)) {
      json(res, 400, { error: "invalid_grant", error_description: "The token exchange callback does not match authorization." });
      return;
    }
    if (grant.codeChallenge) {
      const verifier = form.code_verifier || "";
      const expected =
        grant.codeChallengeMethod === "S256"
          ? createHash("sha256").update(verifier).digest("base64url")
          : verifier;
      if (expected !== grant.codeChallenge) {
        json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }
  }

  if (grantType === "refresh_token") {
    stats.refreshAttempts++;
    if (refreshMode !== "ok") {
      json(res, refreshMode === "unavailable" ? 503 : 400, { error: refreshMode === "unavailable" ? "temporarily_unavailable" : "invalid_grant" });
      return;
    }
    const grant = refreshTokens.get(form.refresh_token);
    if (!grant || grant.clientId !== client.client_id || revokedFamilies.has(grant.family)) {
      const reused = usedRefreshTokens.get(form.refresh_token);
      if (revokeFamilyOnReuse && reused?.clientId === client.client_id && !revokedFamilies.has(reused.family)) {
        revokedFamilies.add(reused.family);
        stats.revokedFamilies++;
      }
      stats.rejectedRefreshGrants++;
      json(res, 400, { error: "invalid_grant", error_description: "Refresh token is invalid or already consumed" });
      return;
    }
    family = grant.family;
    stats.refreshGrants++;
    if (rotateRefreshTokens && !omitRefreshTokenOnRefresh) {
      usedRefreshTokens.set(form.refresh_token, grant);
      refreshTokens.delete(form.refresh_token);
    }
    if (refreshDelayMs) await new Promise(resolve => setTimeout(resolve, refreshDelayMs));
  } else if (grantType === "authorization_code") {
    stats.authorizationGrants++;
  } else {
    json(res, 400, { error: "unsupported_grant_type" });
    return;
  }

  if (form.code) codes.delete(form.code);
  const accessToken = `mock-access-${randomUUID()}`;
  tokens.set(accessToken, { expiresAt: Date.now() + accessTokenTtlSeconds * 1000, family });
  const omitRefresh = grantType === "refresh_token" && omitRefreshTokenOnRefresh;
  const refreshToken = grantType === "refresh_token" && (!rotateRefreshTokens || omitRefresh)
    ? form.refresh_token : `mock-refresh-${randomUUID()}`;
  refreshTokens.set(refreshToken, { clientId: client.client_id, family });
  json(res, 200, {
    access_token: accessToken,
    ...(!omitRefresh ? { refresh_token: refreshToken } : {}),
    token_type: "Bearer",
    expires_in: accessTokenTtlSeconds,
    scope: "mcp:read mcp:write",
  });
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match && tokens.get(match[1]);
  return Boolean(token && token.expiresAt > Date.now() && !revokedFamilies.has(token.family));
}

function mcpResult(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "mock-oauth-mcp", version: "1.0.0" },
      };
    case "tools/list":
      return {
        tools: [
          {
            name: "mock_echo",
            title: "Mock Echo",
            description: "Echoes the provided text from the mock OAuth MCP server.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
    case "resources/list":
      stats.resourceLists++;
      return { resources: [{ name: "mock-resource", uri: "mock://resource" }] };
    case "resources/templates/list": return { resourceTemplates: [] };
    case "resources/read": return { contents: [{ uri: message.params.uri, mimeType: "text/plain", text: "MOCK_RESOURCE_CONTENT" }] };
    case "prompts/list": return { prompts: [{ name: "mock_prompt", description: "Synthetic prompt" }] };
    case "prompts/get": return { messages: [{ role: "user", content: { type: "text", text: "MOCK_PROMPT_CONTENT" } }] };
    case "tools/call":
      stats.toolCalls++;
      if (message.params?.arguments?.text === "PROVIDER_ERROR") return { isError: true, content: [{ type: "text", text: "Synthetic provider failure" }] };
      return {
        content: [
          {
            type: "text",
            text: String(message.params?.arguments?.text ?? "mock oauth mcp ok"),
          },
        ],
      };
    default:
      return {};
  }
}

async function handleMcp(req, res) {
  if (!isAuthorized(req)) {
    json(res, 401, { error: "missing_mcp_token" }, {
      "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    });
    return;
  }

  if (req.method === "GET") {
    if (legacySse) {
      const id = randomUUID();
      sseSessions.set(id, res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`event: endpoint\ndata: ${issuer}/messages?session=${id}\n\n`);
      req.on("close", () => sseSessions.delete(id));
      return;
    }
    json(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (requiredScope) {
    json(res, 403, { error: "insufficient_scope" }, { "www-authenticate": `Bearer error="insufficient_scope", scope="${requiredScope}"` });
    return;
  }
  if (legacySse && new URL(req.url, issuer).pathname === "/mcp") {
    json(res, 405, { error: "legacy_sse_only" });
    return;
  }

  const body = await readJson(req).catch(() => ({}));
  if (body.method === "notifications/cancelled") {
    const pending = pendingTools.get(body.params?.requestId);
    if (pending) {
      stats.cancelledCalls++;
      pendingTools.delete(body.params.requestId);
      clearTimeout(pending.timer);
      json(pending.res, 200, { jsonrpc: "2.0", id: body.params.requestId, error: { code: -32800, message: "Cancelled" } });
    }
  }
  if (body.method === "tools/call" && body.params?.arguments?.text === "WAIT_FOR_CANCEL") {
    stats.toolCalls++;
    const timer = setTimeout(() => { pendingTools.delete(body.id); json(res, 200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Uncancelled" }] } }); }, 10_000);
    pendingTools.set(body.id, { res, timer });
    return;
  }
  if (body.method === "tools/call" && body.params?.arguments?.text === "DROP_AFTER_EXECUTION") {
    stats.toolCalls++;
    res.destroy();
    return;
  }
  if (body.method === "tools/call" && body.params?.arguments?.text === "REPORT_PROGRESS") {
    const result = mcpResult(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: body.params._meta?.progressToken, progress: 1, total: 2 } })}\n\n`);
    res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = messages.flatMap((message) => {
    if (!message || typeof message !== "object" || message.id === undefined) return [];
    return [{ jsonrpc: "2.0", id: message.id, result: mcpResult(message) }];
  });

  if (responses.length === 0) {
    res.writeHead(202, { "access-control-allow-origin": "*" });
    res.end();
    return;
  }

  if (legacySse) {
    const stream = sseSessions.get(new URL(req.url, issuer).searchParams.get("session"));
    if (!stream) { json(res, 404, { error: "session_not_found" }); return; }
    for (const response of responses) stream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    res.writeHead(202).end();
  } else json(res, 200, Array.isArray(body) ? responses : responses[0]);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", issuer);
    record(req, url);

    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return;
    }

    if (url.pathname === "/health") {
      json(res, 200, { ok: true, issuer, autoApprove, requests: requests.length });
      return;
    }

    // Synthetic test controls, never expose tokens or authorization codes.
    if (url.pathname === "/stats") {
      json(res, 200, stats);
      return;
    }
    if (url.pathname === "/expire" && req.method === "POST") {
      tokens.clear();
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/required-scope" && req.method === "POST") {
      const body = await readJson(req);
      requiredScope = typeof body.scope === "string" ? body.scope : "";
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/refresh-mode" && req.method === "POST") {
      const body = await readJson(req);
      refreshMode = ["ok", "unavailable", "invalid_grant"].includes(body.mode) ? body.mode : "ok";
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/requests") {
      json(res, 200, { requests });
      return;
    }

    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
      url.pathname === "/mcp/.well-known/oauth-protected-resource"
    ) {
      json(res, 200, protectedResourceMetadata());
      return;
    }

    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp"
    ) {
      json(res, 200, authorizationServerMetadata());
      return;
    }

    if (url.pathname === "/register" && req.method === "POST") {
      await registerClient(req, res);
      return;
    }

    if (url.pathname === "/authorize" && req.method === "GET") {
      authorize(req, res, url);
      return;
    }

    if (url.pathname === "/approve" && req.method === "POST") {
      redirectWithCode(res, url.searchParams);
      return;
    }

    if (url.pathname === "/token" && req.method === "POST") {
      await issueToken(req, res);
      return;
    }

    if (url.pathname === "/mcp" || (legacySse && url.pathname === "/messages")) {
      await handleMcp(req, res);
      return;
    }

    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`[mock-oauth-mcp] listening on ${issuer}`);
  console.log(`[mock-oauth-mcp] MCP URL: ${issuer}/mcp`);
  console.log(`[mock-oauth-mcp] set AUTO_APPROVE=0 to require an approval click`);
});
