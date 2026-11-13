import { expect, test } from "bun:test";
import { decodeNativeRuntimeConfigRecord, nativeRuntimeConfigRecord, runtimeEngineConfiguration, upgradeRuntimeConfigRecord } from "./runtime-config-upgrade.js";
import { permissionAction } from "./agent-sandbox/permissions.js";

test.each(["deny", "ask", "allow"])("one-time import preserves scalar agent %s as a native wildcard", effect => {
  const saved = { agent: { restricted: { prompt: "Restricted", permission: effect } } };
  const before = JSON.stringify(saved);
  const result = upgradeRuntimeConfigRecord(saved);
  expect(result.configuration.agents?.restricted.permissions).toEqual([{ action: "*", resource: "*", effect }]);
  expect(JSON.stringify(saved)).toBe(before);
});

test("legacy tool switches and explicit wildcard/resource permissions retain their ordered precedence", () => {
  const result = upgradeRuntimeConfigRecord({ agent: { restricted: { tools: { read: true, bash: false }, permission: { "*": "ask", bash: { "git *": "deny", "git status": "allow" }, read: "deny" } } } });
  expect(result.configuration.agents?.restricted.permissions).toEqual([
    { action: "read", resource: "*", effect: "deny" }, { action: "shell", resource: "git *", effect: "deny" },
    { action: "shell", resource: "git status", effect: "allow" }, { action: "*", resource: "*", effect: "ask" },
  ]);
});

test.each(["write", "patch", "apply_patch"])("one-time config import preserves inactive literal %s rules without broadening edit access", name => {
  const permission = { edit: "deny", [name]: "allow" };
  const imported = upgradeRuntimeConfigRecord({ permission, agent: { restricted: { permission } } });
  for (const rules of [imported.configuration.permissions, imported.configuration.agents?.restricted.permissions]) {
    if (!rules) throw new Error("Imported global and agent permissions must remain present");
    expect(rules).toEqual([{ action: "edit", resource: "*", effect: "deny" }, { action: name, resource: "*", effect: "allow" }]);
    expect(permissionAction(rules, "edit", "agreement.docx")).toBe("deny");
  }
});

test("deprecated global write switches cannot override explicit edit permissions", () => {
  const imported = upgradeRuntimeConfigRecord({ tools: { write: true, patch: true }, permission: { edit: "deny" } });
  expect(imported.configuration.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }]);
});

test("native models-only provider overrides, capabilities and array variants survive import and native reload exactly", () => {
  const providers = { openai: { models: { fixture: { capabilities: { temperature: false, reasoning: { supported: true, effort: ["low", "high"] } }, variants: [{ id: "high", settings: { reasoningEffort: "high" } }] } } } };
  const result = upgradeRuntimeConfigRecord({ providers });
  expect(result.configuration.providers).toMatchObject(providers);
  const saved = nativeRuntimeConfigRecord(result);
  const reopened = decodeNativeRuntimeConfigRecord(JSON.parse(JSON.stringify(saved)));
  expect(reopened.migrated).toBe(false);
  expect(reopened.configuration.providers).toMatchObject(providers);
  expect(runtimeEngineConfiguration(saved)).toEqual(result.configuration);
});

test("top-level native namespaces take precedence over separately imported legacy namespaces", () => {
  const providers = { fixture: { models: { native: { limit: { context: 1_000_000 }, capabilities: { temperature: false } } } } };
  const agents = { fixture: { system: "Native", permissions: [{ action: "*", resource: "*", effect: "deny" }] } };
  const result = upgradeRuntimeConfigRecord({ provider: { fixture: { npm: "@ai-sdk/openai-compatible", models: { old: { tool_call: true } } } }, agent: { fixture: { prompt: "Legacy", permission: "allow" } }, providers, agents });
  expect(result.configuration.providers).toEqual(providers);
  expect(result.configuration.agents).toMatchObject(agents);
});

test("explicit legacy generation intent is retained natively with a non-secret upgrade notice and no sidecar", () => {
  const result = upgradeRuntimeConfigRecord({ agent: { legalwork: { prompt: "Stable", temperature: 0.2, top_p: 0.8, options: { private_provider_option: "synthetic-private-value" } } } });
  expect(result.configuration.agents?.legalwork.request?.body).toEqual({ temperature: 0.2, top_p: 0.8, private_provider_option: "synthetic-private-value" });
  expect(result).not.toHaveProperty("agentRequests");
  expect(result.notices).toEqual([{ code: "legacy_agent_generation_requires_native_support", agentId: "legalwork", fields: ["private_provider_option", "temperature", "top_p"] }]);
  expect(JSON.stringify(result.notices)).not.toContain("synthetic-private-value");
});

test("native application metadata is separated from the native engine document", () => {
  const result = upgradeRuntimeConfigRecord({ sandbox: { enabled: true, networkMode: "approve" }, personalization: { customInstructions: "Keep", personality: "professional" }, providerActivation: { fixture: "deny" }, providers: { fixture: { settings: { apiKey: "synthetic-private-key" } } } });
  expect(result.application).toEqual({ sandbox: { enabled: true, networkMode: "approve" }, personalization: { customInstructions: "Keep", personality: "professional" }, providerActivation: { fixture: "deny" } });
  expect(result.configuration).not.toHaveProperty("sandbox");
  expect(result.configuration.providers?.fixture.settings?.apiKey).toBe("synthetic-private-key");
});

test.each([
  ["azure-cognitive-services", "azure"],
  ["google-vertex-anthropic", "google-vertex"],
])("retired provider %s migrates every saved selection and access control to %s", (oldID, id) => {
  const source = { provider: { [oldID]: { whitelist: ["selected"], models: { selected: {}, excluded: {} } } },
    agent: { legalwork: { model: `${oldID}/selected`, variant: "high" } }, model: `${oldID}/selected#low`,
    enabled_providers: [oldID], disabled_providers: [oldID],
    providerActivation: { [oldID]: "deny" }, providerModelSelection: { [oldID]: ["selected"] } };
  const original = JSON.stringify(source);
  const imported = upgradeRuntimeConfigRecord(source);
  expect(Object.keys(imported.configuration.providers ?? {})).toEqual([id]);
  expect(Object.keys(imported.configuration.providers?.[id].models ?? {})).toEqual(["selected"]);
  expect(imported.configuration.agents?.legalwork.model).toMatchObject({ providerID: id, model: "selected", variant: "high" });
  expect(imported.configuration.model).toMatchObject({ providerID: id, model: "selected", variant: "low" });
  expect(imported.configuration.policies).toEqual([
    { action: "provider.use", resource: "*", effect: "deny" },
    { action: "provider.use", resource: id, effect: "allow" },
    { action: "provider.use", resource: id, effect: "deny" },
  ]);
  expect(imported.application).toEqual({ providerActivation: { [id]: "deny" }, providerModelSelection: { [id]: ["selected"] } });
  expect(JSON.stringify(source)).toBe(original);
  expect(upgradeRuntimeConfigRecord(nativeRuntimeConfigRecord(imported)).migrated).toBe(false);
});

test("Azure migration restores its implicit endpoint without treating the resource name as an API key", () => {
  const imported = upgradeRuntimeConfigRecord({ provider: { "azure-cognitive-services": {
    npm: "@ai-sdk/openai-compatible", env: ["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY"],
    options: { apiKey: "synthetic-key", headers: { "X-Firm": "fixture" }, body: { retained: true } },
  } } });
  expect(imported.configuration.providers?.azure).toMatchObject({
    env: ["AZURE_COGNITIVE_SERVICES_API_KEY"], package: "@opencode/ai/providers/openai-compatible",
    settings: { apiKey: "synthetic-key", baseURL: "https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.cognitiveservices.azure.com/openai" },
    headers: { "X-Firm": "fixture" }, body: { retained: true },
  });
});

test.each(["api", "options"])("Azure migration preserves an explicit %s endpoint", field => {
  const endpoint = "https://custom.example.invalid/openai";
  const imported = upgradeRuntimeConfigRecord({ provider: { "azure-cognitive-services": {
    npm: "@ai-sdk/openai-compatible", ...(field === "api" ? { api: endpoint } : { options: { baseURL: endpoint } }),
  } } });
  expect(imported.configuration.providers?.azure.settings?.baseURL).toBe(endpoint);
});

test.each([undefined, "@ai-sdk/google-vertex/anthropic"])("Vertex moves the Claude package to individual models (package=%s)", npm => {
  const imported = upgradeRuntimeConfigRecord({ provider: { "google-vertex-anthropic": { npm,
    options: { project: "synthetic-project", location: "europe-west3" },
    models: { inherited: {}, explicit: { provider: { npm: "@ai-sdk/openai-compatible" } } },
  } } });
  const provider = imported.configuration.providers?.["google-vertex"];
  expect(provider?.package).toBeUndefined();
  expect(provider?.settings).toEqual({ project: "synthetic-project", location: "europe-west3" });
  expect(provider?.models?.inherited.package).toBe("aisdk:@ai-sdk/google-vertex/anthropic");
  expect(provider?.models?.explicit.package).toBe("@opencode/ai/providers/openai-compatible");
});

test.each([false, true])("canonical provider settings win collisions regardless of entry order (reverse=%s)", reverse => {
  const entries: Array<[string, unknown]> = [["azure", { name: "Current", whitelist: ["current"] }], ["azure-cognitive-services", { name: "Old", whitelist: ["old"] }]];
  if (reverse) entries.reverse();
  const imported = upgradeRuntimeConfigRecord({ provider: Object.fromEntries(entries),
    providerActivation: { azure: "allow", "azure-cognitive-services": "deny" } });
  expect(imported.configuration.providers?.azure.name).toBe("Current");
  expect(imported.application).toEqual({ providerActivation: { azure: "allow" }, providerModelSelection: { azure: ["current"] } });
  const native = upgradeRuntimeConfigRecord({ provider: { "azure-cognitive-services": { whitelist: ["old"] } },
    providers: { azure: { name: "Native" } }, providerModelSelection: { azure: ["native"] } });
  expect(native.configuration.providers).toEqual({ azure: { name: "Native" } });
  expect(native.application.providerModelSelection).toEqual({ azure: ["native"] });
});

test("startup repairs already migrated provider references while ordinary native decoding stays unchanged", () => {
  const source = { configurationVersion: 2, providers: { "google-vertex-anthropic": {
    package: "aisdk:@ai-sdk/google-vertex/anthropic", models: { selected: { disabled: true } },
  } }, agents: { legalwork: { model: { providerID: "google-vertex-anthropic", model: "selected" } } },
    policies: [{ action: "provider.use", resource: "google-vertex-anthropic", effect: "deny" },
      { action: "tool.use", resource: "google-vertex-anthropic", effect: "deny" }],
    providerModelSelection: { "google-vertex-anthropic": [] } };
  expect(decodeNativeRuntimeConfigRecord(source).configuration.providers).toHaveProperty("google-vertex-anthropic");
  const imported = upgradeRuntimeConfigRecord(source);
  expect(imported.migrated).toBe(true);
  expect(imported.configuration.providers?.["google-vertex"].models?.selected).toMatchObject({ disabled: true, package: "aisdk:@ai-sdk/google-vertex/anthropic" });
  expect(String(imported.configuration.agents?.legalwork.model?.providerID)).toBe("google-vertex");
  expect(imported.configuration.policies).toEqual([{ action: "provider.use", resource: "google-vertex", effect: "deny" },
    { action: "tool.use", resource: "google-vertex-anthropic", effect: "deny" }]);
  expect(imported.application.providerModelSelection).toEqual({ "google-vertex": [] });
});

test("normal native writes reject legacy keys, unknown fields and future record versions", () => {
  for (const value of [{ configurationVersion: 2, agent: {} }, { configurationVersion: 2, providers: {}, permission: "deny" }, { configurationVersion: 2, unexpected: true }, { configurationVersion: 3 }]) {
    expect(() => decodeNativeRuntimeConfigRecord(value)).toThrow();
  }
  expect(() => upgradeRuntimeConfigRecord({ agent: { broken: { permission: "invalid" } } })).toThrow();
  expect(() => upgradeRuntimeConfigRecord({ permission: { read: { "*": "invalid" } } })).toThrow();
  expect(() => upgradeRuntimeConfigRecord({ policies: "deny" })).toThrow();
  expect(() => upgradeRuntimeConfigRecord({ plugins: "mandatory-security-plugin" })).toThrow();
  expect(() => upgradeRuntimeConfigRecord({ mcp: { fixture: { type: "remote", url: "https://example.invalid/mcp", enabled: "false" } } })).toThrow();
});

test("native reasoning declarations that differ between projects remain intact without model disabling", () => {
  for (const effort of [["low", "high"], ["low", "medium", "high"]]) {
    const result = upgradeRuntimeConfigRecord({ providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", models: { custom: { capabilities: { reasoning: { supported: true, effort } } } } } } });
    expect(result.configuration.providers?.fixture.models?.custom.capabilities?.reasoning).toEqual({ supported: true, effort });
    expect(result.configuration.providers?.fixture.models?.custom.disabled).toBeUndefined();
  }
});

test("one-time connector envelope import preserves a legacy connector named servers and exact native configuration", () => {
  expect(upgradeRuntimeConfigRecord({ mcp: { servers: { type: "local", command: ["fixture-program"], enabled: false } } }).configuration.mcp?.servers?.servers)
    .toMatchObject({ type: "local", command: ["fixture-program"], disabled: true });
  const configuration = { mcp: { timeout: { startup: 1000 }, servers: { native: { type: "remote", url: "https://fixture.invalid/mcp", disabled: true, oauth: { client_id: "fixture", scope: "read" } } } } };
  expect(upgradeRuntimeConfigRecord(configuration).configuration).toMatchObject(configuration);
});

test.each([undefined, 1, 2])("startup import repairs nested MCP fields in saved version %s without changing restrictions", version => {
  for (const enabled of [true, false]) {
    const saved = { configurationVersion: version, permissions: [{ action: "shell", resource: "*", effect: "deny" }],
      mcp: { timeout: { startup: 1000 }, servers: { fibery: { type: "remote", url: "https://fixture.invalid/mcp", enabled,
        headers: { Authorization: "Bearer synthetic-token" }, timeout: 77000,
        oauth: { clientId: "synthetic-client", clientSecret: "synthetic-secret", scope: "read", callbackPort: 12345 } } } } };
    const original = JSON.stringify(saved);
    expect(() => decodeNativeRuntimeConfigRecord(saved)).toThrow();
    const imported = upgradeRuntimeConfigRecord(saved);
    expect(imported.migrated).toBe(true);
    expect(imported.configuration.mcp).toEqual({ timeout: { startup: 1000 }, servers: { fibery: {
      type: "remote", url: "https://fixture.invalid/mcp", disabled: !enabled, headers: { Authorization: "Bearer synthetic-token" },
      timeout: { startup: 77000, catalog: 77000, execution: 77000 },
      oauth: { client_id: "synthetic-client", client_secret: "synthetic-secret", scope: "read", callback_port: 12345 },
    } } });
    expect(imported.configuration.permissions).toEqual([{ action: "shell", resource: "*", effect: "deny" }]);
    const reopened = upgradeRuntimeConfigRecord(nativeRuntimeConfigRecord(imported));
    expect(reopened.migrated).toBe(false);
    expect(reopened.configuration).toEqual(imported.configuration);
    expect(JSON.stringify(saved)).toBe(original);
  }
});

test("nested MCP repairs reject conflicting switches and unrelated invalid native fields", () => {
  const definition = { type: "remote", url: "https://fixture.invalid/mcp", enabled: true };
  for (const invalid of [
    { ...definition, enabled: "true" }, { ...definition, enabled: null }, { ...definition, disabled: true },
    { ...definition, disabled: "false" }, { ...definition, unexpected: true }, { ...definition, oauth: { unexpected: true } },
    { ...definition, oauth: { client_id: null, clientId: "synthetic-client" } },
  ]) {
    for (const version of [undefined, 2]) expect(() => upgradeRuntimeConfigRecord({ configurationVersion: version, mcp: { servers: { fibery: invalid } } })).toThrow();
  }
  expect(() => upgradeRuntimeConfigRecord({ configurationVersion: 2, permission: "allow", mcp: { servers: { fibery: definition } } })).toThrow();
  expect(() => upgradeRuntimeConfigRecord({ configurationVersion: 3, mcp: { servers: { fibery: definition } } })).toThrow();
  expect(upgradeRuntimeConfigRecord({ configurationVersion: 2, mcp: { servers: { fibery: { ...definition, disabled: false } } } }).configuration.mcp?.servers?.fibery)
    .toEqual({ type: "remote", url: "https://fixture.invalid/mcp", disabled: false });
});

test("legacy explicit model exclusions become native disabled models and allowlists never silently broaden", () => {
  const imported = upgradeRuntimeConfigRecord({ provider: { fixture: { blacklist: ["blocked"], models: { kept: { tool_call: true }, blocked: { tool_call: true } } } } });
  expect(imported.configuration.providers?.fixture.models?.blocked.disabled).toBe(true);
  expect(imported.configuration.providers?.fixture.models?.kept.disabled).toBeUndefined();
  expect(upgradeRuntimeConfigRecord({ provider: { fixture: { whitelist: ["kept"] } } }).application.providerModelSelection).toEqual({ fixture: ["kept"] });
  expect(upgradeRuntimeConfigRecord({ provider: { fixture: { whitelist: [] } } }).application.providerModelSelection).toEqual({ fixture: [] });
  expect(() => upgradeRuntimeConfigRecord({ provider: { fixture: { whitelist: "kept" } } })).toThrow("string list");
});

test("only the retired LegalWork browser plugin is replaced during the one-time import", () => {
  const result = upgradeRuntimeConfigRecord({ plugin: ["opencode-chrome-devtools@1.0.4", "my-opencode-chrome-devtools", "/custom/legalwork-chrome-devtools-custom.js"] });
  expect(result.configuration.plugins).toEqual(["my-opencode-chrome-devtools", "/custom/legalwork-chrome-devtools-custom.js"]);
  expect(result.notices).toEqual([{ code: "retired_managed_browser_replaced", fields: ["plugins"] }]);
});
