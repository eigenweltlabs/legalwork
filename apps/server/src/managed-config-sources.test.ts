import { expect, test } from "bun:test";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { commonManagedConfiguration, managedConfigurationDiff } from "./managed-config-sources.js";

const decode = Schema.decodeUnknownSync(Config.Info);
test("shared native sources retain distinct custom reasoning models and atomic model references", () => {
  const a = decode({ model: "p/one", agents: { helper: { model: "p/one" } }, providers: { p: { settings: { baseURL: "https://a.example" }, models: { one: { name: "Shared", capabilities: { reasoning: { supported: true, effort: ["low", "high"] } }, variants: [{ id: "deep", settings: { reasoningEffort: "high" } }] } } }, custom: { package: "@opencode/ai/providers/openai-compatible", models: { own: { capabilities: { reasoning: { supported: true } } } } } } });
  const b = decode({ model: "p/two", agents: { helper: { model: "p/two" } }, providers: { p: { settings: { baseURL: "https://b.example" }, models: { one: { name: "Changed", capabilities: { reasoning: { supported: true, effort: ["low", "high"] } }, variants: [{ id: "deep", settings: { reasoningEffort: "high" } }] } } } } });
  const shared = commonManagedConfiguration([a, b]);
  expect(shared.model).toBeUndefined(); expect(shared.agents?.helper?.model).toBeUndefined();
  expect(shared.providers?.p?.settings?.baseURL).toBeUndefined();
  expect(shared.providers?.p?.models?.one?.capabilities?.reasoning).toEqual({ supported: true, effort: ["low", "high"] });
  expect(shared.providers?.custom?.models?.own?.capabilities?.reasoning).toEqual({ supported: true });
  expect(managedConfigurationDiff(a, shared)).toMatchObject({ model: { providerID: "p", model: "one" }, providers: { p: { settings: { baseURL: "https://a.example" }, models: { one: { name: "Shared" } } } } });
  expect(managedConfigurationDiff(b, shared)).toMatchObject({ agents: { helper: { model: { providerID: "p", model: "two" } } } });
});

test("conflicting reasoning controls remain whole deltas and local activation cannot be undone by a shared false", () => {
  const configs = [true, false].map((supported, index) => decode({ providers: { p: { models: { own: { disabled: index === 0, capabilities: { reasoning: { supported } } } } } } }));
  const shared = commonManagedConfiguration(configs);
  expect(shared.providers?.p?.models?.own?.capabilities?.reasoning).toBeUndefined();
  expect(shared.providers?.p?.models?.own?.disabled).toBeUndefined();
  for (const configuration of configs) expect(managedConfigurationDiff(configuration, shared).providers?.p?.models?.own).toMatchObject(configuration.providers!.p!.models!.own!);
});

test("MCP definitions have one location-scoped owner rather than a stale file-backed duplicate", () => {
  const configuration = decode({ mcp: { servers: { shared: { type: "remote", url: "https://example.test/mcp" } } } });
  const shared = commonManagedConfiguration([configuration, configuration]);
  expect(shared.mcp).toBeUndefined();
  expect(managedConfigurationDiff(configuration, shared).mcp).toEqual(configuration.mcp);
});
