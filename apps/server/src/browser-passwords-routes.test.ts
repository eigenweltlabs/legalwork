import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { browserPasswords } from "./browser-passwords.js";
import type { ServerConfig } from "./types.js";
import { registerBrowserConnectionRoutes, registerBrowserPasswordRoutes } from "./routes/browser-passwords.js";
import { matchRoute, type Route } from "./routes/registry.js";
import { ApprovalService } from "./approvals.js";
import { ReloadEventStore } from "./events.js";
import { TokenService } from "./tokens.js";
import { ApiError } from "./errors.js";
import { authenticateWikiAgentRequest, ensureWikiAgentToken, grantWikiAgentSession } from "./wiki/agent-access.js";

test("password routes declare host-only access, persist in the shared vault, omit values and honor the write gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "password-routes-"));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test-client", hostToken: "test-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const routes: Route[] = [];
  registerBrowserPasswordRoutes({ routes, config, jsonResponse: (data, status) => Response.json(data, { status }), readJsonBody: request => request.json(),
    ensureWritable: value => { if (value.readOnly) throw new ApiError(403, "read_only", "Read-only"); } });
  expect(routes).toHaveLength(5);
  expect(routes.every(route => route.auth === "host-token")).toBe(true);
  const approvals = new ApprovalService(config.approval), reloadEvents = new ReloadEventStore(), tokens = new TokenService(config);
  const call = async (method: string, suffix = "", body?: unknown) => {
    const path = `/browser-passwords${suffix}`, route = matchRoute(routes, method, new URL(`http://localhost${path}`).pathname);
    if (!route) throw new Error("Missing password route");
    const request = new Request(`http://localhost${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return route.handler({ request, url: new URL(request.url), params: route.params, config, approvals, reloadEvents, tokens });
  };
  const payload = { label: "Portal", origin: "https://portal.example.org/login", username: "user", password: "synthetic-route-password" };
  try {
    const saved = await call("PUT", "", payload);
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(payload.password);
    const { item } = z.object({ item: z.object({ id: z.string().uuid(), origin: z.string() }) }).parse(JSON.parse(text));
    expect(item.origin).toBe("https://portal.example.org");
    const list = await (await call("GET")).text();
    expect(list).toContain(item.id);
    expect(list).not.toContain(payload.password);
    expect(await (await call("GET", "?origin=https%3A%2F%2Fauth.example.org")).json()).toMatchObject({ items: [{ id: item.id }] });
    expect(await (await call("GET", "?origin=https%3A%2F%2Funrelated.example.net")).json()).toEqual({ items: [] });
    await expect(call("GET", "?origin=http%3A%2F%2Finsecure.example.org")).rejects.toThrow("Use HTTPS");
    expect((await browserPasswords(config).get(item.id)).password).toBe(payload.password);
    const destination = "https://research.example.net/";
    const added = await (await call("POST", `/${item.id}/websites`, { url: destination, loginUrl: "https://signin.example.net/login" })).text();
    expect(added).not.toContain(payload.password);
    expect(JSON.parse(added)).toMatchObject({ item: { additionalOrigins: ["https://signin.example.net"] } });
    expect(await (await call("GET", "?origin=https%3A%2F%2Fsignin.example.net")).json()).toMatchObject({ items: [{ id: item.id }] });
    const removed = await (await call("DELETE", `/${item.id}/websites?${new URLSearchParams({ url: destination, loginUrl: "https://signin.example.net" })}`)).json();
    expect(removed).toMatchObject({ item: { additionalOrigins: [] } });
    expect(await (await call("GET", "?origin=https%3A%2F%2Fsignin.example.net")).json()).toEqual({ items: [] });
    await expect(call("DELETE", `/${item.id}/websites`)).rejects.toThrow("Choose a website");
    const updated = await call("PUT", "", { ...payload, id: item.id, label: "Updated", password: "" });
    expect(updated.status).toBe(200);
    expect((await browserPasswords(config).get(item.id)).password).toBe(payload.password);
    config.readOnly = true;
    await expect(call("PUT", "", payload)).rejects.toThrow("Read-only");
    await expect(call("DELETE", `/${item.id}`)).rejects.toThrow("Read-only");
    await expect(call("POST", `/${item.id}/websites`, { url: destination })).rejects.toThrow("Read-only");
    await expect(call("DELETE", `/${item.id}/websites?url=${encodeURIComponent(destination)}`)).rejects.toThrow("Read-only");
    config.readOnly = false;
    expect((await call("DELETE", `/${item.id}`)).status).toBe(200);
    expect(await (await call("GET")).json()).toEqual({ items: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session website additions require owner scope and return only connection metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-connection-routes-"));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test-client", hostToken: "test-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "project", name: "Project", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const routes: Route[] = [];
  const approvals = new ApprovalService(config.approval), reloadEvents = new ReloadEventStore(), tokens = new TokenService(config);
  registerBrowserConnectionRoutes({ routes, config, jsonResponse: (data, status) => Response.json(data, { status }), readJsonBody: request => request.json(),
    ensureWritable: value => { if (value.readOnly) throw new ApiError(403, "read_only", "Read-only"); },
    requireClientScope: (ctx, scope) => {
      if (!ctx.actor || scope === "owner" && ctx.actor.scope !== "owner" || ctx.actor.scope === "viewer") throw new ApiError(403, "forbidden", "Insufficient scope");
    },
    resolveWorkspace: async (value, id) => {
      const workspace = value.workspaces.find(item => item.id === id);
      if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace missing");
      return workspace;
    },
  });
  try {
    const store = browserPasswords(config);
    const login = await store.save({ label: "Research", origin: "https://portal.example.org", username: "private-user", password: "private-fixture-password" });
    const agentToken = await ensureWikiAgentToken(config);
    await grantWikiAgentSession(config, { sessionId: "owner-chat", directory: root, scope: "owner" });
    const add = async (body: unknown, workspaceId = "project") => {
      const request = new Request(`http://localhost/workspace/${workspaceId}/browser-connections/${login.id}/websites`, {
        method: "POST", headers: { "content-type": "application/json", "x-legalwork-wiki-agent-token": agentToken,
          "x-legalwork-wiki-agent-session": "owner-chat", "x-legalwork-wiki-agent-directory": encodeURIComponent(root) }, body: JSON.stringify(body),
      });
      const route = matchRoute(routes, "POST", new URL(request.url).pathname)!;
      expect(route.auth).toBe("client");
      const access = await authenticateWikiAgentRequest(config, request);
      return route.handler({ request, url: new URL(request.url), params: route.params, config, approvals, reloadEvents, tokens, actor: access?.actor });
    };
    const response = await add({ url: "https://research.example.net", loginUrl: "https://signin.example.net" });
    const text = await response.text();
    expect(text).not.toContain("private-user");
    expect(text).not.toContain("private-fixture-password");
    expect(JSON.parse(text)).toMatchObject({ item: { id: login.id, additionalOrigins: ["https://signin.example.net"] } });
    expect((await store.get(login.id)).password).toBe("private-fixture-password");
    await expect(add({ url: "https://evil.example", password: "replacement" })).rejects.toMatchObject({ code: "invalid_browser_password_website" });
    await expect(add({ url: "https://evil.example" }, "other-project")).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
    await grantWikiAgentSession(config, { sessionId: "owner-chat", directory: root, scope: "collaborator" });
    await expect(add({ url: "https://evil.example", loginUrl: "https://evil.example" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.list("https://evil.example")).toEqual([]);
    await grantWikiAgentSession(config, { sessionId: "owner-chat", directory: root, scope: "owner" });
    config.readOnly = true;
    await expect(add({ url: "https://research.example.net/another" })).rejects.toMatchObject({ code: "read_only" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
