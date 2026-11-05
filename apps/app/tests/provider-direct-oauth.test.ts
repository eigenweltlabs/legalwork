import { afterEach, describe, expect, test } from "bun:test";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { supportedProviderAuthMethods } from "../src/react-app/domains/connections/provider-auth/methods";
import { nativeProviderFixture } from "./native-provider-fixture";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); getReactQueryClient().clear(); });
function providerStore(failMethods = false) {
  const fixture = nativeProviderFixture({ failMethods });
  cleanups.push(fixture.stop);
  const store = createProviderAuthStore({
    client: () => fixture.client, baseUrl: () => fixture.baseUrl,
    providers: () => [{ id: "anthropic", name: "Anthropic", env: [], source: "api", models: {} }],
    providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    selectedWorkspaceDisplay: () => ({ id: "preview", name: "Preview", path: "/preview", preset: "local", workspaceType: "local" }),
    selectedWorkspaceRoot: () => "/preview", runtimeWorkspaceId: () => null,
    legalworkServer: { getSnapshot: () => ({ legalworkServerStatus: "disconnected", legalworkServerClient: null, legalworkServerCapabilities: null }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {}, markOpencodeConfigReloadRequired: () => {},
  });
  return { ...fixture, store };
}
describe("native subscription OAuth", () => {
  test("carries direct subscription intent and clears it on close", async () => {
    const { store } = providerStore();
    await store.openProviderAuthModal({ preferredProviderId: "openai", startOAuth: true });
    expect(store.getSnapshot().providerAuthStartOAuth).toBe(true);
    store.closeProviderAuthModal();
    await store.openProviderAuthModal();
    expect(store.getSnapshot().providerAuthStartOAuth).toBe(false);
    expect(store.getSnapshot().providerAuthPreferredProviderId).toBeNull();
  });
  test("keeps device and browser methods and routes the selected native method ID", async () => {
    const { store, calls } = providerStore();
    await store.openProviderAuthModal();
    const oauth = store.getSnapshot().providerAuthMethods.openai.filter(method => method.type === "oauth");
    expect(oauth.map(method => method.methodID)).toEqual(["device", "browser"]);
    await store.startProviderAuth("openai", 2);
    expect(calls.find(call => call.path.endsWith("/connect/oauth"))?.body).toMatchObject({ methodID: "browser" });
    await store.cancelProviderAuth();
    expect(calls.some(call => call.method === "DELETE" && call.path.endsWith("/attempt-1"))).toBe(true);
  });
  test("manual code completes only its native attempt and avoids an engine reload", async () => {
    const { store, calls } = providerStore();
    await store.startProviderAuth("google", 0, { account: "synthetic" });
    expect(await store.completeProviderAuthOAuth("google", 0)).toMatchObject({ connected: false, pending: true });
    expect(await store.completeProviderAuthOAuth("google", 0, "code")).toMatchObject({ connected: true });
    expect(calls.find(call => call.path.endsWith("/complete"))?.body).toEqual({ code: "code" });
    expect(calls.some(call => call.path === "/api/location/reload")).toBe(false);
  });
  test("an existing OpenAI connection does not complete or cancel a new ChatGPT sign-in", async () => {
    const { store, calls, states, connected } = providerStore();
    connected.add("openai");
    await store.startProviderAuth("openai", 2);
    await store.refreshProviders();
    expect(await store.completeProviderAuthOAuth("openai", 2)).toMatchObject({ connected: false, pending: true });
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
    states.set("attempt-1", "complete");
    expect(await store.completeProviderAuthOAuth("openai", 2)).toMatchObject({ connected: true, pending: false });
  });
  test("supports native command and external integration methods with typed answers", async () => {
    const { store, calls, states } = providerStore();
    await store.startProviderAuth("command", 0);
    states.set("attempt-1", "complete");
    expect(await store.completeProviderAuthOAuth("command", 0)).toMatchObject({ connected: true });
    await store.startProviderAuth("external", 0, { approved: true });
    expect(calls.find(call => call.path.endsWith("/connect/external"))?.body).toMatchObject({ methodID: "external-login", answer: { approved: true } });
  });
  test("clears direct intent when native integration discovery fails", async () => {
    const { store } = providerStore(true);
    await expect(store.openProviderAuthModal({ preferredProviderId: "openai", startOAuth: true })).rejects.toThrow();
    expect(store.getSnapshot().providerAuthStartOAuth).toBe(false);
    expect(store.getSnapshot().providerAuthModalOpen).toBe(false);
  });
});
describe("Anthropic API key policy", () => {
  test("retains manual entry and rejects stale OAuth intents", async () => {
    const { store, calls } = providerStore();
    await store.openProviderAuthModal({ preferredProviderId: "anthropic", startOAuth: true });
    expect(store.getSnapshot().providerAuthStartOAuth).toBe(false);
    expect(store.getSnapshot().providerAuthMethods.anthropic).toEqual([{ type: "api", label: "API key" }]);
    await expect(store.startProviderAuth("anthropic", 0)).rejects.toThrow("Anthropic API key");
    await expect(store.completeProviderAuthOAuth("anthropic", 0, "stale")).rejects.toThrow("Anthropic API key");
    await store.submitProviderApiKey("anthropic", " synthetic-key ");
    expect(calls.find(call => call.path.endsWith("/anthropic/connect/key"))?.body).toEqual({ key: "synthetic-key" });
    expect(calls.some(call => call.path.includes("/oauth"))).toBe(false);
  });
  test("modal boundary discards stale retired OAuth methods", () => {
    expect(supportedProviderAuthMethods("Anthropic", [{ type: "oauth", label: "Retired", methodIndex: 0 }])).toEqual([{ type: "api", label: "API key" }]);
  });
});
