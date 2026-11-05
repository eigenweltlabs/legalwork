import { permissionAction } from "./agent-sandbox/permissions.js";
import { afterEach, describe, expect, test } from "bun:test";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { writeCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import { engineProjectStatus, nativeEngineProjectRegistryPath } from "./engine-project.js";
import { legalworkPluginPath } from "./legalwork-extensions-plugin-path.js";
import {
  buildLegalworkRuntimeSettings,
  keepLegalworkRuntimeConfigFileFresh,
  legalworkRuntimeConfigFilePath,
  managedEngineSettingsFilePath,
  mandatoryRuntimeConfigFilePath,
  writeLegalworkRuntimeConfigFile,
} from "./legalwork-runtime-config.js";
import { managedSettingsFileSchema, readManagedEngineSettings, type ManagedEngineSettings } from "./managed-engine-settings.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import type { NativeConfig } from "./native-opencode-config.js";
import {
  GLOBAL_MCP_ID,
  GLOBAL_PERSONALIZATION_ID,
  GLOBAL_TOOL_PERMISSIONS_ID,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousDb;
});

async function setup() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "legalwork-runtime-config-file-")));
  roots.push(temporary);
  const root = join(temporary, "project");
  await mkdir(root);
  previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(temporary, "runtime.sqlite");
  const config: ServerConfig = {
    configPath: join(temporary, "server.json"),
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { root, config };
}

async function addWorkspace(config: ServerConfig) {
  const directory = join(config.workspaces[0]!.path, "..", "other-project");
  await mkdir(directory);
  config.workspaces.push({ id: "ws_other", name: "Other workspace", path: directory, preset: "starter", workspaceType: "local" });
  config.authorizedRoots.push(directory);
}

async function readSettings(config: ServerConfig, workspaceID = "ws_1") {
  const workspace = config.workspaces.find(item => item.id === workspaceID);
  if (!workspace) throw new Error(`Missing test workspace ${workspaceID}`);
  return readManagedEngineSettings(managedEngineSettingsFilePath(config), workspace.path);
}

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unwritable project does not prevent other projects starting and recovers after access is restored", async () => {
  const { root, config } = await setup();
  await addWorkspace(config);
  const blocked = join(root, ".opencode");
  await mkdir(blocked);
  await chmod(blocked, 0o500);
  try {
    await writeLegalworkRuntimeConfigFile(config, "ws_other");
    expect((await engineProjectStatus(config, config.workspaces[0]!)).state).toBe("configuration_conflict");
    expect((await engineProjectStatus(config, config.workspaces[1]!)).state).toBe("ready");
    const registry = JSON.parse(await readFile(nativeEngineProjectRegistryPath(config), "utf8"));
    expect(registry.projects).toContainEqual({ directory: root, approved: false });
    expect(registry.projects).toContainEqual({ directory: config.workspaces[1]!.path, approved: true });
  } finally { await chmod(blocked, 0o700); }
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  expect((await engineProjectStatus(config, config.workspaces[0]!)).state).toBe("ready");
});

async function readConfigurationFile(path: string) {
  return Schema.decodeUnknownSync(Config.Info)(JSON.parse(await readFile(path, "utf8")), { onExcessProperty: "error" });
}

function pluginTargets(plugins: NativeConfig["plugins"]) {
  return (plugins ?? []).map(plugin => typeof plugin === "string" ? plugin : plugin.package);
}

test.each(["managed", "native-project"] satisfies Array<NonNullable<ServerConfig["engineConfigurationMode"]>>)("%s file permissions ask outside added folders by default and retain specific grants", async engineConfigurationMode => {
  const { root, config } = await setup();
  config.engineConfigurationMode = engineConfigurationMode;
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  expect((await readSettings(config)).configuration.permissions).toContainEqual({ action: "external_directory", resource: "*", effect: "ask" });
  const added = join(root, "..", "added", "*");
  await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ permissions: [{ action: "external_directory", resource: added, effect: "allow" }] }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  expect((await readSettings(config)).configuration.permissions?.filter(rule => rule.action === "external_directory")).toEqual([
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "external_directory", resource: added, effect: "allow" },
  ]);
});

async function bundledSources(plugins: NativeConfig["plugins"]) {
  // Package plugins are resolved by the native host, not bundled directories.
  return Promise.all(pluginTargets(plugins).filter(isAbsolute).map(async target => ({ target, source: await readFile(join(target, "index.js"), "utf8") })));
}

async function expectBundle(sources: Awaited<ReturnType<typeof bundledSources>>, name: string) {
  const original = await readFile(legalworkPluginPath(name), "utf8");
  expect(sources.some(plugin => plugin.source === original)).toBe(true);
}

function watch(config: ServerConfig) {
  const stop = keepLegalworkRuntimeConfigFileFresh(config, "ws_1");
  // Drain the writer after unsubscribing, so fixture cleanup cannot race an
  // already queued fire-and-forget refresh. Assertions still observe refreshes.
  cleanups.push(async () => { stop(); await writeLegalworkRuntimeConfigFile(config, "ws_1"); });
}

async function waitForSettings(config: ServerConfig, predicate: (settings: ManagedEngineSettings) => boolean, workspaceID = "ws_1") {
  let settings = await readSettings(config, workspaceID);
  for (let attempt = 0; attempt < 50 && !predicate(settings); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
    settings = await readSettings(config, workspaceID);
  }
  return settings;
}

test("shared settings notifications refresh each owner's private engine files and stop cleanly", async () => {
  const { config } = await setup();
  const other = { ...config, managedEngineStorageDirectory: join(config.workspaces[0]!.path, "..", "other-engine"), agentSandboxEnabled: false };
  config.agentSandboxEnabled = true;
  await Promise.all([writeLegalworkRuntimeConfigFile(config, "ws_1"), writeLegalworkRuntimeConfigFile(other, "ws_1")]);
  const stop = keepLegalworkRuntimeConfigFileFresh(config, "ws_1");
  const stopOther = keepLegalworkRuntimeConfigFileFresh(other, "ws_1");
  cleanups.push(stop, stopOther);
  await writeRuntimeOpencodeConfig(other, GLOBAL_MCP_ID, () => ({ mcp: { servers: { first: { type: "remote", url: "https://first.example/mcp", disabled: true } } } }));
  for (const owner of [config, other]) {
    expect((await waitForSettings(owner, settings => "first" in (settings.configuration.mcp?.servers ?? {}))).configuration.mcp?.servers).toHaveProperty("first");
  }
  const protectedPolicy = await readConfigurationFile(join(orgPolicyEngineDir(config), "opencode.json"));
  expect(protectedPolicy.policies).toContainEqual({ action: "tool.use", resource: "shell:*", effect: "deny" });
  expect((await readConfigurationFile(join(orgPolicyEngineDir(other), "opencode.json"))).policies).not.toContainEqual({ action: "tool.use", resource: "shell:*", effect: "deny" });
  await stop();
  const stopped = await readFile(managedEngineSettingsFilePath(config), "utf8");
  await writeRuntimeOpencodeConfig(other, GLOBAL_MCP_ID, () => ({ mcp: { servers: { second: { type: "remote", url: "https://second.example/mcp", disabled: true } } } }));
  await stopOther();
  expect(await readFile(managedEngineSettingsFilePath(config), "utf8")).toBe(stopped);
  expect((await readSettings(other)).configuration.mcp?.servers).toHaveProperty("second");
});

test("unchanged managed settings preserve watched file identities while real edits still publish", async () => {
  const { config } = await setup();
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const paths = [
    legalworkRuntimeConfigFilePath(config),
    managedEngineSettingsFilePath(config),
    mandatoryRuntimeConfigFilePath(config),
    join(orgPolicyEngineDir(config), "opencode.json"),
    join(orgPolicyEngineDir(config), "runtime-config.revision"),
  ];
  const before = await Promise.all(paths.map(async path => {
    const info = await stat(path);
    return { ino: info.ino, mtimeMs: info.mtimeMs, content: await readFile(path, "utf8") };
  }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  for (const [index, path] of paths.entries()) {
    const info = await stat(path);
    expect({ ino: info.ino, mtimeMs: info.mtimeMs, content: await readFile(path, "utf8") }).toEqual(before[index]);
  }
  await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current, mcp: { servers: { updated: { type: "remote", url: "https://connector.example/mcp", disabled: true } } } }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  expect(await readFile(managedEngineSettingsFilePath(config), "utf8")).not.toBe(before[1]?.content);
  expect(await readFile(join(orgPolicyEngineDir(config), "runtime-config.revision"), "utf8")).not.toBe(before[4]?.content);
  expect((await stat(managedEngineSettingsFilePath(config))).mode & 0o777).toBe(0o600);
});

test("protected engine configuration retains installed skill discovery", async () => {
  const { root, config } = await setup();
  config.agentSandboxEnabled = true;
  const folder = join(root, ".opencode", "skills", "protected-helper");
  const visible = join(root, "Skills", "wiki-setup");
  await mkdir(visible, { recursive: true });
  await writeFile(join(visible, "SKILL.md"), "---\nname: wiki-setup\ndescription: Set up this wiki\n---\nRead this wiki's guidance.\n");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), "---\nname: protected-helper\ndescription: An installed helper\n---\nUse the protected shell.\n");
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const settings = await readSettings(config);
  expect(settings.configuration.skills).toEqual(expect.arrayContaining([folder, visible]));
  expect(await readFile(join(folder, "SKILL.md"), "utf8")).toContain("Use the protected shell.");
  expect(await readFile(join(visible, "SKILL.md"), "utf8")).toContain("Read this wiki's guidance.");
});

test.each([false, true])("the built-in review worker is registered with sandboxing=%s", async sandboxed => {
  const { config } = await setup();
  config.agentSandboxEnabled = sandboxed;
  await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
    agents: { "document-extractor": { disabled: true, model: Schema.decodeUnknownSync(Config.Info)({ model: "other/model" }).model, system: "Stored override", permissions: [{ action: "*", resource: "*", effect: "allow" }] } },
  }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const settings = await readSettings(config);
  const worker = settings.configuration.agents?.["document-extractor"];
  expect(worker).toMatchObject({
    description: "Internal grounded text inference worker for saved project reviews.",
    mode: "subagent", hidden: true,
    system: expect.stringContaining("Use only the evidence and column definition provided in this request."),
    permissions: expect.arrayContaining([
      { action: "*", resource: "*", effect: "deny" },
      { action: "legalwork_review_submit", resource: "*", effect: "allow" },
    ]),
  });
  expect(worker?.request?.body?.temperature).toBeUndefined();
  expect(worker?.disabled).toBeUndefined();
  expect(worker?.model).toBeUndefined();
  expect(worker?.system).not.toBe("Stored override");
});

test("saved-output access is enabled before user rules and bundled with the runtime", async () => {
  const { config } = await setup();
  await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "deny" }] }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const denied = (await readSettings(config)).configuration;
  expect(denied.permissions).toEqual(expect.arrayContaining([
    { action: "legalwork_tool_output_read", resource: "*", effect: "allow" },
    { action: "legalwork_tool_output_search", resource: "*", effect: "allow" },
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "deny" },
  ]));
  const rules = denied.permissions ?? [];
  expect(rules.findIndex(rule => rule.action === "legalwork_tool_output_read")).toBeLessThan(rules.findIndex(rule => rule.action === "*"));
  await expectBundle(await bundledSources(denied.plugins), "legalwork-tool-output");
  await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "legalwork_tool_output_read", resource: "*", effect: "deny" }] }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const explicit = (await readSettings(config)).configuration.permissions ?? [];
  expect(explicit).toContainEqual({ action: "legalwork_tool_output_read", resource: "*", effect: "deny" });
  expect(permissionAction(explicit, "legalwork_tool_output_read", "*")).toBe("deny");
});

describe("legalwork runtime config files", () => {
  test("shared Firecrawl OAuth settings stay app-owned and do not create an executable project plugin", async () => {
    const { config } = await setup();
    config.engineProjectTrustRequired = true;
    await addWorkspace(config);
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { servers: {
      firecrawl: { type: "remote", url: "https://mcp.firecrawl.dev/v2/mcp-oauth", disabled: false, oauth: {} },
    } } }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    for (const workspace of config.workspaces) {
      const settings = await readSettings(config, workspace.id);
      expect(settings.configuration.mcp?.servers?.firecrawl).toEqual({ type: "remote", url: "https://mcp.firecrawl.dev/v2/mcp-oauth", disabled: false, oauth: {} });
      const review = await engineProjectStatus(config, workspace);
      expect(review.state).toBe("ready");
      expect(review.plugins).toEqual([]);
    }
    // The shared selection is data for the native loader, not an extra host
    // plugin or a connector sign-in implementation owned by LegalWork.
    const common = await readConfigurationFile(legalworkRuntimeConfigFilePath(config));
    expect(common.mcp).toEqual((await readSettings(config)).configuration.mcp);
    expect(pluginTargets(common.plugins).some(target => /firecrawl/i.test(target))).toBe(false);
  });

  test("writes native project MCPs and defaults, with common and mandatory plugin layers", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", current => ({
      ...current,
      mcp: { servers: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", disabled: false } } },
      agents: { reviewer: { mode: "subagent", model: Schema.decodeUnknownSync(Config.Info)({ model: "opencode/big-pickle" }).model } },
    }));
    expect(await writeLegalworkRuntimeConfigFile(config, "ws_1")).toBe(legalworkRuntimeConfigFilePath(config));

    const settings = await readSettings(config);
    const parsed = settings.configuration;
    expect(parsed).toEqual(Schema.decodeUnknownSync(Config.Info)((await buildLegalworkRuntimeSettings(config, "ws_1")).configuration));
    expect(parsed.mcp?.servers?.posthog).toMatchObject({ disabled: false, url: "https://mcp.posthog.com/mcp" });
    expect(parsed.default_agent).toBe("legalwork");
    expect(parsed.providers?.eigenwelt).toBeUndefined();
    expect(parsed.agents?.["legalwork-scheduled-project"]).toMatchObject({ hidden: true, mode: "primary", permissions: expect.arrayContaining([
      { action: "*", resource: "*", effect: "deny" }, { action: "legalwork_project_read", resource: "*", effect: "allow" },
    ]) });
    expect(parsed.agents?.["legalwork-scheduled-all"]).toMatchObject({ hidden: true, mode: "primary", permissions: expect.arrayContaining([
      { action: "legalwork_ui_execute_action", resource: "*", effect: "deny" },
      { action: "legalwork_ui_list_actions", resource: "*", effect: "deny" },
      { action: "legalwork_ui_snapshot", resource: "*", effect: "deny" },
    ]) });
    expect(parsed.agents?.legalwork?.system).toContain("start-tabular-review");
    expect(parsed.agents?.legalwork?.system).toContain("at most one short sentence");
    expect(parsed.agents?.reviewer?.model).toMatchObject({ providerID: "opencode", model: "big-pickle" });

    const common = await readConfigurationFile(legalworkRuntimeConfigFilePath(config));
    expect(common).toMatchObject({ update: "disable", default_agent: "legalwork", experimental: { todo: true } });
    expect(common.agents).toEqual(parsed.agents);
    expect(common.providers ?? {}).toEqual(parsed.providers ?? {});
    expect(common.mcp).toEqual(parsed.mcp);
    const sources = await bundledSources(common.plugins);
    await expectBundle(sources, "legalwork-anthropic-adaptive-thinking");
    await expectBundle(sources, "legalwork-anthropic-tool-schema");
    await expectBundle(sources, "legalwork-scheduled-task-tools");
    expect(sources.some(plugin => plugin.source.includes('id: "legalwork.document-tools"'))).toBe(false);
    expect(sources.some(plugin => plugin.source.includes('id: "anthropic-auth"'))).toBe(false);
    const mandatory = await readConfigurationFile(mandatoryRuntimeConfigFilePath(config));
    expect(pluginTargets(mandatory.plugins)).toContain("-opencode.config.command");
    const guards = await bundledSources(mandatory.plugins?.filter(plugin => typeof plugin !== "string" || !plugin.startsWith("-")));
    await expectBundle(guards, "legalwork-commands");
    await expectBundle(guards, "legalwork-project-admission");
    await expectBundle(guards, "legalwork-managed-config");
    await expectBundle(guards, "legalwork-org-policy-guard");
    await expectBundle(guards, "legalwork-product-scope");
    const workspace = config.workspaces[0]!;
    const status = await engineProjectStatus(config, workspace);
    expect(status.projection.diagnostic).toBeUndefined();
    expect(status.projection.path).toBeString();
    if (!status.projection.path) throw new Error("Missing native project projection");
    const projection = await readFile(status.projection.path, "utf8");
    expect(projection).toContain("{file:");
    expect(projection).not.toContain("https://mcp.posthog.com/mcp");
    expect(projection).not.toContain("start-tabular-review");
  });

  test("bundled plugins use host-resolved directory entrypoints on every platform", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const sources = await bundledSources((await readConfigurationFile(legalworkRuntimeConfigFilePath(config))).plugins);
    expect(sources.length).toBeGreaterThan(0);
    await expectBundle(sources, "legalwork-storage-tools");
    await expectBundle(sources, "legalwork-wiki-tools");
    // The v2 host resolves index.js from the native directory entry. LegalWork
    // no longer passes a bare Windows JS path to dynamic import(), or a v1 URL.
    for (const { target } of sources) {
      expect(isAbsolute(target)).toBe(true);
      expect(target.startsWith("file:")).toBe(false);
      expect(target).not.toContain("?v=");
      expect((await stat(target)).isDirectory()).toBe(true);
      expect((await stat(join(target, "index.js"))).isFile()).toBe(true);
    }
  });

  test("keepLegalworkRuntimeConfigFileFresh rewrites native settings on runtime-DB writes", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    watch(config);
    await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current,
      mcp: { servers: { stripe: { type: "remote", url: "https://mcp.stripe.com", disabled: true } } },
    }));
    const settings = await waitForSettings(config, value => !!value.configuration.mcp?.servers?.stripe);
    expect(settings.configuration.mcp?.servers?.stripe).toMatchObject({ disabled: true, url: "https://mcp.stripe.com" });
  });

  test("writes for unregistered workspaces do not leak into registered settings", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    watch(config);
    const before = await readFile(managedEngineSettingsFilePath(config), "utf8");
    await writeRuntimeOpencodeConfig(config, "ws_other", current => ({ ...current,
      mcp: { servers: { other: { type: "remote", url: "https://example.com/mcp", disabled: false } } },
    }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await readFile(managedEngineSettingsFilePath(config), "utf8")).toBe(before);
    expect((await readSettings(config)).configuration.mcp?.servers?.other).toBeUndefined();
  });

  test("global tool permissions reach every workspace while external directories stay local", async () => {
    const { config } = await setup();
    await addWorkspace(config);
    await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current,
      permissions: [{ action: "external_directory", resource: "/tmp/shared/*", effect: "allow" }],
    }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    watch(config);
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, current => ({ ...current, permissions: [{ action: "shell", resource: "*", effect: "ask" }] }));
    for (const workspaceID of ["ws_1", "ws_other"]) {
      const settings = await waitForSettings(config, value => !!value.configuration.permissions?.some(rule => rule.action === "shell"), workspaceID);
      expect(settings.configuration.permissions).toContainEqual({ action: "shell", resource: "*", effect: "ask" });
      expect(settings.configuration.permissions?.some(rule => rule.action === "external_directory" && rule.resource === "/tmp/shared/*")).toBe(workspaceID === "ws_1");
    }
  });

  test("shared connectors reach every workspace and preserve workspace-specific overrides", async () => {
    const { config } = await setup();
    await addWorkspace(config);
    await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current,
      mcp: { servers: { shared: { type: "remote", url: "https://project.example/mcp", disabled: true } } },
    }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    watch(config);
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, current => ({ ...current,
      mcp: { servers: { shared: { type: "remote", url: "https://shared.example/mcp", disabled: false }, global: { type: "remote", url: "https://global.example/mcp", disabled: false } } },
    }));
    for (const workspaceID of ["ws_1", "ws_other"]) {
      const settings = await waitForSettings(config, value => !!value.configuration.mcp?.servers?.global, workspaceID);
      expect(settings.configuration.mcp?.servers?.global).toMatchObject({ url: "https://global.example/mcp", disabled: false });
      expect(settings.configuration.mcp?.servers?.shared).toMatchObject(workspaceID === "ws_1"
        ? { url: "https://project.example/mcp", disabled: true }
        : { url: "https://shared.example/mcp", disabled: false });
    }
  });

  test("global personalisation rewrites every workspace without restoring retired local memory", async () => {
    const { config } = await setup();
    await addWorkspace(config);
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    watch(config);
    const saved: { customInstructions: string; localMemoriesEnabled: boolean; allowToolAssistedMemory: boolean; personality: "professional" } = {
      customInstructions: "Use concise issue-rule-analysis conclusions.", localMemoriesEnabled: true, allowToolAssistedMemory: false, personality: "professional",
    };
    await writeRuntimeOpencodeConfig(config, GLOBAL_PERSONALIZATION_ID, current => ({ ...current, personalization: saved }));
    for (const workspaceID of ["ws_1", "ws_other"]) {
      const settings = await waitForSettings(config, value => !!value.configuration.agents?.legalwork?.system?.includes("issue-rule-analysis"), workspaceID);
      expect(settings.configuration.agents?.legalwork?.system).toContain("Use concise issue-rule-analysis conclusions.");
      expect(settings.configuration.agents?.legalwork?.system).not.toContain("Local memory policy");
    }
    const sources = await bundledSources((await readConfigurationFile(legalworkRuntimeConfigFilePath(config))).plugins);
    expect(sources.some(plugin => plugin.source.includes('id: "legalwork.agent-memory"'))).toBe(false);
  });

  test("project instruction updates require approval even with broad tool allow rules", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, current => ({ ...current,
      permissions: [{ action: "legalwork_project_set_instructions", resource: "*", effect: "allow" }, { action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }],
    }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const permissions = (await readSettings(config)).configuration.permissions;
    expect(permissions).toEqual(expect.arrayContaining([
      { action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" },
      { action: "legalwork_project_set_instructions", resource: "*", effect: "ask" },
    ]));
    expect(permissionAction(permissions ?? [], "legalwork_project_set_instructions", "*")).toBe("ask");
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, current => ({ ...current, permissions: [{ action: "legalwork_project_set_instructions", resource: "*", effect: "deny" }] }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readSettings(config)).configuration.permissions).toContainEqual({ action: "legalwork_project_set_instructions", resource: "*", effect: "deny" });
  });
});

describe("eigenwelt free provider retirement", () => {
  test("zen is always disabled without duplicating saved provider denials", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current, policies: [{ action: "provider.use", resource: "openrouter", effect: "deny" }, { action: "provider.use", resource: "opencode", effect: "deny" }] }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = (await readSettings(config)).configuration;
    expect(parsed.providers?.["eigenwelt-free"]).toBeUndefined();
    expect(parsed.policies).toContainEqual({ action: "provider.use", resource: "openrouter", effect: "deny" });
    expect(parsed.policies?.filter(rule => rule.action === "provider.use" && rule.resource === "opencode" && rule.effect === "deny")).toHaveLength(1);
  });

  test("zen stays disabled even with an empty runtime DB", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = (await readSettings(config)).configuration;
    expect(parsed.providers?.["eigenwelt-free"]).toBeUndefined();
    expect(parsed.policies).toContainEqual({ action: "provider.use", resource: "opencode", effect: "deny" });
  });

  test("native runtime provider identity, models, and transport settings remain unchanged", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current, providers: { eigenwelt: {
      package: "@opencode/ai/providers/openai-compatible", name: "Eigenwelt Subscription", settings: { baseURL: "https://paid.gateway.test/v1" },
      models: { "ewl-pro": { name: "EWL Pro", limit: { context: 200000, output: 16384 } } },
    } } }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readSettings(config)).configuration.providers?.eigenwelt).toMatchObject({
      name: "Eigenwelt Subscription", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://paid.gateway.test/v1" },
      models: { "ewl-pro": { name: "EWL Pro", limit: { context: 200000, output: 16384 } } },
    });
  });
});

describe("eigenwelt paid provider injection", () => {
  test("serves every registered workspace, whichever one the firm signed in from", async () => {
    const { config } = await setup();
    await addWorkspace(config);
    await writeCachedEigenweltPaidManifest(config, { baseURL: "https://paid.gateway.test/v1", apiKey: "sk-firm-key", models: [{ id: "Eigenwelt Europe" }] });
    await writeEigenweltConnection(config, { platformToken: "access",
      entitlements: parseEigenweltEntitlements({ plan: "plus", features: ["premium_models"] }) ?? null });
    await writeLegalworkRuntimeConfigFile(config, "ws_other");
    const manifest = managedSettingsFileSchema.parse(JSON.parse(await readFile(managedEngineSettingsFilePath(config), "utf8")));
    expect(Object.keys(manifest.workspaces).sort()).toEqual(["ws_1", "ws_other"]);
    for (const workspaceID of ["ws_1", "ws_other"]) {
      expect(Object.keys((await readSettings(config, workspaceID)).configuration.providers?.eigenwelt?.models ?? {})).toEqual(["Eigenwelt Europe"]);
    }
  });
});

test.each([false, true])("an empty Sync manifest removes stale workspace models (BYO connected: %s)", async byo => {
  const { config } = await setup();
  await writeCachedEigenweltPaidManifest(config, { baseURL: "https://paid.gateway.test/v1", apiKey: "paid-key", models: [] });
  await writeEigenweltConnection(config, { platformToken: "access",
    entitlements: parseEigenweltEntitlements({ plan: "sync", features: ["premium_models"] }) ?? null });
  await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current, providers: {
    eigenwelt: { package: "@opencode/ai/providers/openai-compatible", models: { "Eigenwelt Europe": { name: "Old model" } } },
    ...(byo ? { openai: { models: { "gpt-test": { name: "My OpenAI model" } } } } : {}),
  } }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const providers = (await readSettings(config)).configuration.providers;
  if (byo) expect(providers).toMatchObject({ openai: { models: { "gpt-test": { name: "My OpenAI model" } } } });
  else expect(Object.keys(providers ?? {})).toEqual([]);
  expect(providers?.eigenwelt).toBeUndefined();
});


test("only the Assistant registers a browser worker without broadening permissions", async () => {
  const { config } = await setup();
  await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ permissions: [{ action: "browser", resource: "*", effect: "ask" }] }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const ordinary = (await readSettings(config)).configuration;
  expect(ordinary.agents?.["assistant-browser"]).toBeUndefined();
  config.workspaces[0].preset = "main-assistant";
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const assistant = (await readSettings(config)).configuration;
  expect(assistant.agents?.["assistant-browser"]).toMatchObject({ mode: "subagent", system: expect.stringContaining("browser worker") });
  expect(assistant.agents?.["assistant-browser"]?.permissions).toBeUndefined();
  expect(assistant.permissions).toEqual(ordinary.permissions);
});
