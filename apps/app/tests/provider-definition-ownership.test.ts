import { afterEach, expect, test } from "bun:test";
import type { ProviderListItem } from "../src/app/types";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { nativeProviderFixture } from "./native-provider-fixture";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); getReactQueryClient().clear(); });

test("only explicit app-owned provider metadata enables editing; authored providers retain sign-in and models", async () => {
  const native = nativeProviderFixture({ connected: new Set(["owned", "authored", "ancestor", "legacy"]) });
  cleanups.push(native.stop);
  let ownedEditable = true;
  const edits: unknown[] = [];
  const provider = { name: "Provider", package: "@opencode/ai/providers/openai-compatible", settings: {}, models: { full: { name: "Full", limit: { context: 900000, output: 80000 } } } };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/workspace/matter/config") return Response.json({ opencode: { providers: { owned: provider, authored: provider, legacy: provider } }, legalwork: {},
      providerDisplay: { owned: { hasCustomEndpoint: true, editable: ownedEditable }, authored: { hasCustomEndpoint: true, editable: false }, ancestor: { hasCustomEndpoint: true, editable: false }, legacy: { hasCustomEndpoint: true } } });
    if (path === "/org-policy") return Response.json({ entries: {} });
    if (path === "/workspace/matter/provider-model-refresh") { edits.push(await request.json()); return Response.json({ providers: {}, reloaded: false }); }
    return Response.json({ message: `Unexpected endpoint ${path}` }, { status: 404 });
  } });
  cleanups.push(() => server.stop(true));
  const legalworkClient = createLegalworkServerClient({ baseUrl: server.url.origin, token: "synthetic" });
  let providers: ProviderListItem[] = [];
  const store = createProviderAuthStore({ client: () => native.client, baseUrl: () => native.baseUrl,
    providers: () => providers, providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    selectedWorkspaceDisplay: () => ({ id: "matter", name: "Matter", path: "/preview", workspaceType: "local" }), selectedWorkspaceRoot: () => "/preview", runtimeWorkspaceId: () => "matter",
    legalworkServer: { getSnapshot: () => ({ legalworkServerStatus: "connected", legalworkServerClient: legalworkClient, legalworkServerCapabilities: { config: { read: true, write: true } } }) },
    setProviders: value => { providers = value; }, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {}, markOpencodeConfigReloadRequired: () => {},
  });
  await store.refreshProviders();
  const visibleIDs = providers.map(item => item.id);
  expect(providers.find(item => item.id === "owned")).toMatchObject({ editableAsCustom: true, configurationReadOnly: false });
  for (const id of ["authored", "ancestor", "legacy"]) {
    expect(providers.find(item => item.id === id)).toMatchObject({ editableAsCustom: false, configurationReadOnly: true });
    expect(await store.readCustomProviderForEdit(id)).toBeNull();
    await expect(store.refreshProviderModels(id)).rejects.toThrow();
  }
  const editable = await store.readCustomProviderForEdit("owned");
  expect(editable).toMatchObject({ baseURL: "", endpointConfigured: true, models: [{ id: "full", contextLimit: 900000, outputLimit: 80000 }] });
  await store.refreshProviderModels("owned"); expect(edits).toHaveLength(1);
  // A later authored winning override revokes form access without changing
  // existing credentials, connected models or the saved private endpoint.
  ownedEditable = false;
  await store.refreshProviders();
  expect(providers.find(item => item.id === "owned")?.configurationReadOnly).toBe(true);
  expect(await store.readCustomProviderForEdit("owned")).toBeNull();
  await expect(store.submitCustomProvider({ providerId: "owned", name: "Stale form", baseURL: "", preserveExistingEndpoint: true, apiKey: "", apiType: "chat", models: [{ id: "full" }] })).rejects.toThrow();
  expect(providers.map(item => item.id)).toEqual(visibleIDs);
});
