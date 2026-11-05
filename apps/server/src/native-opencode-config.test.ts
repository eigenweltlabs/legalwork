import { expect, test } from "bun:test";
import { isRetiredBrowserPlugin, nativeOpencodeConfig } from "./native-opencode-config.js";

test("only the retired managed browser adapter yields to the native replacement", () => {
  const retired = ["opencode-chrome-devtools", "opencode-chrome-devtools@1.0.4", "npm:opencode-chrome-devtools@1.0.4", "file:///private/legalwork-chrome-devtools.js?v=old", "C:\\private\\legalwork-chrome-devtools\\index.js"];
  const custom = ["my-opencode-chrome-devtools", "other-browser", "/custom/opencode-chrome-devtools.js", "/custom/legalwork-chrome-devtools-custom.js", "@opencode/plugin-browser@2.1.4"];
  for (const spec of retired) expect(isRetiredBrowserPlugin(spec)).toBe(true);
  for (const spec of custom) expect(isRetiredBrowserPlugin(spec)).toBe(false);
  const saved = { plugin: [...retired, custom[0]], plugins: custom.slice(1) };
  expect(nativeOpencodeConfig(saved).config.plugins).toEqual(custom);
  expect(saved.plugin).toEqual([...retired, custom[0]]);
});

test("app-owned v1 definitions emit validated native rules, agent state and complete model options", () => {
  const migrated = nativeOpencodeConfig({
    permission: { bash: { "git *": "ask" }, task: "deny", legalwork_project_set_instructions: "ask" },
    provider: { company: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:7/v1", headers: { "X-Fixture": "yes" }, setCacheKey: true }, whitelist: ["model"],
      models: { model: { id: "real-model", tool_call: true, modalities: { input: ["text", "pdf"], output: ["text"] }, limit: { context: 800_000, output: 70_000 },
        options: { reasoningEffort: "high", thinking: { budget: 9000 } }, variants: { strict: { reasoningEffort: "high", custom_field: "keep" } } } } } },
    agent: { legalwork: { prompt: "Stable instructions", temperature: 0.2, mode: "primary" } },
    mcp: { external: { type: "remote", url: "https://example.invalid/mcp", enabled: true, timeout: 77_000, oauth: { clientId: "fixture" } } },
    disabled_providers: ["opencode"], tools: { unused: false }, experimental: { continue_loop_on_deny: true },
  });
  expect(migrated.config.permissions).toContainEqual({ action: "shell", resource: "git *", effect: "ask" });
  expect(migrated.config.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
  expect(migrated.config.providers?.company).toMatchObject({ package: "@opencode/ai/providers/openai-compatible", headers: { "X-Fixture": "yes" }, compatibility: { supportsPromptCacheKey: true } });
  expect(migrated.config.providers?.company.models?.model).toMatchObject({ modelID: "real-model", limit: { context: 800_000, output: 70_000 }, body: { thinking: { budget: 9000 } } });
  expect(migrated.config.agents?.legalwork.system).toBe("Stable instructions");
  expect(migrated.agentRequests.legalwork).toEqual({ temperature: 0.2 });
  expect(migrated.modelFilters.company).toEqual({ allow: ["model"], deny: undefined });
  expect(migrated.config.mcp?.servers?.external).toMatchObject({ disabled: false, timeout: { startup: 77_000, catalog: 77_000, execution: 77_000 }, oauth: { client_id: "fixture" } });
});
test("native definitions preserve independently optional limits and reject malformed fields", () => {
  const input = { providers: { custom: { package: "@opencode/ai/providers/openai-compatible", models: { whole: { limit: { context: 1_000_000 } }, output: { limit: { output: 64_000 } } } } } };
  const { config } = nativeOpencodeConfig(input);
  expect(config.providers?.custom.models?.whole.limit).toEqual({ context: 1_000_000 });
  expect(config.providers?.custom.models?.output.limit).toEqual({ output: 64_000 });
  expect(nativeOpencodeConfig({ ...config }).config).toEqual(config);
  expect(() => nativeOpencodeConfig({ unexpected: true })).toThrow();
});
test("saved subagent depth migrates to its native field without changing existing defaults or explicit native values", () => {
  expect(nativeOpencodeConfig({ subagent_depth: 8 }).config.experimental?.subagent_depth).toBe(8);
  expect(nativeOpencodeConfig({ subagent_depth: 8, experimental: { subagent_depth: 3 } }).config.experimental?.subagent_depth).toBe(3);
  expect(nativeOpencodeConfig({}).config.experimental?.subagent_depth).toBeUndefined();
});
test("disabled legacy reasoning variants cannot reappear as selectable native variants", () => {
  const result = nativeOpencodeConfig({ provider: { custom: { npm: "@ai-sdk/openai-compatible", models: { fixture: { variants: { high: { reasoningEffort: "high" }, removed: { disabled: true } } } } } } });
  expect(result.config.providers?.custom.models?.fixture.variants?.map(item => String(item.id))).toEqual(["high"]);
});
