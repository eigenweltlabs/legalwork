import { expect, test } from "bun:test";
import { findApiError } from "./errors.js";
import { ApprovalService } from "./approvals.js";
import { ReloadEventStore } from "./events.js";
import { TokenService } from "./tokens.js";
import type { ServerConfig } from "./types.js";
import { matchRoute, type Route } from "./routes/registry.js";
import { registerEngineCredentialRoutes } from "./routes/engine-credentials.js";

test("credential routes handle an available local provider without an auth integration", async () => {
  const calls: string[] = [];
  const engine = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (path === "/api/provider/ollama") return Response.json({
      location: { directory: "/synthetic-project" },
      data: { id: "ollama", name: "Ollama", activation: "auto", package: "@opencode/ai/providers/openai-compatible" },
    });
    return Response.json({ message: "Integration not found" }, { status: 404 });
  } });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "synthetic-client", hostToken: "synthetic-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], authorizedRoots: ["/synthetic-project"],
    workspaces: [{ id: "test", name: "Test", path: "/synthetic-project", workspaceType: "local", preset: "starter" }],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, opencodeBaseUrl: engine.url.origin,
  };
  const routes: Route[] = [];
  registerEngineCredentialRoutes({
    routes, config, jsonResponse: data => Response.json(data),
    requireClientScope() {}, ensureWritable() {}, resolveWorkspace: async () => config.workspaces[0]!,
  });
  const call = (method: string, path: string) => {
    const request = new Request("http://localhost" + path, { method });
    const route = matchRoute(routes, method, path);
    if (!route) throw new Error("Missing credential route");
    return route.handler({
      request, url: new URL(request.url), params: route.params, config,
      approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config),
    });
  };
  try {
    const response = await call("GET", "/workspace/test/providers/ollama/credentials");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [] });
    expect(calls).toEqual(["/api/provider/ollama"]);
    await expect(call("DELETE", "/workspace/test/providers/ollama/credentials/unrelated")).rejects.toMatchObject({
      status: 404, code: "credential_not_found",
    });
    expect(calls.every(path => path === "/api/provider/ollama")).toBe(true);
    expect(await call("GET", "/workspace/test/providers/missing/credentials").catch(findApiError)).toMatchObject({
      status: 404, code: "opencode_request_failed",
    });
  } finally {
    engine.stop(true);
  }
});
