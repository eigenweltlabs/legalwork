import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizationServerMetadataCandidates,
  probeMcpServer,
  protectedResourceMetadataCandidates,
  resourceMetadataFromChallenge,
} from "./mcp-probe.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

type Route = (request: Request, url: URL) => Response | Promise<Response> | null;

/** A fake remote MCP server; `route` decides per request, anything else is 404. */
function serve(route: Route) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      return (await route(request, url)) ?? new Response("not found", { status: 404 });
    },
  }) as Served & { url: URL };
  stops.push(() => server.stop(true));
  return { origin: `http://127.0.0.1:${server.port}`, server };
}

const rpcResult = () =>
  Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } } });

function oauthServer(options: { registration?: boolean; cimd?: boolean; challengeHeader?: boolean; prmAtRoot?: boolean } = {}) {
  const { registration = true, cimd = false, challengeHeader = true, prmAtRoot = false } = options;
  const fake = serve((request, url) => {
    if (url.pathname === "/mcp" && request.method === "POST") {
      const headers: Record<string, string> = challengeHeader
        ? { "www-authenticate": `Bearer resource_metadata="${fake.origin}/.well-known/oauth-protected-resource/mcp"` }
        : {};
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    if (url.pathname === (prmAtRoot ? "/.well-known/oauth-protected-resource" : "/.well-known/oauth-protected-resource/mcp")) {
      return Response.json({ resource: `${fake.origin}/mcp`, authorization_servers: [`${fake.origin}/auth`] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
      return Response.json({
        issuer: `${fake.origin}/auth`,
        authorization_endpoint: `${fake.origin}/auth/authorize`,
        token_endpoint: `${fake.origin}/auth/token`,
        ...(registration ? { registration_endpoint: `${fake.origin}/auth/register` } : {}),
        ...(cimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    return null;
  });
  return fake;
}

describe("probeMcpServer", () => {
  test("an anonymous initialize that succeeds means no sign-in", async () => {
    const fake = serve((request, url) => (url.pathname === "/mcp" && request.method === "POST" ? rpcResult() : null));
    const result = await probeMcpServer(`${fake.origin}/mcp`);
    expect(result).toMatchObject({ reachable: true, transport: "streamable-http", auth: "none" });
    expect(result.steps).toEqual([{ id: "connect", status: 200, ok: true }]);
  });

  test("401 with resource metadata and a registering authorization server means OAuth with automatic registration", async () => {
    const fake = oauthServer();
    const result = await probeMcpServer(`${fake.origin}/mcp`);
    expect(result.auth).toBe("oauth");
    expect(result.oauth).toEqual({
      resourceMetadataUrl: `${fake.origin}/.well-known/oauth-protected-resource/mcp`,
      authorizationServer: `${fake.origin}/auth`,
      dynamicRegistration: true,
      clientIdMetadataDocuments: false,
    });
    expect(result.steps.map((step) => `${step.id}:${step.status}:${step.ok}`)).toEqual([
      "connect:401:true",
      "resource_metadata:200:true",
      "authorization_server:200:true",
    ]);
  });

  test("without a challenge header the well-known path is probed, and a server without registration needs a pre-registered client", async () => {
    const fake = oauthServer({ challengeHeader: false, registration: false, cimd: true });
    const result = await probeMcpServer(`${fake.origin}/mcp`);
    expect(result.auth).toBe("oauth");
    expect(result.oauth?.dynamicRegistration).toBe(false);
    expect(result.oauth?.clientIdMetadataDocuments).toBe(true);
    expect(result.oauth?.resourceMetadataUrl).toBe(`${fake.origin}/.well-known/oauth-protected-resource/mcp`);
  });

  test("resource metadata at the root is the fallback after the path-aware location", async () => {
    const fake = oauthServer({ challengeHeader: false, prmAtRoot: true });
    const result = await probeMcpServer(`${fake.origin}/mcp`);
    expect(result.auth).toBe("oauth");
    expect(result.oauth?.resourceMetadataUrl).toBe(`${fake.origin}/.well-known/oauth-protected-resource`);
  });

  test("401 without any OAuth metadata means a static credential such as an API key", async () => {
    const fake = serve((request, url) =>
      url.pathname === "/mcp" && request.method === "POST" ? Response.json({ error: "unauthorized" }, { status: 401 }) : null,
    );
    const result = await probeMcpServer(`${fake.origin}/mcp`);
    expect(result).toMatchObject({ reachable: true, auth: "credentials" });
    expect(result.steps.map((step) => `${step.id}:${step.ok}`)).toEqual([
      "connect:true",
      "resource_metadata:false",
      "authorization_server:false",
    ]);
  });

  test("a credential the user already has is sent along", async () => {
    const fake = serve((request, url) => {
      if (url.pathname !== "/mcp" || request.method !== "POST") return null;
      return request.headers.get("x-api-key") === "secret" ? rpcResult() : Response.json({}, { status: 401 });
    });
    expect((await probeMcpServer(`${fake.origin}/mcp`)).auth).toBe("credentials");
    expect((await probeMcpServer(`${fake.origin}/mcp`, { headers: { "X-API-Key": "secret" } })).auth).toBe("none");
  });

  test("a legacy SSE endpoint that rejects POST is recognised through GET", async () => {
    const fake = serve((request, url) => {
      if (url.pathname !== "/sse") return null;
      if (request.method === "POST") return new Response("", { status: 405 });
      return new Response("event: endpoint\ndata: /messages\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const result = await probeMcpServer(`${fake.origin}/sse`);
    expect(result).toMatchObject({ reachable: true, transport: "sse", auth: "none" });
  });

  test("a web page or a missing endpoint is reachable but unknown", async () => {
    const fake = serve((request, url) => (url.pathname === "/" ? new Response("<html>hi</html>", { headers: { "content-type": "text/html" } }) : null));
    expect(await probeMcpServer(`${fake.origin}/`)).toMatchObject({ reachable: true, auth: "unknown" });
    const missing = await probeMcpServer(`${fake.origin}/nothing`);
    expect(missing).toMatchObject({ reachable: true, auth: "unknown" });
    expect(missing.steps[0]).toMatchObject({ id: "connect", status: 404, ok: false });
  });

  test("a server that cannot be reached is reported as such", async () => {
    const fake = serve(() => null);
    const origin = fake.origin;
    await fake.server.stop(true);
    const result = await probeMcpServer(`${origin}/mcp`, { timeoutMs: 2000 });
    expect(result.reachable).toBe(false);
    expect(result.auth).toBe("unknown");
    expect(result.steps[0]).toMatchObject({ id: "connect", status: null, ok: false });
    expect(result.error).toBeTruthy();
  });

  test("rejects addresses that are not http(s) URLs", async () => {
    await expect(probeMcpServer("ftp://example.com/mcp")).rejects.toThrow(/http/);
    await expect(probeMcpServer("not a url")).rejects.toThrow();
  });
});

describe("discovery helpers", () => {
  test("parses the resource_metadata challenge parameter", () => {
    expect(resourceMetadataFromChallenge('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"'))
      .toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
    expect(resourceMetadataFromChallenge("Bearer realm=\"x\"")).toBeNull();
    expect(resourceMetadataFromChallenge(null)).toBeNull();
  });

  test("orders well-known locations as the spec does", () => {
    expect(protectedResourceMetadataCandidates(new URL("https://mcp.example.com/mcp/"), null)).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(authorizationServerMetadataCandidates(new URL("https://auth.example.com/tenant1"))).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
    expect(authorizationServerMetadataCandidates(new URL("https://auth.example.com"))).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });
});

describe("POST /workspace/:id/mcp/probe", () => {
  test("probes on behalf of a client and validates the payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "legalwork-mcp-probe-"));
    roots.push(root);
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    try {
      const fake = oauthServer();
      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        token: "owt_test_token",
        hostToken: "owt_host_token",
        approval: { mode: "auto", timeoutMs: 1000 },
        corsOrigins: ["*"],
        workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
        authorizedRoots: [root],
        readOnly: false,
        startedAt: Date.now(),
        tokenSource: "cli",
        hostTokenSource: "cli",
        logFormat: "pretty",
        logRequests: false,
      };
      const server = await startServer(config) as Served;
      stops.push(() => server.stop(true));
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };

      const response = await fetch(`${base}/workspace/ws_1/mcp/probe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: `${fake.origin}/mcp` }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ auth: "oauth", oauth: { dynamicRegistration: true } });

      const invalid = await fetch(`${base}/workspace/ws_1/mcp/probe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: "file:///etc/passwd" }),
      });
      expect(invalid.status).toBe(400);

      const badHeaders = await fetch(`${base}/workspace/ws_1/mcp/probe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: `${fake.origin}/mcp`, headers: { "bad header": "x" } }),
      });
      expect(badHeaders.status).toBe(400);

      const anonymous = await fetch(`${base}/workspace/ws_1/mcp/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `${fake.origin}/mcp` }),
      });
      expect(anonymous.status).toBe(401);
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });
});
