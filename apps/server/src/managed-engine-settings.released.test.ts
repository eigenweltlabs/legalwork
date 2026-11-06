import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { managedSettingsRpc } from "./managed-engine-settings.js";
import { commonManagedConfiguration } from "./managed-config-sources.js";
import { runtimeEngineConfiguration } from "./runtime-config-upgrade.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("released native files keep two projects isolated across edits and permission-metadata refresh", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-settings-")));
  const plugin = join(root, "plugin"), first = join(root, "first"), second = join(root, "second");
  await Promise.all([plugin, first, second, "home", "config", "data", "state", "cache"].map(path => mkdir(path.startsWith(root) ? path : join(root, path), { recursive: true })));
  const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./opencode-plugins/legalwork-managed-config.ts", import.meta.url))],
    outdir: plugin, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
  if (!build.success) throw new AggregateError(build.logs, "Managed adapter fixture must build");
  const settingsPath = join(root, "settings.json");
  const entry = (directory: string, label: string) => ({ directory,
    configuration: { default_agent: "legalwork", agents: { legalwork: { system: `Instructions for ${label}` } },
      providers: { ...(label === "first" ? { openai: { models: { "project-only": { name: "Only in first project" } } } } : {}), fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:7/v1" }, models: { [label]: { capabilities: { tools: true, reasoning: { supported: true } },
        limit: { context: 800_000, output: 70_000 }, variants: [{ id: "custom", settings: { temperature: label === "first" ? 0.1 : 0.8 } }] } } } },
      skills: [join(directory, "shared-name")],
      mcp: { servers: { [label]: { type: "remote", url: "https://example.invalid/mcp", disabled: true } } } },
    providerActivation: {}, projectPermissionApprovals: [],
  });
  const settings = { version: 2, workspaces: { first: entry(first, "first"), second: entry(second, "second") },
    sharedConfiguration: commonManagedConfiguration([entry(first, "first"), entry(second, "second")].map(value => runtimeEngineConfiguration(value.configuration))) };
  await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  for (const [directory, label] of [[first, "first"], [second, "second"]]) {
    const skill = join(directory, "shared-name"); await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), `---\nname: Shared skill\ndescription: fixture\n---\nSkill for ${label}`);
    await writeFile(join(directory, "opencode.jsonc"), `// Authored native project configuration\n${JSON.stringify({ ...entry(directory, label).configuration, skills: [skill] })}`);
  }
  const engine = await createManagedOpencodeServer({ bin: binary, cwd: root, timeoutMs: 30_000, env: {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_DB: join(root, "engine.db"),
    OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...settings.sharedConfiguration, update: "disable", plugins: [{ package: plugin, options: { settingsPath } }] }),
  } });
  try {
    const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    await client.location.get({ location: { directory: first } });
    await client.model.list({ location: { directory: first } });
    await client.integration.connect.key({ integrationID: "openai", key: "synthetic-catalog-test", location: { directory: first } });
    const plugins = (await client.plugin.list({ location: { directory: first } })).data;
    const failed = plugins.filter(plugin => plugin.state.status === "failed");
    expect(failed, JSON.stringify(failed)).toEqual([]);
    const entries = await client.config.get({ location: { directory: first } });
    expect(plugins.some(plugin => plugin.id === "legalwork.managed-config"), JSON.stringify({ plugins: plugins.filter(plugin => plugin.source.type !== "builtin"), configKeys: entries.map(entry => entry.type === "document" ? Object.keys(entry.info) : "directory") })).toBe(true);
    for (const [directory, label] of [[first, "first"], [second, "second"]]) {
      const location = { directory };
      await client.location.get({ location });
      await client.model.list({ location });
      expect((await client.agent.get({ location, agentID: "legalwork" })).data.system).toBe(`Instructions for ${label}`);
      expect((await client.model.list({ location })).data.filter(model => model.providerID === "fixture").map(model => model.id)).toEqual([label]);
      // A provider configured in one project must not hide the signed-in
      // native catalog in every other project. Its added models stay local.
      const openai = (await client.model.list({ location })).data.filter(model => model.providerID === "openai");
      expect(openai.length).toBeGreaterThan(1);
      expect(openai.some(model => model.id === "project-only")).toBe(label === "first");
      const model = (await client.model.list({ location })).data.find(model => model.providerID === "fixture" && model.id === label);
      expect(model?.limit).toMatchObject({ context: 800_000, output: 70_000 });
      expect(model?.variants.find(variant => variant.id === "custom")?.settings?.temperature).toBe(label === "first" ? 0.1 : 0.8);
      expect((await client.skill.list({ location })).data.find(skill => skill.id === "shared-name")?.content).toBe(`Skill for ${label}`);
      expect((await client.mcp.list({ location })).data.map(server => server.name)).toEqual([label]);
    }
    settings.workspaces.first = entry(first, "changed");
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    await writeFile(join(first, "opencode.jsonc"), `// Authored native project configuration\n${JSON.stringify({ ...entry(first, "changed").configuration, skills: [join(first, "shared-name")] })}`);
    // Native file watching owns configuration updates. The private metadata
    // refresh must neither reconstruct configuration nor cancel engine work.
    expect(await client.rpc(managedSettingsRpc).refresh({}, { location: { directory: first } })).toEqual({ refreshed: true });
    const deadline = Date.now() + 10_000;
    while (!(await client.model.list({ location: { directory: first } })).data.some(model => model.providerID === "fixture" && model.id === "changed")) {
      if (Date.now() > deadline) throw new Error("Native project configuration watcher did not update the provider catalog");
      await Bun.sleep(20);
    }
    expect(await client.rpc(managedSettingsRpc).refresh({}, { location: { directory: first } })).toEqual({ refreshed: true });
    expect((await client.model.list({ location: { directory: first } })).data.filter(model => model.providerID === "fixture").map(model => model.id)).toEqual(["changed"]);
    expect((await client.model.list({ location: { directory: second } })).data.filter(model => model.providerID === "fixture").map(model => model.id)).toEqual(["second"]);
    expect(await client.session.active()).toEqual({});
    // No model prompt, MCP connection, or outbound inference is submitted.
    expect((await readFile(settingsPath, "utf8")).includes("changed")).toBe(true);
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
}, 45_000);
