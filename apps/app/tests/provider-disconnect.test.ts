import { afterEach, expect, test } from "bun:test";
import type { ConfigEntry } from "@opencode/client";
import type { ProviderListItem } from "../src/app/types";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { nativeProviderFixture } from "./native-provider-fixture";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  getReactQueryClient().clear();
});

function localProviderStore(failDisable = false) {
  const connected = new Set(["ollama"]);
  const documents: ConfigEntry[] = [];
  const native = nativeProviderFixture({ connected, config: documents });
  cleanups.push(native.stop);
  const changes: boolean[] = [];
  let disabled: string[] = [];
  let providerList: ProviderListItem[] = [{ id: "ollama", name: "Ollama", source: "config", models: {} }];
  let visibleConnected = ["ollama"];
  let enabled = true;
  let config: Record<string, unknown> = {};
  let reloads = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/org-policy") return Response.json({ entries: {} });
    if (path.endsWith("/config")) {
      if (request.method === "PATCH") config = (await request.json()).opencode;
      return Response.json({ opencode: config, legalwork: {} });
    }
    if (path.endsWith("/providers/ollama/credentials")) return Response.json({ items: [] });
    if (path.endsWith("/providers/ollama/enabled")) {
      if (failDisable) return Response.json({ code: "unavailable", message: "Cannot save availability" }, { status: 503 });
      enabled = (await request.json()).enabled;
      changes.push(enabled);
      documents.splice(0, documents.length, { type: "document", info: { policies: [
        { action: "provider.use", resource: "ollama", effect: enabled ? "allow" : "deny" },
      ] } });
      return Response.json({ updatedAt: Date.now() });
    }
    if (path.endsWith("/engine/reload") || path.endsWith("/provider-model-refresh")) {
      reloads++;
      if (enabled) connected.add("ollama");
      else connected.delete("ollama");
      return Response.json({ ok: true, providers: {}, reloaded: true });
    }
    return Response.json({ message: "Unexpected request" }, { status: 500 });
  } });
  cleanups.push(() => server.stop(true));
  const store = createProviderAuthStore({
    client: () => native.client, baseUrl: () => native.baseUrl,
    providers: () => providerList, providerDefaults: () => ({}), providerConnectedIds: () => visibleConnected,
    disabledProviders: () => disabled,
    selectedWorkspaceDisplay: () => ({ id: "preview", name: "Preview", path: "/preview", preset: "local", workspaceType: "local" }),
    selectedWorkspaceRoot: () => "/preview", runtimeWorkspaceId: () => "preview",
    legalworkServer: { getSnapshot: () => ({
      legalworkServerStatus: "connected", legalworkServerClient: createLegalworkServerClient({ baseUrl: server.url.origin }),
      legalworkServerCapabilities: { config: { read: true, write: true } },
    }) },
    setProviders: value => { providerList = value; }, setProviderDefaults: () => {},
    setProviderConnectedIds: value => { visibleConnected = value; }, setDisabledProviders: value => { disabled = value; },
    markOpencodeConfigReloadRequired: () => {},
  });
  return { store, changes, connected: () => visibleConnected, reloads: () => reloads };
}

test("disconnecting a provider without credentials saves its availability and reloads the catalogue", async () => {
  const fixture = localProviderStore();
  await fixture.store.disconnectProvider("ollama");
  expect(fixture.changes).toEqual([false]);
  expect(fixture.reloads()).toBe(1);
  expect(fixture.connected()).not.toContain("ollama");
  expect(fixture.store.getSnapshot().providerAuthError).toBeNull();
});

test("a failed availability write keeps the provider visible and reports the error", async () => {
  const fixture = localProviderStore(true);
  await expect(fixture.store.disconnectProvider("ollama")).rejects.toThrow("Cannot save availability");
  expect(fixture.connected()).toContain("ollama");
  expect(fixture.reloads()).toBe(0);
});

test("adding a disconnected local provider again restores its availability", async () => {
  const fixture = localProviderStore();
  await fixture.store.disconnectProvider("ollama");
  await fixture.store.submitCustomProvider({
    providerId: "ollama", name: "Ollama", baseURL: "http://localhost:11434/v1",
    apiKey: "", apiType: "chat", models: [{ id: "synthetic-model" }],
  });
  expect(fixture.changes).toEqual([false, true]);
  expect(fixture.connected()).toContain("ollama");
});
