import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { discoverPluginImports, parsePluginImportRequest, resolvePluginImports } from "./plugin-imports.js";
import { installPluginImport } from "./plugin-import-install.js";
import { pluginNamespace, readInstalledCloudPlugins, removeCloudPlugin, resolveWorkspaceInstallPath } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { createdPluginId, parsePluginCreateRequest, planPluginCreation, pluginCreateOptions } from "./plugin-create.js";
import { globalSkillsDir } from "./workspace-files.js";
import { startServer } from "./server.js";
import { runtimeMcpMapForWorkspace } from "./mcp.js";
import type { PluginImportRequest } from "@legalwork/types/plugin-import";
import type { ServerConfig } from "./types.js";

const skill = "---\nname: search\ndescription: Patent search\nmetadata:\n  jurisdiction: EU\n---\nRead [guide](./references/guide.md). Run ${CLAUDE_PLUGIN_ROOT}/bin/tool and ${CLAUDE_SKILL_DIR}/scripts/run.py.\n";
const fixtures = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "patent", version: "1.0.0", skills: ["./extra-skills/"], mcpServers: ["./config/mcp.json", { remote: { url: "https://override.example/mcp" } }], hooks: "./hooks/hooks.json" }),
  ".mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://default.example/mcp" }, local: { command: "${CLAUDE_PLUGIN_ROOT}/bin/tool", args: ["./server.js"], env: { API_KEY: "${PATENT_KEY}" } } } }),
  "config/mcp.json": JSON.stringify({ mcpServers: { second: { url: "https://second.example/mcp" } } }),
  "skills/search/SKILL.md": skill,
  "skills/search/references/guide.md": "Reference data",
  "skills/search/scripts/run.py": "print('hello')",
  "extra-skills/review/SKILL.md": "---\nname: review\ndescription: Review a claim\n---\nReview.",
  "agents/examiner.md": "---\nname: examiner\ndescription: Patent examiner\nmodel: sonnet\n---\nExamine.",
  "commands/run.md": "---\ndescription: Start workflow\nagent: examiner\n---\nUse patent:search.",
  "hooks/hooks.json": "{\"hooks\":{}}",
  "bin/tool": "#!/bin/sh\necho ok\n",
  "server.js": "console.log('server')",
  "assets/icon.png": new Uint8Array([0, 255, 128, 0, 80]),
  "README.md": "Plugin readme",
};
type FixtureFiles = Record<string, string | Uint8Array>;
function archive(files: FixtureFiles, prefix = ""): string { return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [`${prefix}${path}`, typeof value === "string" ? strToU8(value) : value])))).toString("base64"); }
function request(files: FixtureFiles = fixtures): PluginImportRequest { return { source: { provider: "claude", zipBase64: archive(files, "export/patent/") }, scope: "project" }; }
async function temp(fn: (root: string, config: ServerConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-plugin-import-"));
  const previous = { db: process.env.LEGALWORK_RUNTIME_DB, xdg: process.env.XDG_CONFIG_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.XDG_CONFIG_HOME = join(root, "global");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "config.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [{ id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  try { await fn(root, config); } finally {
    for (const [key, value] of [["LEGALWORK_RUNTIME_DB", previous.db], ["XDG_CONFIG_HOME", previous.xdg], ["CLAUDE_CONFIG_DIR", previous.claude]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
    await rm(root, { recursive: true, force: true });
  }
}
async function writeFixture(root: string, files: FixtureFiles) { for (const [path, value] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value, { mode: path === "bin/tool" ? 0o755 : 0o600 }); } }

describe("complete plugin imports", () => {
  test("creation lists personal items without project skills or credential values", async () => temp(async (root, config) => {
    await writeFixture(globalSkillsDir(), { "claim-review/SKILL.md": "---\nname: claim-review\ndescription: Review patent claims\n---\nReview." });
    await writeFixture(join(root, ".opencode/skills"), { "project-only/SKILL.md": "---\nname: project-only\ndescription: Project only\n---\nProject." });
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { linear: { type: "remote", url: "https://linear.example/mcp", headers: { Authorization: "secret" } } } }));
    const options = await pluginCreateOptions(config);
    expect(options.skills.map(item => item.name)).toEqual(["claim-review"]);
    expect(options.connectors).toEqual([{ name: "linear" }]);
    expect(JSON.stringify(options)).not.toContain("secret");
  }));

  test("created plugins own complete skill copies and connectors; removal preserves the originals", async () => temp(async (root, config) => {
    const source = { "claim-review/SKILL.md": "---\nname: claim-review\ndescription: Review claims\nmetadata:\n  jurisdiction: EU\n---\nRead [guide](./references/guide.md).", "claim-review/references/guide.md": "Review guide", "claim-review/scripts/run.py": "print('review')" };
    await writeFixture(globalSkillsDir(), source);
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => ({ mcp: { linear: { type: "remote", url: "https://linear.example/mcp", enabled: true, oauth: {} } } }));
    const plan = await planPluginCreation(config, root, parsePluginCreateRequest({ name: "Patent Toolkit", description: "Draft and review", skills: ["claim-review"], connectors: ["linear"] }));
    expect(plan.preview.id).toBe("local:patent-toolkit:global");
    expect(plan.resolved.plugin.sourceKind).toBe("plugin");
    expect(plan.resolved.plugin.displayName).toBe("Patent Toolkit");
    const installed = await installPluginImport(config, "test", root, plan, true);
    expect(installed.files.filter(file => file.objectType !== "bundle")).toHaveLength(2);
    const copiedSkill = plan.preview.components.find(item => item.type === "skill")!;
    const copiedConnector = plan.preview.components.find(item => item.type === "mcp")!;
    const namespace = pluginNamespace(plan.preview.name, plan.preview.id);
    const skillFolder = join(globalSkillsDir(), namespace, copiedSkill.installedName);
    expect(await readFile(join(skillFolder, "references/guide.md"), "utf8")).toBe("Review guide");
    expect(await readFile(join(skillFolder, "SKILL.md"), "utf8")).toContain("jurisdiction: EU");
    expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.[copiedConnector.installedName]?.enabled).toBe(false);
    await removeCloudPlugin({ serverConfig: config, workspaceId: GLOBAL_MCP_ID, workspaceRoot: root, pluginId: installed.pluginId, scope: "global" });
    expect(await readFile(join(globalSkillsDir(), "claim-review/SKILL.md"), "utf8")).toBe(source["claim-review/SKILL.md"]);
    expect(Object.keys((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp ?? {})).toEqual(["linear"]);
    expect((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[installed.pluginId]).toBeUndefined();
  }));

  test("bundling an imported skill also copies and rebases its original package resources", async () => temp(async (root, config) => {
    const [original] = await resolvePluginImports({ ...request(), scope: "global" }, root);
    await installPluginImport(config, "test", root, original!, true);
    const selected = original!.preview.components.find(item => item.type === "skill")!;
    const created = await planPluginCreation(config, root, { name: "Independent toolkit", skills: [selected.installedName], connectors: [] });
    const plugin = await installPluginImport(config, "test", root, created, true);
    const createdSkill = created.preview.components.find(item => item.type === "skill")!;
    const copied = await readFile(join(globalSkillsDir(), pluginNamespace(created.preview.name, created.preview.id), createdSkill.installedName, "SKILL.md"), "utf8");
    expect(copied).toContain(`/resources/${pluginNamespace(original!.preview.name, original!.preview.id)}/`);
    expect(copied).not.toContain(`imported-plugins/${pluginNamespace(original!.preview.name, original!.preview.id)}/`);
    await removeCloudPlugin({ serverConfig: config, workspaceId: GLOBAL_MCP_ID, workspaceRoot: root, pluginId: original!.preview.id, scope: "global" });
    const guide = copied.match(/\]\(([^)]+)\)/)?.[1];
    expect(guide).toBeDefined();
    expect(await readFile(guide!, "utf8")).toBe("Reference data");
    expect(created.resourceFiles.some(file => file.path.includes("/resources/") && file.path.endsWith("bin/tool"))).toBe(true);
    expect((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[plugin.pluginId]).toBeDefined();
  }));

  test("creation rejects empty selections, vanished skills and linked resources", async () => temp(async (root, config) => {
    expect(() => parsePluginCreateRequest({ name: "Empty", skills: [], connectors: [] })).toThrow("Choose at least one");
    expect(() => parsePluginCreateRequest({ name: "Duplicate", skills: ["same", "same"], connectors: [] })).toThrow("only once");
    await expect(planPluginCreation(config, root, { name: "Missing", skills: ["../outside"], connectors: [] })).rejects.toMatchObject({ code: "plugin_item_missing" });
    await expect(planPluginCreation(config, root, { name: "Missing", skills: [], connectors: ["constructor"] })).rejects.toMatchObject({ code: "plugin_item_missing" });
    await writeFixture(globalSkillsDir(), { "linked/SKILL.md": "---\nname: linked\ndescription: Linked resources\n---\nRead." });
    await writeFile(join(root, "outside.txt"), "private");
    await symlink(join(root, "outside.txt"), join(globalSkillsDir(), "linked", "outside.txt"));
    await expect(planPluginCreation(config, root, { name: "Unsafe", skills: ["linked"], connectors: [] })).rejects.toMatchObject({ code: "invalid_plugin_import" });
    expect((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins).toEqual({});
  }));
  test("routine connector setup and automatic naming do not become compatibility notes", async () => {
    const files = {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "setup", onboardingSkill: "help", mcpServers: {
        github: { url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" }, oauth: { clientId: "client" }, cwd: "${WORKDIR}", userConfig: { token: {} }, transport: "http", timeout: 60 },
        local: { command: "node", env: { SETTING: "${SETTING:-default}" } },
      } }),
      "skills/one/SKILL.md": "---\nname: duplicate\ndescription: First\n---\nFirst.",
      "skills/two/SKILL.md": "---\nname: duplicate\ndescription: Second\n---\nSecond.",
    };
    const [plan] = await resolvePluginImports(request(files), "/project");
    expect(plan!.preview.warnings).toEqual([]);
    expect(new Set(plan!.preview.components.filter(item => item.type === "skill").map(item => item.installedName)).size).toBe(2);
    const mcp = JSON.stringify(plan!.resolved.memberships.find(item => item.configObject?.objectType === "mcp"));
    expect(mcp).toContain("https://${HOST}/mcp");
    expect(mcp).toContain('"enabled":false');
    expect(mcp).toContain("${GITHUB_TOKEN}");
    expect(mcp).toContain('"SETTING":"default"');
  });

  test("compatibility notes explain actual omitted behavior and model changes instead of generic review instructions", async () => {
    const files = {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "limitations", hooks: {}, mcpServers: {
        helper: { url: "https://helper.example/mcp", headersHelper: "script.js" },
        customAuth: { url: "https://auth.example/mcp", extensions: { "com.openai": { auth: { type: "oauth", authorizationUrl: "https://auth.example/login" } } } },
      } }),
      "agents/examiner.md": '---\nname: examiner\ndescription: Examine\nmodel: sonnet\nallowed-tools: [Search]\ncontext: fork\n---\nRun !`external-command` with ${CLAUDE_SESSION_ID}.',
    };
    const [plan] = await resolvePluginImports(request(files), "/project");
    const notes = plan!.preview.warnings.join("\n");
    expect(notes).toContain("runtime substitutions and dynamic commands will not run");
    expect(notes).toContain('source model "sonnet" will not be selected automatically');
    expect(plan!.preview.requirements).toEqual(expect.arrayContaining([expect.objectContaining({ code: "execution_semantics", required: true, status: "blocked" })]));
    expect(plan!.preview.connectors).toEqual(expect.arrayContaining([expect.objectContaining({ name: "helper", status: "blocked", code: "credential_helper" }), expect.objectContaining({ name: "customAuth", status: "blocked", code: "oauth_override" })]));
    expect(plan!.preview.components.some(component => component.type === "mcp")).toBe(false);
    expect(plan!.preview.requirements?.some(item => item.code === "unsupported_hooks")).toBe(true);
    expect(notes).not.toMatch(/review .*settings|configure .*before connecting|metadata is preserved/);
  });

  test("a source-only package clearly says that no usable components will be installed", async () => {
    const [plan] = await resolvePluginImports(request({ ".claude-plugin/plugin.json": JSON.stringify({ name: "unsupported", mcpServers: "server.mcpb" }), "server.mcpb": "source bundle" }), "/project");
    expect(plan!.preview.components).toEqual([]);
    expect(plan!.preview.warnings).toEqual([
      "Connector bundle server.mcpb: its connectors will not be installed. This bundle format is not supported.",
      "This package has no supported skills, agents, commands or connectors to import.",
    ]);
  });

  test("discovery, preview and installed packages retain display metadata separately from identity", async () => temp(async (root, config) => {
    const source = join(root, ".agents/plugins/clerk");
    const files = { ".codex-plugin/plugin.json": JSON.stringify({ name: "app-internal", interface: { displayName: "Clerk", shortDescription: "Authentication tools" } }), "skills/search/SKILL.md": skill };
    await writeFixture(source, files);
    const candidate = (await discoverPluginImports("chatgpt", root)).find(item => item.path === source);
    expect(candidate?.displayName).toBe("Clerk");
    expect(candidate?.description).toBe("Authentication tools");
    const [plan] = await resolvePluginImports({ source: { provider: "chatgpt", path: source }, scope: "global" }, root);
    expect(plan!.preview.name).toBe("app-internal");
    expect(plan!.preview.displayName).toBe("Clerk");
    expect(plan!.preview.id).toMatch(/^import:chatgpt:app-internal:[a-f0-9]{16}:global$/);
    await installPluginImport(config, "test", root, plan!, true);
    const installed = (await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[plan!.preview.id];
    expect(installed?.name).toBe("app-internal");
    expect(installed?.displayName).toBe("Clerk");
  }));
  test("reads wrapped Claude ZIPs, supplemental skills, agents, commands and MCP precedence", async () => {
    const [plan] = await resolvePluginImports(request(), "/project");
    expect(plan!.preview.root).toBe("export/patent");
    expect(plan!.preview.components.map(c => c.type).sort()).toEqual(["agent", "command", "mcp", "mcp", "mcp", "skill", "skill"]);
    expect(plan!.preview.fileCount).toBe(Object.keys(fixtures).length);
    const mcp = plan!.resolved.memberships.find(m => m.configObject?.objectType === "mcp")?.configObject?.latestVersion?.normalizedPayloadJson;
    expect(JSON.stringify(mcp)).toContain("override.example");
    expect(JSON.stringify(mcp)).not.toContain("default.example");
    expect(plan!.preview.requirements?.some(item => item.code === "unsupported_hooks")).toBe(true);
    expect(plan!.preview.warnings.join(" ")).not.toContain("configure its environment");
    expect(plan!.resourceFiles.some(file => file.path.endsWith("assets/icon.png") && file.bytes[1] === 255)).toBe(true);
    const content = plan!.resolved.memberships.find(m => m.configObject?.objectType === "command")?.configObject?.latestVersion?.rawSourceText;
    expect(content).not.toContain("patent:search");
    expect(content).toContain(plan!.preview.components.find(c => c.type === "agent")!.installedName);
  });
  test("imports Codex legacy nested skills plus inline connectors and source assets", async () => {
    const files = { ".codex-plugin/plugin.json": JSON.stringify({ name: "legal-tools", skills: "./nested/skills", mcpServers: "./.mcp.json", apps: "./.app.json" }), "nested/skills/claim/SKILL.md": skill, ".mcp.json": '{"mcpServers":{"search":{"url":"https://search.example/mcp"}}}', ".app.json": '{"apps":{"app":"plugin_asdk_app_1"}}', "scripts/shared.py": "shared" };
    const [plan] = await resolvePluginImports({ source: { provider: "chatgpt", zipBase64: archive(files) }, scope: "project" }, "/project");
    expect(plan!.preview.format).toBe("codex");
    expect(plan!.resolved.plugin.sourceKind).toBe("plugin");
    expect(plan!.preview.components.map(c => c.type)).toEqual(["skill", "mcp"]);
    expect(plan!.preview.requirements).toContainEqual(expect.objectContaining({ kind: "app", required: true, status: "blocked" }));
    expect(plan!.resourceFiles.some(f => f.path.endsWith("scripts/shared.py"))).toBe(true);
  });
  test("portable metadata stays canonical and inline OpenAI extension replaces legacy overlay", async () => {
    const files = {
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "canonical", version: "2",
        extensions: { "com.openai": { apps: "./.app.json", mcpServers: {
          public: { url: "https://public.example/mcp", extensions: { "com.openai": { auth: { type: "none" } } } },
          private: { url: "https://private.example/mcp", extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "provided", clientId: "client" } } } } },
        } } },
      }),
      ".app.json": '{"apps":{}}', ".codex-plugin/plugin.json": '{"name":"legacy","version":"1","mcpServers":"./missing.json"}', "skills/search/SKILL.md": skill,
    };
    const [plan] = await resolvePluginImports({ source: { provider: "chatgpt", zipBase64: archive(files) }, scope: "project" }, "/project");
    expect(plan!.preview.name).toBe("canonical"); expect(plan!.preview.version).toBe("2"); expect(plan!.preview.format).toBe("portable");
    expect(JSON.stringify(plan!.resolved)).toContain('"oauth":false'); expect(JSON.stringify(plan!.resolved)).toContain('"clientId":"client"');
  });
  test("supports manifest-free skill collections and inline command definitions", async () => {
    const [collection] = await resolvePluginImports(request({ "one/SKILL.md": skill, "two/SKILL.md": skill.replace("name: search", "name: second") }), "/project");
    expect(collection!.preview.components).toHaveLength(2);
    expect(collection!.resolved.plugin.sourceKind).toBe("skill");
    const [bundle] = await resolvePluginImports(request({ "SKILL.md": skill, ".mcp.json": '{"mcpServers":{"search":{"url":"https://example.invalid/mcp"}}}' }), "/project");
    expect(bundle!.preview.components).toHaveLength(2);
    expect(bundle!.preview.root).toBe("export/patent");
    expect(bundle!.resolved.plugin.sourceKind).toBe("plugin");
    const [inline] = await resolvePluginImports(request({ ".claude-plugin/plugin.json": '{"name":"inline","commands":{"about":{"content":"Explain the plugin.","description":"About"}}}' }), "/project");
    expect(inline!.preview.components).toHaveLength(1); expect(JSON.stringify(inline!.resolved)).toContain("Explain the plugin.");
  });
  test("installs full folder with executable and binary assets, preserved metadata and complete uninstall", async () => temp(async (root, config) => {
    const source = join(root, "source"); await writeFixture(source, fixtures);
    const req: PluginImportRequest = { source: { provider: "claude", path: source }, scope: "project" };
    const [plan] = await resolvePluginImports(req, root);
    const installed = await installPluginImport(config, "test", root, plan!, false);
    const ns = pluginNamespace("patent", plan!.preview.id);
    expect(await readFile(join(root, ".opencode/imported-plugins", ns, "assets/icon.png"))).toEqual(Buffer.from(fixtures["assets/icon.png"]));
    expect((await stat(join(root, ".opencode/imported-plugins", ns, "bin/tool"))).mode & 0o111).toBe(0o111);
    const skillPath = installed.files.find(f => f.objectType === "skill")!.path;
    expect(await readFile(join(root, skillPath), "utf8")).toContain("jurisdiction: EU");
    expect(await readFile(join(root, dirname(skillPath), "references/guide.md"), "utf8")).toBe("Reference data");
    expect((await readInstalledCloudPlugins(config, "test")).plugins[plan!.preview.id]).toBeDefined();
    await removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: plan!.preview.id });
    await expect(stat(join(root, ".opencode/imported-plugins", ns))).rejects.toThrow();
    await expect(stat(join(root, skillPath))).rejects.toThrow();
    expect(Object.keys((await readRuntimeOpencodeConfig(config, "test")).mcp ?? {})).toHaveLength(0);
  }));
  test("global imports are visible in other project engines and can be removed there", async () => temp(async (root, config) => {
    const [plan] = await resolvePluginImports({ ...request(), scope: "global" }, root);
    const installed = await installPluginImport(config, "test", root, plan!, true);
    expect(installed.scope).toBe("global");
    expect(Object.keys(await runtimeMcpMapForWorkspace(config, "another-project"))).toHaveLength(3);
    const ns = pluginNamespace("patent", plan!.preview.id);
    const path = join(root, "global/opencode/skills", ns, plan!.preview.components.find(c => c.type === "skill")!.installedName, "SKILL.md");
    expect(await readFile(path, "utf8")).toContain("Patent search");
    await removeCloudPlugin({ serverConfig: config, workspaceId: "another-project", workspaceRoot: root, pluginId: plan!.preview.id });
    expect(Object.keys((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins)).toHaveLength(0);
    await expect(stat(path)).rejects.toThrow();
  }));
  test("package removal retains independent connectors and a same-named connection in another scope", async () => temp(async (root, config) => {
    const [plan] = await resolvePluginImports(request(), root);
    await installPluginImport(config, "test", root, plan!, false);
    const [ownedName] = Object.keys((await readRuntimeOpencodeConfig(config, "test")).mcp ?? {});
    if (!ownedName) throw new Error("Missing imported connector fixture");
    const independent = { type: "remote", url: "https://independent.example/mcp", headers: { Authorization: "synthetic-private-value" } };
    await writeRuntimeOpencodeConfig(config, "test", current => ({ ...current, mcp: { ...current.mcp, independent } }));
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, current => ({ ...current, mcp: { ...current.mcp, [ownedName]: independent } }));
    await removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: plan!.preview.id, scope: "workspace" });
    expect((await readRuntimeOpencodeConfig(config, "test")).mcp).toEqual({ independent });
    expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp).toEqual({ [ownedName]: independent });
  }));
  test("preserves exact MCP arguments, empty environment values and headers", async () => temp(async (root, config) => {
    const files = { ".claude-plugin/plugin.json": '{"name":"arguments"}', ".mcp.json": JSON.stringify({ mcpServers: { local: { command: "node", args: ["script.js", "", "  a b  "], env: { EMPTY: "", PADDED: "  value  " } }, remote: { url: "https://example.com/mcp", headers: { "X-Value": "  value  " } } } }), "script.js": "console.log('test')" };
    const [plan] = await resolvePluginImports(request(files), root);
    await installPluginImport(config, "test", root, plan!, false);
    const values = Object.values((await readRuntimeOpencodeConfig(config, "test")).mcp ?? {});
    const local = values.find(value => value.type === "local");
    expect(local?.command).toEqual(["node", expect.stringContaining("script.js"), "", "  a b  "]);
    expect(local?.environment).toMatchObject({ EMPTY: "", PADDED: "  value  " });
    expect(values.find(value => value.type === "remote")?.headers).toEqual({ "X-Value": "  value  " });
  }));
  test("the same package in global and project scopes keeps independent components and connectors", async () => temp(async (root, config) => {
    const [projectPlan] = await resolvePluginImports(request(), root);
    const [globalPlan] = await resolvePluginImports({ ...request(), scope: "global" }, root);
    await installPluginImport(config, "test", root, projectPlan!, false);
    await installPluginImport(config, "test", root, globalPlan!, true);
    expect(projectPlan!.preview.id).not.toBe(globalPlan!.preview.id);
    expect(Object.keys(await runtimeMcpMapForWorkspace(config, "test"))).toHaveLength(6);
    await removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: projectPlan!.preview.id, scope: "workspace" });
    expect(Object.keys(await runtimeMcpMapForWorkspace(config, "test"))).toHaveLength(3);
    expect((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[globalPlan!.preview.id]).toBeDefined();
    await expect(removeCloudPlugin({ serverConfig: config, workspaceId: "test", workspaceRoot: root, pluginId: globalPlan!.preview.id, scope: "workspace" })).rejects.toThrow();
    expect(Object.keys(await runtimeMcpMapForWorkspace(config, "test"))).toHaveLength(3);
  }));
  test("updates prune removed skills, connectors and old resources", async () => temp(async (root, config) => {
    const [original] = await resolvePluginImports(request(), root); await installPluginImport(config, "test", root, original!, false);
    const ns = pluginNamespace("patent", original!.preview.id);
    const files = { ".claude-plugin/plugin.json": '{"name":"patent"}', "skills/new/SKILL.md": skill.replace("name: search", "name: new") };
    const [replacement] = await resolvePluginImports(request(files), root); await installPluginImport(config, "test", root, replacement!, false);
    await expect(stat(join(root, ".opencode/imported-plugins", ns, "server.js"))).rejects.toThrow();
    await expect(stat(join(root, ".opencode/skills", ns, original!.preview.components.find(c => c.type === "skill")!.installedName))).rejects.toThrow();
    expect(Object.keys((await readRuntimeOpencodeConfig(config, "test")).mcp ?? {})).toHaveLength(0);
  }));
  test("a failed connector install restores the previous files and config", async () => temp(async (root, config) => {
    const [original] = await resolvePluginImports(request(), root); await installPluginImport(config, "test", root, original!, false);
    const before = await readRuntimeOpencodeConfig(config, "test");
    const [broken] = await resolvePluginImports(request({ ".claude-plugin/plugin.json": '{"name":"patent"}', ".mcp.json": '{"mcpServers":{"bad":{"url":"https://valid.example/mcp"}}}', "skills/changed/SKILL.md": skill }), root);
    // Force a storage-time failure after planning; invalid source URLs are now
    // excluded before installation rather than discovered during a write.
    const version = broken!.resolved.memberships.find(item => item.configObject?.objectType === "mcp")?.configObject?.latestVersion;
    if (!version) throw new Error("Missing connector fixture");
    version.normalizedPayloadJson = { mcpServers: { bad: { url: "file:///invalid" } } };
    await expect(installPluginImport(config, "test", root, broken!, false)).rejects.toThrow();
    const ns = pluginNamespace("patent", original!.preview.id);
    expect(await readFile(join(root, ".opencode/imported-plugins", ns, "server.js"), "utf8")).toBe("console.log('server')");
    expect((await readRuntimeOpencodeConfig(config, "test")).mcp).toEqual(before.mcp);
    expect((await readInstalledCloudPlugins(config, "test")).plugins[original!.preview.id]!.files.map(f => f.path)).toContain(original!.resourceFiles[0]!.path.split("/").slice(0, 3).join("/"));
  }));
  test("rejects source/destination links, traversal, duplicate/case paths and oversized archives", async () => temp(async (root, config) => {
    const source = join(root, "source"); await writeFixture(source, { "SKILL.md": skill }); await symlink(join(source, "SKILL.md"), join(source, "linked.md"));
    await expect(resolvePluginImports({ source: { provider: "claude", path: source }, scope: "project" }, root)).rejects.toThrow("link");
    await expect(resolvePluginImports(request({ "../escape/SKILL.md": skill }), root)).rejects.toThrow("Unsafe");
    await expect(resolvePluginImports(request({ "SKILL.md": skill, "skill.md": "collision" }), root)).rejects.toThrow("Duplicate");
    await expect(resolvePluginImports(request({ "SKILL.md": skill, "huge.bin": new Uint8Array(65 * 1024 * 1024) }), root)).rejects.toThrow("64 MB");
    const [plan] = await resolvePluginImports(request(), root); const ns = pluginNamespace("patent", plan!.preview.id);
    await mkdir(join(root, ".opencode/imported-plugins"), { recursive: true }); await symlink(source, join(root, ".opencode/imported-plugins", ns));
    await expect(installPluginImport(config, "test", root, plan!, false)).rejects.toThrow("linked");
    expect(Object.keys((await readInstalledCloudPlugins(config, "test")).plugins)).toHaveLength(0);
  }));
  test("folder changes invalidate the preview digest and discovery finds installed cache roots", async () => temp(async root => {
    const source = join(root, "claude/plugins/cache/patent/1.0"); await writeFixture(source, fixtures);
    const discovered = await discoverPluginImports("claude", root); expect(discovered.some(c => c.path === source)).toBe(true);
    const req: PluginImportRequest = { source: { provider: "claude", path: source }, scope: "project" };
    const [before] = await resolvePluginImports(req, root); await writeFile(join(source, "README.md"), "Changed");
    const [after] = await resolvePluginImports(req, root); expect(after!.preview.digest).not.toBe(before!.preview.digest);
  }));
  test("desktop discovery reads the real user home when the runtime home is isolated", async () => temp(async root => {
    const keys = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "LEGALWORK_PLUGIN_DISCOVERY_HOME"];
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    const home = join(root, "real-home");
    const codex = join(home, ".codex/plugins/cache/vendor/patent/1.0");
    const claude = join(home, ".claude/plugins/cache/vendor/patent/1.0");
    const personalSkill = join(home, ".agents/skills/search");
    try {
      process.env.HOME = join(root, "isolated-home");
      process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME = home;
      delete process.env.CODEX_HOME;
      delete process.env.CLAUDE_CONFIG_DIR;
      await writeFixture(codex, { ".codex-plugin/plugin.json": '{"name":"codex-patent"}', "skills/search/SKILL.md": skill });
      await writeFixture(claude, fixtures);
      await writeFixture(personalSkill, { "SKILL.md": skill });
      expect((await discoverPluginImports("chatgpt", root)).map(item => item.path).sort()).toEqual([codex, personalSkill].sort());
      const claudeItems = await discoverPluginImports("claude", root);
      expect(claudeItems.filter(item => item.kind === "plugin").map(item => item.path)).toEqual([claude]);
      expect(claudeItems.filter(item => item.kind === "connector").map(item => item.name).sort()).toEqual(["local", "remote", "second"]);
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }));
  test("recognizes portable manifests and retains explicit provider-only validation", async () => {
    const [plan] = await resolvePluginImports({ source: { provider: "chatgpt", zipBase64: archive({ "plugin.json": '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"plain"}', "skills/search/SKILL.md": skill, "mcp.json": '{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"remote":{"type":"streamable-http","url":"https://example.com/mcp"}}}' }) }, scope: "project" }, "/project");
    expect(plan!.preview.components).toHaveLength(2);
    await expect(resolvePluginImports({ ...request(), source: { provider: "chatgpt", zipBase64: archive(fixtures) }, detectFormat: false }, "/project")).rejects.toThrow("matching import button");
  });
  test("validates mutually exclusive import source fields", () => {
    expect(() => parsePluginImportRequest({ source: { provider: "claude", path: "/tmp", zipBase64: "UEs=" }, scope: "project" })).toThrow();
    expect(() => parsePluginImportRequest({ source: { provider: "other", path: "/tmp" }, scope: "project" })).toThrow();
  });
});


test("plugin document API reads only registered instructions and protects global and linked files", async () => temp(async (root, config) => {
  const [plan] = await resolvePluginImports({ ...request(), scope: "global" }, root);
  await installPluginImport(config, "test", root, plan!, true);
  const server = await startServer(config);
  const base = `http://127.0.0.1:${server.port}/workspace/test/cloud-plugins/${encodeURIComponent(plan!.preview.id)}/file`;
  const headers = { Authorization: "Bearer test" };
  const owner = { ...headers, "X-LegalWork-Host-Token": "host" };
  const command = plan!.resolved.memberships.find(item => item.configObject?.objectType === "command")!.configObject!;
  const path = command.currentRelativePath!;
  try {
    expect((await fetch(`${base}?path=${encodeURIComponent(path)}`, { headers })).status).toBe(401);
    const allowed = await fetch(`${base}?path=${encodeURIComponent(path)}`, { headers: owner });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("Start workflow");
    const outside = await fetch(`${base}?path=${encodeURIComponent("../private.md")}`, { headers: owner });
    expect(outside.status).toBe(404);
    const bundle = plan!.resourceFiles[0]!.path;
    expect((await fetch(`${base}?path=${encodeURIComponent(bundle)}`, { headers: owner })).status).toBe(404);
    config.readOnly = true;
    expect((await fetch(`${base}?path=${encodeURIComponent(path)}`, { headers: owner })).status).toBe(200);
    const installedPath = resolveWorkspaceInstallPath(root, path, true);
    await rm(installedPath);
    await writeFile(join(root, "private.md"), "outside-secret");
    await symlink(join(root, "private.md"), installedPath);
    const linked = await fetch(`${base}?path=${encodeURIComponent(path)}`, { headers: owner });
    expect(linked.status).not.toBe(200);
    expect(await linked.text()).not.toContain("outside-secret");
  } finally { await server.stop(); }
}));

test("creation API requires the owner, rejects duplicate names and makes the bundle visible across projects", async () => temp(async (root, config) => {
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  config.workspaces[0]!.baseUrl = `http://127.0.0.1:${engine.port}`;
  config.workspaces.push({ ...config.workspaces[0]!, id: "second", name: "Second" });
  await writeFixture(globalSkillsDir(), { "review/SKILL.md": "---\nname: review\ndescription: Review claims\n---\nReview." });
  const server = await startServer(config);
  const base = `http://127.0.0.1:${server.port}/workspace/test`;
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  const owner = { ...headers, "X-LegalWork-Host-Token": "host" };
  const payload = { name: "Claims toolkit", skills: ["review"], connectors: [] };
  try {
    expect((await fetch(`${base}/workflow-plugins/options`, { headers })).status).toBe(401);
    expect((await fetch(`${base}/workflow-plugins/options`, { headers: owner })).status).toBe(200);
    const create = (body: import("@legalwork/types/plugin-import").PluginCreateRequest, auth: Record<string, string> = owner) => fetch(`${base}/workflow-plugins`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect((await create(payload, headers)).status).toBe(401);
    const simultaneous = await Promise.all([create(payload), create({ ...payload, name: "Claims Toolkit" })]);
    expect(simultaneous.map(response => response.status).sort()).toEqual([200, 409]);
    const installed = (await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[createdPluginId(payload.name)]!;
    const listing = await fetch(`http://127.0.0.1:${server.port}/workspace/second/cloud-plugins`, { headers });
    expect(await listing.text()).toContain(installed.pluginId);
    const custom = { name: "New MCP", skills: [], connectors: [], newConnector: { type: "remote", url: "https://example.invalid/mcp", oauth: false } } satisfies import("@legalwork/types/plugin-import").PluginCreateRequest;
    expect((await create(custom, headers)).status).toBe(401);
    expect((await create(custom)).status).toBe(200);
    expect((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[createdPluginId(custom.name)]?.files.some(file => file.objectType === "mcp")).toBe(true);
    config.readOnly = true;
    expect((await create({ ...payload, name: "Read only" })).status).toBe(403);
    expect((await readInstalledCloudPlugins(config, GLOBAL_MCP_ID)).plugins[createdPluginId("Read only")]).toBeUndefined();
  } finally { await server.stop(); engine.stop(true); }
}));

test("import API previews, enforces ownership, rejects stale sources and manages global packages across projects", async () => temp(async (root, config) => {
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  config.workspaces[0]!.baseUrl = `http://127.0.0.1:${engine.port}`;
  config.workspaces.push({ ...config.workspaces[0]!, id: "second", name: "Second" });
  const server = await startServer(config);
  const source = join(root, "source"); await writeFixture(source, { ".codex-plugin/plugin.json": '{"name":"api-plugin"}', "skills/one/SKILL.md": skill, "assets/data.bin": new Uint8Array([3, 2, 1]) });
  const base = `http://127.0.0.1:${server.port}/workspace/test`;
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  const ownerHeaders = { ...headers, "X-LegalWork-Host-Token": "host" };
  const payload = { source: { provider: "chatgpt", path: source }, scope: "global" };
  try {
    const denied = await fetch(`${base}/plugin-imports/preview`, { method: "POST", headers, body: JSON.stringify(payload) });
    expect(denied.status).toBe(401);
    const preview = await fetch(`${base}/plugin-imports/preview`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(payload) });
    expect(preview.status).toBe(200);
    const result = await preview.json();
    const reviewed = result.items[0];
    const noReview = await fetch(`${base}/plugin-imports/install`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(payload) });
    expect(noReview.status).toBe(409);
    await writeFile(join(source, "assets/data.bin"), new Uint8Array([4, 5]));
    const stale = await fetch(`${base}/plugin-imports/install`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ...payload, root: reviewed.root, digest: reviewed.digest }) });
    expect(stale.status).toBe(409);
    const fresh = await (await fetch(`${base}/plugin-imports/preview`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(payload) })).json();
    const imported = await fetch(`${base}/plugin-imports/install`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ ...payload, root: fresh.items[0].root, digest: fresh.items[0].digest, validationId: fresh.items[0].validationId, acknowledgePartial: true }) });
    expect(imported.status).toBe(200);
    const installed = await imported.json();
    expect(installed.item.scope).toBe("global");
    const skills = await (await fetch(`${base}/skills?includeGlobal=true`, { headers })).json();
    expect(skills.items.some((item: { name: string }) => item.name === fresh.items[0].components[0].installedName)).toBe(true);
    const otherBase = `http://127.0.0.1:${server.port}/workspace/second`;
    const listing = await (await fetch(`${otherBase}/cloud-plugins`, { headers })).json();
    expect(listing.plugins[installed.item.pluginId].scope).toBe("global");
    const removal = `${otherBase}/cloud-plugins/${encodeURIComponent(installed.item.pluginId)}`;
    expect((await fetch(removal, { method: "DELETE", headers })).status).toBe(401);
    expect((await fetch(removal, { method: "DELETE", headers: ownerHeaders })).status).toBe(200);
    const zippedPayload = { source: { provider: "claude", zipBase64: archive({ "SKILL.md": skill }) }, scope: "project" };
    const projectPreview = await fetch(`${base}/plugin-imports/preview`, { method: "POST", headers, body: JSON.stringify(zippedPayload) });
    expect(projectPreview.status).toBe(200);
    const project = await projectPreview.json();
    expect((await fetch(`${base}/plugin-imports/install`, { method: "POST", headers, body: JSON.stringify({ ...zippedPayload, root: project.items[0].root, digest: project.items[0].digest, validationId: project.items[0].validationId }) })).status).toBe(200);
  } finally { await server.stop(); engine.stop(true); }
}), 30000);


test("new connector-only plugins persist URL authentication without requiring a skill", async () => temp(async (root, config) => {
  for (const [name, oauth, headers] of [
    ["OAuth plugin", { clientId: "client", clientSecret: "synthetic-secret" }, {}],
    ["Key plugin", false, { Authorization: "Bearer synthetic-key", "X-Tenant": "example" }],
  ] satisfies Array<[string, false | { clientId: string; clientSecret: string }, Record<string, string>]>) {
    const plan = await planPluginCreation(config, root, parsePluginCreateRequest({ name, skills: [], connectors: [], newConnector: { type: "remote", url: "https://example.invalid/mcp", oauth, headers } }));
    expect(plan.preview.components.map(item => item.type)).toEqual(["mcp"]);
    expect(JSON.stringify(plan.preview)).not.toContain("synthetic-secret");
    expect(JSON.stringify(plan.preview)).not.toContain("synthetic-key");
    await installPluginImport(config, "test", root, plan, true);
    const installed = plan.preview.components[0]!;
    expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.[installed.installedName]).toMatchObject({ type: "remote", url: "https://example.invalid/mcp", oauth, ...(Object.keys(headers).length ? { headers } : {}), enabled: true });
  }
}));

test("new local plugin retains exact arguments, credentials and optional skill copies", async () => temp(async (root, config) => {
  await writeFixture(globalSkillsDir(), { "review/SKILL.md": "---\nname: review\ndescription: Review\n---\nReview." });
  const connection = { type: "local", command: ["/path with spaces/server", "--name", "a b"], environment: { API_KEY: "synthetic-secret", EMPTY: "" } };
  const plan = await planPluginCreation(config, root, parsePluginCreateRequest({ name: "Local review", skills: ["review"], connectors: [], newConnector: connection }));
  expect(plan.preview.components.map(item => item.type).sort()).toEqual(["mcp", "skill"]);
  await installPluginImport(config, "test", root, plan, true);
  const connector = plan.preview.components.find(item => item.type === "mcp")!;
  expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.[connector.installedName]).toMatchObject({ ...connection, enabled: true });
}));

test("new MCP definitions reject invalid transport, credentials in URLs and malformed commands", () => {
  for (const newConnector of [
    { type: "remote", url: "file:///private/file", oauth: false },
    { type: "remote", url: "https://user:password@example.com", oauth: false },
    { type: "remote", url: "https://example.com", oauth: false, headers: { Host: "elsewhere" } },
    { type: "remote", url: "https://example.com", oauth: false, headers: { "X-Key": "one\r\ntwo" } },
    { type: "local", command: [] },
    { type: "local", command: [" "] },
    { type: "local", command: ["node"], environment: { "BAD=KEY": "value" } },
  ]) expect(() => parsePluginCreateRequest({ name: "Invalid", skills: [], connectors: [], newConnector })).toThrow();
});
