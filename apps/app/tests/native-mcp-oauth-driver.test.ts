import { expect, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";
import { createMcpOAuthFlow } from "../src/app/mcp-oauth-flow";
import { createNativeMcpOAuthDriver } from "../src/react-app/domains/connections/native-mcp-oauth-driver";

async function fixture() {
  const requests: Array<{ path: string; body: unknown }> = [];
  let completed = false;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname, body: unknown = request.method === "POST" ? await request.json() : null;
    requests.push({ path, body });
    if (path.endsWith("/api/mcp")) return Response.json({ location: { directory: "/selected/project" }, data: [{ name: "fixture", integrationID: "native-integration", status: { status: "needs_auth" } }] });
    if (path.endsWith("/api/integration/native-integration")) return Response.json({ location: { directory: "/selected/project" }, data: { id: "native-integration", methods: [{ id: "oauth", type: "oauth", label: "Sign in" }] } });
    if (path.endsWith("/mcp/oauth/start")) return Response.json({ integrationID: "native-integration", attemptID: "native-attempt", mode: "auto", url: "https://provider.example/authorize?state=owned-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A19876%2Fcallback", instructions: "Sign in", time: { created: Date.now(), expires: Date.now() + 60000 }, callback: { redirectUri: "http://127.0.0.1:19876/callback" } });
    if (path.endsWith("/mcp/oauth/relay")) { completed = true; return Response.json({ status: "complete", time: { created: 1, expires: Date.now() + 60000 } }); }
    if (path.endsWith("/mcp/oauth/status")) return Response.json({ status: completed ? "complete" : "pending", time: { created: 1, expires: Date.now() + 60000 } });
    if (path.endsWith("/mcp/oauth/cancel")) return Response.json({ ok: true });
    return new Response("Unexpected fixture endpoint", { status: 404 });
  } });
  const client = createClient(`${server.url.origin}/workspace/selected/opencode`, "/selected/project", { mode: "legalwork", token: "synthetic-selected-token" });
  return { server, requests, client };
}

test("remote desktop binds its callback before the browser and relays issuer/code through the selected LegalWork server", async () => {
  const setup = await fixture(), order: string[] = [], controller = new AbortController();
  let finish = 0;
  let receive: ((value: { code: string; iss: string }) => void) | undefined;
  const callback = new Promise<{ code: string; iss: string }>(resolve => { receive = resolve; });
  let success: (() => void) | undefined;
  const completed = new Promise<void>(resolve => { success = resolve; });
  const flow = createMcpOAuthFlow({ timeoutMs: 0,
    prepare: signal => createNativeMcpOAuthDriver({ client: setup.client, directory: "/selected/project", server: "fixture", signal,
      finish: async () => { finish++; return { status: "connected" }; }, desktop: {
        localServerUrl: async () => "http://127.0.0.1:1", listen: async () => { order.push("listen"); return { listenerId: "window-owned" }; },
        wait: async input => { order.push(`wait:${input.state}`); return callback; }, cancel: async () => { order.push("cancel-listener"); },
      } }),
    openBrowser: async () => { order.push("browser"); }, onChange: state => { if (state.phase === "success") success?.(); },
  });
  try {
    await flow.start();
    expect(order).toEqual(["listen", "wait:owned-state", "browser"]);
    expect(flow.getState()).toMatchObject({ phase: "waiting", mode: "auto", manual: true });
    receive?.({ code: "authorized-code", iss: "https://provider.example" });
    await completed;
    expect(setup.requests.find(request => request.path.endsWith("/mcp/oauth/relay"))?.body).toEqual({ integrationID: "native-integration", attemptID: "native-attempt", state: "owned-state", code: "authorized-code", iss: "https://provider.example" });
    expect(setup.requests.some(request => request.path.includes("/api/integration/native-integration/oauth"))).toBe(false);
    expect(finish).toBe(1);
    expect(order).toContain("cancel-listener");
  } finally { controller.abort(); flow.cancel(); setup.server.stop(true); }
});

test("the local native engine keeps its listener; an occupied remote callback preserves explicit paste and cancellation", async () => {
  const setup = await fixture();
  const controller = new AbortController();
  let listeners = 0;
  try {
    const local = await createNativeMcpOAuthDriver({ client: setup.client, directory: "/selected/project", server: "fixture", signal: controller.signal, finish: async () => ({ status: "connected" }), desktop: {
      localServerUrl: async () => setup.server.url.origin, listen: async () => { listeners++; throw new Error("Must not bind over the native engine"); }, wait: async () => ({ code: "unused" }), cancel: async () => {},
    } });
    expect(await local.start()).toMatchObject({ mode: "auto", manual: true });
    expect(listeners).toBe(0); expect(local.receiveCode).toBeUndefined();
    await local.dispose();
    const remote = await createNativeMcpOAuthDriver({ client: setup.client, directory: "/selected/project", server: "fixture", signal: controller.signal, finish: async () => ({ status: "connected" }), desktop: {
      localServerUrl: async () => "http://127.0.0.1:1", listen: async () => { listeners++; throw new Error("MCP_OAUTH_CALLBACK_IN_USE: Another sign-in owns the port"); }, wait: async () => ({ code: "unused" }), cancel: async () => {},
    } });
    expect(await remote.start()).toMatchObject({ mode: "auto", manual: true });
    expect(remote.notice).toContain("Another sign-in"); expect(remote.receiveCode).toBeUndefined();
    expect(await remote.complete("pasted-code")).toEqual({ status: "connected" });
    expect(setup.requests.filter(request => request.path.endsWith("/mcp/oauth/cancel"))).toHaveLength(1);
    await remote.dispose();
  } finally { controller.abort(); setup.server.stop(true); }
});
