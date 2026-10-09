import { describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";

function providerStore(workerType: "local" | "remote" = "local", fail = false) {
  const authorizedMethods: number[] = [];
  const client = createOpencodeClient({ baseUrl: "https://provider-preview.invalid", fetch: async request => {
    const url = new URL(request.url);
    if (url.pathname === "/provider/auth") return Response.json(fail ? { message: "Unavailable" } : {
      openai: [
        { type: "api", label: "API key" },
        { type: "oauth", label: "ChatGPT Plus/Pro (headless)" },
        { type: "oauth", label: "ChatGPT Plus/Pro (browser)" },
      ],
    }, { status: fail ? 503 : 200 });
    if (url.pathname === "/provider/openai/oauth/authorize") {
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null || !("method" in body) || typeof body.method !== "number") throw new Error("Invalid OAuth method");
      authorizedMethods.push(body.method);
      return Response.json({ url: "https://auth.openai.com/preview", method: "auto", instructions: "Preview only" });
    }
    throw new Error(`Unexpected provider request: ${url.pathname}`);
  } });
  const store = createProviderAuthStore({
    client: () => client,
    baseUrl: () => "https://provider-preview.invalid",
    providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    selectedWorkspaceDisplay: () => ({ id: "preview", name: "Preview", path: "/preview", preset: "local", workspaceType: workerType }),
    selectedWorkspaceRoot: () => "/preview", runtimeWorkspaceId: () => null,
    legalworkServer: { getSnapshot: () => ({ legalworkServerStatus: "disconnected", legalworkServerClient: null, legalworkServerCapabilities: null }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {},
    markOpencodeConfigReloadRequired: () => {},
  });
  return { store, authorizedMethods };
}

describe("direct subscription OAuth", () => {
  test("carries the selected subscription and resets the intent before another provider is chosen", async () => {
    const { store } = providerStore();
    await store.openProviderAuthModal({ preferredProviderId: "openai", startOAuth: true });
    expect(store.getSnapshot().providerAuthStartOAuth).toBe(true);
    expect(store.getSnapshot().providerAuthPreferredProviderId).toBe("openai");
    store.closeProviderAuthModal();
    expect(store.getSnapshot().providerAuthStartOAuth).toBe(false);
    await store.openProviderAuthModal();
    expect(store.getSnapshot().providerAuthStartOAuth).toBe(false);
    expect(store.getSnapshot().providerAuthPreferredProviderId).toBeNull();
  });

  const workers: Array<"local" | "remote"> = ["local", "remote"];
  for (const worker of workers) test(`uses the worker's available OAuth method for ${worker} without assuming index zero`, async () => {
    const { store, authorizedMethods } = providerStore(worker);
    await store.openProviderAuthModal({ preferredProviderId: "openai", startOAuth: true });
    const selected = store.getSnapshot().providerAuthMethods.openai.find(method => method.type === "oauth");
    expect(selected).toBeDefined();
    const result = await store.startProviderAuth("openai", selected?.methodIndex);
    expect(result.methodIndex).toBe(worker === "local" ? 2 : 1);
    expect(authorizedMethods).toEqual([result.methodIndex]);
  });

  test("clears direct OAuth intent when loading provider methods fails", async () => {
    const { store } = providerStore("local", true);
    await expect(store.openProviderAuthModal({ preferredProviderId: "openai", startOAuth: true })).rejects.toThrow();
    expect(store.getSnapshot().providerAuthStartOAuth).toBe(false);
    expect(store.getSnapshot().providerAuthPreferredProviderId).toBeNull();
    expect(store.getSnapshot().providerAuthModalOpen).toBe(false);
  });
});
