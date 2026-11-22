import { expect, test } from "bun:test";
import type { ProviderListItem, ProviderListView } from "../src/app/types";
import { OpenCode } from "@opencode/client";
import { fetchProviderList, getAvailableDefaultModel, getConnectedProviderItems, isModelAvailableInConnectedProviders } from "../src/react-app/infra/provider-list-query";
import { resolveTimekeepingChatModel } from "../src/react-app/domains/session/chat/session-model-store";

function provider(id: string, modelIds: string[]): ProviderListItem {
  const models: ProviderListItem["models"] = {};
  for (const modelID of modelIds) models[modelID] = {
    id: modelID, modelID, providerID: id, name: modelID, enabled: true, status: "active",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [], cost: [], time: { released: 0 }, limit: { context: 128000, output: 16384 },
  };
  return { id, name: id, source: "api", models };
}

const azure = provider("azure", ["other-deployment", "gpt-test"]);
const catalog: ProviderListView = { all: [azure], connected: ["azure"], default: { azure: "gpt-test" } };

test("the native catalog excludes disabled providers and models from composer choices and defaults", async () => {
  const rows: Record<string, unknown> = {
    "/api/provider": [
      { id: "azure", name: "Azure", activation: "auto", package: "fixture" },
      { id: "eigenwelt", name: "Eigenwelt", activation: "disabled", package: "fixture" },
    ],
    "/api/model": [azure.models["gpt-test"], { ...azure.models["other-deployment"], enabled: false }, provider("eigenwelt", ["hosted"]).models.hosted],
    "/api/model/default": azure.models["other-deployment"], "/api/integration": [], "/api/mcp": [],
  };
  const client = OpenCode.make({ baseUrl: "http://fixture.invalid", fetch: async input => {
    const pathname = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (!(pathname in rows)) throw new Error("Unexpected fixture request");
    return Response.json({ location: { directory: "/fixture", projectID: "fixture" }, data: rows[pathname] });
  } });
  const list = await fetchProviderList({ client, directory: "/fixture" });
  expect(list.connected).toEqual(["azure"]);
  expect(list.default).toEqual({});
  expect(isModelAvailableInConnectedProviders(list, { providerID: "azure", modelID: "other-deployment" })).toBe(false);
  expect(isModelAvailableInConnectedProviders(list, { providerID: "eigenwelt", modelID: "hosted" })).toBe(false);
  expect(getAvailableDefaultModel(list, null)).toEqual({ providerID: "azure", modelID: "gpt-test" });
});

test("a fresh onboarding connection selects the native Azure deployment default", () => {
  expect(getAvailableDefaultModel(catalog, null)).toEqual({ providerID: "azure", modelID: "gpt-test" });
});

test("background Azure discovery replaces a temporary catalog selection with its deployment", () => {
  expect(getAvailableDefaultModel(catalog, { providerID: "azure", modelID: "gpt-base" }))
    .toEqual({ providerID: "azure", modelID: "gpt-test" });
});

test("Azure deployment discovery stays with Azure even when Eigenwelt is also connected", () => {
  const list = { ...catalog, all: [provider("eigenwelt", ["hosted"]), azure], connected: ["eigenwelt", "azure"] };
  expect(getAvailableDefaultModel(list, { providerID: "azure", modelID: "gpt-base" }))
    .toEqual({ providerID: "azure", modelID: "gpt-test" });
});

test("an existing usable selection stays unchanged when another provider connects", () => {
  const list = { ...catalog, all: [provider("eigenwelt", ["hosted"]), azure], connected: ["eigenwelt", "azure"] };
  expect(getAvailableDefaultModel(list, { providerID: "azure", modelID: "other-deployment" })).toBeNull();
});

test("only connected providers with available models can initialize the composer", () => {
  expect(getAvailableDefaultModel({ ...catalog, connected: [] }, null)).toBeNull();
  expect(getAvailableDefaultModel({ ...catalog, all: [provider("azure", [])] }, null)).toBeNull();
  const list = { ...catalog, all: [provider("empty", []), azure], connected: ["empty", "azure"] };
  expect(getAvailableDefaultModel(list, null)).toEqual({ providerID: "azure", modelID: "gpt-test" });
});

test("a cold native catalog cannot restore the retired provider the migration just cleared", () => {
  const legacy = provider("opencode", ["flint-40b-free"]);
  const free = provider("eigenwelt-free", ["legacy"]);
  const firstRead = { all: [legacy, free], connected: [legacy.id, free.id], default: { [legacy.id]: "flint-40b-free" } };
  expect(getAvailableDefaultModel(firstRead, null)).toBeNull();
  expect(getConnectedProviderItems(firstRead)).toEqual([]);
  expect(isModelAvailableInConnectedProviders(firstRead, { providerID: legacy.id, modelID: "flint-40b-free" })).toBe(false);
  const connected = { ...firstRead, all: [...firstRead.all, azure], connected: [...firstRead.connected, azure.id] };
  const selection = getAvailableDefaultModel(connected, null);
  expect(selection).toEqual({ providerID: "azure", modelID: "other-deployment" });
  expect(getAvailableDefaultModel(connected, selection)).toBeNull();
});

test("a provider without a native default can initialize from its first available model", () => {
  expect(getAvailableDefaultModel({ ...catalog, default: {} }, null))
    .toEqual({ providerID: "azure", modelID: "other-deployment" });
});

test("a disconnected saved provider does not silently switch to another external account", () => {
  expect(getAvailableDefaultModel(catalog, { providerID: "other-account", modelID: "saved" })).toBeNull();
});

test("Eigenwelt retains its existing recovery behavior", () => {
  const list = { all: [provider("eigenwelt", ["hosted"])], connected: ["eigenwelt"], default: {} };
  expect(getAvailableDefaultModel(list, { providerID: "gone", modelID: "old" }))
    .toEqual({ providerID: "eigenwelt", modelID: "hosted" });
});

const empty = { model: { providerID: "", modelID: "" }, variant: null };
const azModel = (modelID: string) => ({ providerID: "azure", modelID });

test("timekeeping keeps a valid session pick, or recovers the saved profile pick if that session model disappeared", () => {
  const session = { model: azModel("other-deployment"), variant: "high" };
  const saved = azModel("gpt-test");
  expect(resolveTimekeepingChatModel(catalog, session, saved, empty)).toEqual(session);
  expect(resolveTimekeepingChatModel(catalog, { model: azModel("removed"), variant: "high" }, saved, empty))
    .toEqual({ model: saved, variant: null });
});

test("timekeeping uses the project's native default for a missing deployment or a fresh chat", () => {
  const stale = azModel("removed");
  const replacement = { model: azModel("gpt-test"), variant: null };
  expect(resolveTimekeepingChatModel(catalog, undefined, stale, empty)).toEqual(replacement);
  expect(resolveTimekeepingChatModel(catalog, { model: stale, variant: "high" }, undefined, empty)).toEqual(replacement);
  expect(resolveTimekeepingChatModel(catalog, undefined, undefined, empty)).toEqual(replacement);
});

test("timekeeping waits for the catalog and retains an unavailable selection for explicit provider changes", () => {
  const removed = { model: { providerID: "other-account", modelID: "removed" }, variant: "high" };
  expect(resolveTimekeepingChatModel(undefined, removed, undefined, empty)).toEqual(removed);
  expect(resolveTimekeepingChatModel(catalog, removed, undefined, empty)).toEqual(removed);
  expect(resolveTimekeepingChatModel({ ...catalog, connected: [] }, undefined, undefined, empty)).toEqual(empty);
});

test("on-device timekeeping stays local despite an old chat pick or a connected hosted fallback", () => {
  const local = { providerID: "local", modelID: "llama.cpp" };
  const hosted = { model: { providerID: "eigenwelt", modelID: "hosted" }, variant: null };
  const list = { all: [provider("eigenwelt", ["hosted"])], connected: ["eigenwelt"], default: {} };
  expect(resolveTimekeepingChatModel(list, hosted, local, hosted)).toEqual({ model: local, variant: null });
  expect(resolveTimekeepingChatModel(list, undefined, local, hosted)).toEqual({ model: local, variant: null });
  expect(resolveTimekeepingChatModel(list, hosted, hosted.model, hosted)).toEqual(hosted);
});

test("an explicit provider stays authoritative when disconnected, even with a hosted alternative or a stale cloud session", () => {
  const stale = azModel("removed");
  const hosted = { model: { providerID: "eigenwelt", modelID: "hosted" }, variant: null };
  const list = { all: [provider("eigenwelt", ["hosted"])], connected: ["eigenwelt"], default: {} };
  expect(resolveTimekeepingChatModel(list, hosted, stale, empty)).toEqual({ model: stale, variant: null });
  expect(resolveTimekeepingChatModel(list, { model: stale, variant: null }, undefined, hosted)).toEqual({ model: stale, variant: null });
  expect(resolveTimekeepingChatModel(list, undefined, undefined, { model: stale, variant: null })).toEqual(hosted);
});
