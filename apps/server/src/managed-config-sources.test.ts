import { expect, test } from "bun:test";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { commonManagedConfiguration, managedConfigurationDiff } from "./managed-config-sources.js";

const decode = Schema.decodeUnknownSync(Config.Info);

test("only complete identical providers are shared, preserving each project's native model and reasoning declarations", () => {
  const a = decode({ model: "p/one", providers: { p: { settings: { baseURL: "https://a.example" }, models: { one: { name: "First", capabilities: { temperature: false, reasoning: { supported: true, effort: ["low", "high"] } }, variants: [{ id: "deep", settings: { reasoningEffort: "high" } }] } } }, private: { package: "@opencode/ai/providers/openai-compatible", headers: { authorization: "private-value" } } } });
  const b = decode({ model: "p/two", providers: { p: { settings: { baseURL: "https://b.example" }, models: { one: { name: "Second" } } } } });
  const shared = commonManagedConfiguration([a, b]);
  expect(shared.providers).toBeUndefined();
  expect(shared.model).toBeUndefined();
  expect(managedConfigurationDiff(a, shared)).toEqual(a);
  expect(managedConfigurationDiff(b, shared)).toEqual(b);
});

test("project permissions never become a shared source, including for a single project", () => {
  const configuration = decode({ permissions: [{ action: "external_directory", resource: "/private/project-a/*", effect: "allow" }] });
  for (const values of [[configuration], [configuration, configuration]]) {
    const shared = commonManagedConfiguration(values);
    expect(shared.permissions).toBeUndefined();
    expect(managedConfigurationDiff(configuration, shared).permissions).toEqual(configuration.permissions);
  }
});

test("shared complete native declarations need no runtime reconstruction and local overrides stay complete", () => {
  const sharedProvider = { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://shared.example" }, models: { own: { disabled: false, capabilities: { reasoning: { supported: true } } } } };
  const a = decode({ providers: { shared: sharedProvider }, commands: { shared: { template: "Review this document" }, local: { template: "First project" } }, agents: { helper: { system: "First project", model: "shared/own" } } });
  const b = decode({ providers: { shared: sharedProvider }, commands: { shared: { template: "Review this document" }, local: { template: "Second project" } }, agents: { helper: { system: "Second project", model: "shared/own" } } });
  const shared = commonManagedConfiguration([a, b]);
  expect(shared.providers).toEqual(a.providers);
  expect(shared.commands).toEqual({ shared: { template: "Review this document" } });
  expect(shared.agents).toBeUndefined();
  expect(managedConfigurationDiff(a, shared)).toEqual({ commands: { local: { template: "First project" } }, agents: a.agents });
});

test("native shared MCP definitions have one file-backed source", () => {
  const configuration = decode({ mcp: { servers: { shared: { type: "remote", url: "https://example.test/mcp" } } } });
  const shared = commonManagedConfiguration([configuration, configuration]);
  expect(shared.mcp).toEqual(configuration.mcp);
  expect(managedConfigurationDiff(configuration, shared)).toEqual({});
});


test("identical project plugins remain in each native project document", () => {
  const configuration = decode({ plugins: ["/project/plugin", { package: "/project/configured-plugin", options: { scope: "project" } }] });
  for (const values of [[configuration], [configuration, configuration]]) {
    const shared = commonManagedConfiguration(values);
    expect(shared.plugins).toBeUndefined();
    expect(managedConfigurationDiff(configuration, shared).plugins).toEqual(configuration.plugins);
  }
});
