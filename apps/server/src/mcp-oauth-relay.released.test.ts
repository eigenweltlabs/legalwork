import { expect, test } from "bun:test";
import { z } from "zod";
import { join } from "node:path";
import { createMcpOAuthCallbackBroker } from "../../desktop/electron/mcp-oauth-callback.mjs";
import { nativeMcpBinary, nativeMcpEngine, nativeOAuthProvider } from "./native-mcp-engine.test-support.js";
import { waitForNativeFixture } from "./native-mcp.test-support.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";

const startedSchema = z.object({ integrationID: z.string(), attemptID: z.string(), url: z.string(), mode: z.literal("auto"), callback: z.object({ redirectUri: z.string() }) });
test.skipIf(!nativeMcpBinary)("released native OAuth accepts only its owner's exact callback and exchanges once through the LegalWork relay", async () => {
  const provider = await nativeOAuthProvider();
  const engine = await nativeMcpEngine({ mcp: { servers: { fixture: { type: "remote", url: `${provider.url}/mcp` } } } });
  const connection = engine.connection();
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "relay-collaborator", hostToken: "relay-host", configPath: join(engine.root, "server.json"),
    opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    workspaces: [{ id: "project", name: "Project", path: engine.directory, preset: "starter", workspaceType: "local" }, { id: "other", name: "Other", path: engine.other, preset: "starter", workspaceType: "local" }], authorizedRoots: [engine.root] };
  await writeLegalworkRuntimeConfigFile(config, "project");
  const server = await startServer(config), callbacks = createMcpOAuthCallbackBroker();
  const call = (operation: string, body: unknown, token = config.token, workspace = "project", host = false) => fetch(`http://127.0.0.1:${server.port}/workspace/${workspace}/mcp/oauth/${operation}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(host ? { "x-legalwork-host-token": config.hostToken } : {}) }, body: JSON.stringify(body) });
  try {
    expect((await call("start", { server: "fixture" }, "owt_retired_viewer")).status).toBe(401);
    const response = await call("start", { server: "fixture" });
    expect(response.status).toBe(200);
    const started = startedSchema.parse(await response.json()), identity = { integrationID: started.integrationID, attemptID: started.attemptID };
    expect(JSON.stringify(started)).not.toContain(connection.password);
    expect((await call("status", identity, config.token, "project", true)).status).toBe(403);
    expect((await call("status", identity, config.token, "other")).status).toBe(403);
    const saved = await fetch(`http://127.0.0.1:${server.port}/workspace/project/config`, { method: "PATCH", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify({ opencode: { permissions: [{ action: "legalwork_calendar_read", resource: "*", effect: "ask" }] } }) });
    expect(saved.status).toBe(200);
    await writeLegalworkRuntimeConfigFile(config, "project");
    await waitForNativeFixture(async () => engine.client().config.get({ location: engine.location }), entries => entries.some(entry => entry.type === "document" && entry.info.permissions?.some(rule => rule.action === "legalwork_calendar_read" && rule.effect === "ask")), "saved unrelated permission");
    expect((await (await call("status", identity)).json()).status).toBe("pending");
    const authorization = new URL(started.url);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorization.searchParams.get("state"); if (!state) throw new Error("Native state missing");
    const browser = await fetch(started.url, { redirect: "manual" });
    expect(browser.status).toBe(302);
    const returned = browser.headers.get("location"); if (!returned) throw new Error("Provider callback missing");
    const callback = new URL(returned), code = callback.searchParams.get("code"); if (!code) throw new Error("Provider code missing");
    // The fixture's desktop and engine run on the same machine, so use a
    // different local listener to simulate the desktop host's address space.
    const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
    const desktopPort = reservation.port; reservation.stop(true);
    if (!desktopPort) throw new Error("Desktop callback port missing");
    const desktopAddress = new URL(callback); desktopAddress.port = String(desktopPort); desktopAddress.search = "";
    const listener = await callbacks.listen({ redirectUri: desktopAddress.href }, 7);
    const received = callbacks.wait({ listenerId: listener.listenerId, state }, 7);
    desktopAddress.search = callback.search; desktopAddress.searchParams.set("iss", provider.url);
    expect((await fetch(desktopAddress)).status).toBe(200);
    const captured = await received;
    expect(captured).toEqual({ code, iss: provider.url });
    const payload = { ...identity, state, ...captured };
    expect((await call("relay", { ...payload, callbackUrl: "http://127.0.0.1:1/admin" })).status).toBe(400);
    expect((await call("relay", { ...payload, state: "another-attempt" })).status).toBe(409);
    expect((await call("relay", payload, config.token, "project", true)).status).toBe(403);
    const delivered = await Promise.all([call("relay", payload), call("relay", payload)]);
    expect(delivered.map(response => response.status)).toEqual([200, 200]);
    const settled = await waitForNativeFixture(async () => (await call("status", identity)).json(), value => value.status === "complete", "relayed OAuth completion");
    expect(settled.status).toBe("complete");
    expect((await (await call("relay", payload)).json()).status).toBe("complete");
    const requests = z.object({ requests: z.array(z.object({ method: z.string(), path: z.string() })) }).parse(await provider.requests()).requests;
    expect(requests.filter(request => request.path === "/token")).toHaveLength(1);
    const credentials = await engine.client().credential.list();
    expect(credentials.filter(entry => entry.integrationID === started.integrationID && entry.value.type === "oauth")).toHaveLength(1);
    const next = startedSchema.parse(await (await call("start", { server: "fixture" })).json());
    expect((await call("cancel", { integrationID: next.integrationID, attemptID: next.attemptID })).status).toBe(200);
    expect((await call("relay", { integrationID: next.integrationID, attemptID: next.attemptID, state: new URL(next.url).searchParams.get("state"), code: "cancelled-code" })).status).toBe(403);
  } finally { callbacks.close(); await server.stop(); await engine.close(); await provider.close(); }
}, 30_000);
