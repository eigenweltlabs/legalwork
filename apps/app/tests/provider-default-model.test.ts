import { expect, test } from "bun:test";
import type { ProviderListItem, ProviderListView } from "../src/app/types";
import { getAvailableDefaultModel } from "../src/react-app/infra/provider-list-query";

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
