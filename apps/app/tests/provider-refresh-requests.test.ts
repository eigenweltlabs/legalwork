import { expect, test } from "bun:test";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { createClient } from "../src/app/lib/opencode";

function storeAt(current: () => string) {
  return createProviderAuthStore({
    client: () => createClient(current() + "/opencode"), baseUrl: current,
    providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    selectedWorkspaceDisplay: () => ({ id: "ws", name: "Workspace", path: "/fixture", preset: "starter", workspaceType: "local", displayNameResolved: "Workspace" }),
    selectedWorkspaceRoot: () => "/fixture", runtimeWorkspaceId: () => "ws",
    legalworkServer: { getSnapshot: () => ({ legalworkServerStatus: "connected", legalworkServerClient: createLegalworkServerClient({ baseUrl: current() }), legalworkServerCapabilities: null }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {}, markOpencodeConfigReloadRequired: () => {},
  });
}

test("ordinary refreshes join once while every explicit forced refresh still runs", async () => {
  const requests: unknown[] = []; let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ port: 0, async fetch(request) { requests.push(await request.json()); await gate; return Response.json({ providers: {}, reloaded: false }); } });
  const store = storeAt(() => String(server.url));
  try {
    const ordinary = Array.from({ length: 10 }, () => store.refreshCustomProviderModels());
    while (!requests.length) await Bun.sleep(1);
    const a = store.refreshCustomProviderModels({ providerId: "a", force: true });
    const b = store.refreshCustomProviderModels({ providerId: "b", force: true });
    expect(requests).toHaveLength(1); release?.();
    await Promise.all([...ordinary, a, b]);
    expect(requests).toEqual([{}, { providerId: "a", force: true }, { providerId: "b", force: true }]);
  } finally { release?.(); store.dispose(); server.stop(true); }
});

test("a new server with the same workspace path does not wait for the old refresh", async () => {
  let release: (() => void) | undefined; let oldCalls = 0; let newCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const oldServer = Bun.serve({ port: 0, async fetch() { oldCalls++; await gate; return Response.json({ providers: {}, reloaded: false }); } });
  const newServer = Bun.serve({ port: 0, fetch() { newCalls++; return Response.json({ providers: {}, reloaded: false }); } });
  let current = String(oldServer.url); const store = storeAt(() => current);
  try {
    const old = store.refreshCustomProviderModels();
    while (!oldCalls) await Bun.sleep(1);
    current = String(newServer.url);
    await store.refreshCustomProviderModels(); expect(newCalls).toBe(1);
    release?.(); await old;
  } finally { release?.(); store.dispose(); oldServer.stop(true); newServer.stop(true); }
});

test("a queued explicit refresh cannot move to a different selected server", async () => {
  let release = () => {}, oldCalls = 0, newCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const oldServer = Bun.serve({ port: 0, async fetch() { oldCalls++; await gate; return Response.json({ providers: {}, reloaded: false }); } });
  const newServer = Bun.serve({ port: 0, fetch() { newCalls++; return Response.json({ providers: {}, reloaded: false }); } });
  let current = String(oldServer.url);
  const store = storeAt(() => current);
  try {
    const ordinary = store.refreshCustomProviderModels();
    while (!oldCalls) await Bun.sleep(1);
    const queued = store.refreshCustomProviderModels({ providerId: "old-provider", force: true });
    current = String(newServer.url);
    release();
    await Promise.all([ordinary, queued]);
    expect(oldCalls).toBe(1);
    expect(newCalls).toBe(0);
    await store.refreshCustomProviderModels({ providerId: "new-provider", force: true });
    expect(newCalls).toBe(1);
  } finally { release(); store.dispose(); oldServer.stop(true); newServer.stop(true); }
});
