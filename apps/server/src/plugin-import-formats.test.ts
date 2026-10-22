import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { strToU8, zipSync } from "fflate";
import { discoverPluginImports, parsePluginImportRequest, resolvePluginImports } from "./plugin-imports.js";
import { localMarketplaceEntries } from "./plugin-import-marketplaces.js";
import type { PluginImportRequest } from "@legalwork/types/plugin-import";

const skill = "---\nname: review\ndescription: Review a document\n---\nRead the document and explain the findings.";
const files = { ".codex-plugin/plugin.json": '{"name":"review-kit","skills":"./skills/","apps":"./.app.json"}', "skills/review/SKILL.md": skill };
function archive(contents: Record<string, string>, extra: Partial<PluginImportRequest> = {}): PluginImportRequest {
  return { source: { provider: "claude", zipBase64: Buffer.from(zipSync(Object.fromEntries(Object.entries(contents).map(([path, text]) => [path, strToU8(text)])))).toString("base64") }, scope: "global", ...extra };
}

test("optional ChatGPT app scaffolds do not block otherwise portable instructions", async () => {
  for (const config of ["{}", '{"apps":{}}', '{"apps":null}', '{"apps":[]}', '{"metadata":{"generated":true}}']) {
    const [plan] = await resolvePluginImports(archive({ ...files, ".app.json": config }), "/project");
    expect(plan?.preview.format).toBe("codex");
    expect(plan?.preview.readiness).toBe("ready");
    expect(plan?.preview.requirements).toEqual([]);
    expect(plan?.preview.components.map(component => component.name)).toEqual(["review"]);
  }
});

test("nonempty or unreadable app declarations produce an actionable blocked review", async () => {
  for (const config of ['{"apps":{"drive":{"id":"plugin_asdk_app_drive"}}}', '{"apps":[{"id":"drive"}]}', '{"apps":false}', "not json", "[]"]) {
    const [plan] = await resolvePluginImports(archive({ ...files, ".app.json": config }), "/project");
    expect(plan?.preview.readiness).toBe("unsupported");
    expect(plan?.preview.components).toHaveLength(1);
    expect(plan?.preview.requirements).toEqual([expect.objectContaining({ kind: "app", required: true, status: "blocked" })]);
    expect(plan?.preview.requirements?.[0]?.message).not.toContain("Invalid app connection declarations");
  }
});

test("an explicit ChatGPT app file replaces the default file", async () => {
  const [plan] = await resolvePluginImports(archive({ ...files, ".codex-plugin/plugin.json": '{"name":"review-kit","apps":"./config/apps.json"}', "config/apps.json": "{}", ".app.json": '{"apps":{"stale":{"id":"app_stale"}}}' }), "/project");
  expect(plan?.preview.readiness).toBe("ready");
});

test("OpenAI's portable auth profile reaches compatibility checks instead of a generic schema error", async () => {
  const [plan] = await resolvePluginImports(archive({
    "plugin.json": '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"auth-profile"}',
    "mcp.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {
      public: { type: "streamable-http", url: "https://public.example/mcp", extensions: { "com.openai": { auth: { type: "none" } } } },
      key: { type: "streamable-http", url: "https://key.example/mcp", extensions: { "com.openai": { auth: { type: "api_key", headerScheme: "custom_header", headerName: "X-Api-Key" } } } },
      restricted: { type: "streamable-http", url: "https://restricted.example/mcp", extensions: { "com.openai": { auth: { type: "oauth", defaultScopes: [] } } } },
      custom: { type: "streamable-http", url: "https://custom.example/mcp", extensions: { "com.openai": { auth: { type: "oauth", tokenUrl: "https://custom.example/token" } } } },
      invalidHeader: { type: "streamable-http", url: "https://key.example/mcp", extensions: { "com.openai": { auth: { type: "api_key", headerScheme: "bearer", headerName: "X-Api-Key" } } } },
    } }),
  }), "/project");
  expect(plan?.preview.components.map(component => component.name)).toEqual(["public", "key"]);
  expect(plan?.preview.connectors).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "key", status: "setup", code: "api_key", inputs: ["API_KEY"] }),
    expect.objectContaining({ name: "restricted", status: "blocked", code: "pinned_scopes" }),
    expect.objectContaining({ name: "custom", status: "blocked", code: "oauth_override" }),
    expect.objectContaining({ name: "invalidHeader", status: "blocked", code: "credential_header" }),
  ]));
  expect(plan?.preview.connectors?.some(check => check.code === "portable_entry")).toBe(false);
});

test("Workflows detects both plugin hosts and keeps bundles intact; plain skills become workflows", async () => {
  for (const manifest of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const [plan] = await resolvePluginImports(archive({ [manifest]: '{"name":"review-kit"}', "skills/review/SKILL.md": skill, ".mcp.json": '{"mcpServers":{"docs":{"url":"https://docs.example/mcp"}}}' }, { asWorkflow: true, workflowSkillsOnly: true }), "/project");
    expect(plan?.resolved.plugin.sourceKind).toBe("plugin");
    expect(plan?.preview.components.map(component => component.type)).toEqual(["skill", "mcp"]);
    expect(plan?.preview.components[0]?.installedName).not.toStartWith("workflow-");
    expect(plan?.preview.provenance?.asWorkflow).toBeUndefined();
  }
  const [plain] = await resolvePluginImports(archive({ "SKILL.md": skill }, { asWorkflow: true }), "/project");
  expect(plain?.preview.components[0]?.installedName).toStartWith("workflow-assistant-");
  expect(plain?.preview.provenance?.asWorkflow).toBe(true);
  // Existing saved provenance uses asWorkflow without the new chooser mode.
  // Updating it must retain the original component names and package identity.
  const legacy = archive({ ".codex-plugin/plugin.json": '{"name":"review-kit"}', "skills/review/SKILL.md": skill }, { asWorkflow: true });
  const [original] = await resolvePluginImports(legacy, "/project");
  const [updated] = await resolvePluginImports(archive({ ".codex-plugin/plugin.json": '{"name":"review-kit"}', "skills/review/SKILL.md": `${skill}\nCheck the revised document.` }, { asWorkflow: original?.preview.provenance?.asWorkflow }), "/project");
  expect(updated?.preview.components[0]?.installedName).toStartWith("workflow-assistant-");
  expect(updated?.preview.id).toBe(original?.preview.id);
  expect(updated?.preview.digest).not.toBe(original?.preview.digest);
  expect(updated?.preview.provenance?.asWorkflow).toBe(true);
});

test("OpenAI marketplace path forms keep manifest-free bundles separate", async () => {
  const catalog = { name: "local-review", plugins: [
    { name: "first", source: "./plugins/first", skills: "./instructions/", interface: { displayName: "First Review" } },
    { name: "second", source: { source: "local", path: "./plugins/second" }, mcpServers: { docs: { url: "https://docs.example/mcp" } } },
  ] };
  const plans = await resolvePluginImports(archive({ "export/.agents/plugins/marketplace.json": JSON.stringify(catalog), "export/plugins/first/instructions/review/SKILL.md": skill, "export/plugins/second/README.md": "Docs connector", "export/unlisted/SKILL.md": skill }), "/project");
  expect(plans.map(plan => plan.preview.name)).toEqual(["first", "second"]);
  expect(plans[0]?.preview.displayName).toBe("First Review");
  expect(plans.map(plan => plan.preview.format)).toEqual(["codex", "codex"]);
  expect(plans.map(plan => plan.preview.components.map(component => component.type))).toEqual([["skill"], ["mcp"]]);
});

test("Claude marketplace metadata and supplemental commands survive review", async () => {
  const [plan] = await resolvePluginImports(archive({
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "team", plugins: [{ name: "review-kit", source: "./plugins/review", displayName: "Team Review", commands: { extra: { content: "Review the extra section." } } }] }),
    "plugins/review/.claude-plugin/plugin.json": '{"name":"review-kit","displayName":"Old Name","commands":"./commands/base.md"}',
    "plugins/review/commands/base.md": "Review the base section.",
  }), "/project");
  expect(plan?.preview.displayName).toBe("Team Review");
  expect(plan?.preview.components.map(component => component.name)).toEqual(["base", "extra"]);
});

test("marketplace templates inside a plugin remain supporting files", async () => {
  const plans = await resolvePluginImports(archive({ ...files, ".app.json": "{}", "templates/.agents/plugins/marketplace.json": '{"plugins":[{"name":"example","source":"./missing"}]}', "templates/example/.codex-plugin/plugin.json": '{"name":"example"}', "templates/example/skills/demo/SKILL.md": skill }), "/project");
  expect(plans).toHaveLength(1);
  const [plan] = plans;
  expect(plan?.preview.name).toBe("review-kit");
  expect(plan?.preview.readiness).toBe("ready");
  expect(plan?.resourceFiles.some(file => file.path.endsWith("templates/.agents/plugins/marketplace.json"))).toBe(true);
});

test("marketplace sources cannot escape the catalog or execute fetch commands", async () => {
  expect(localMarketplaceEntries({ metadata: { pluginRoot: "./plugins" }, plugins: [
    { source: "review" }, { source: "../outside" }, { source: "./../outside" }, { source: "/outside" }, { source: { source: "local", path: "./plugins/valid" } },
    { source: { source: "command", command: "touch /tmp/should-not-run" } },
  ] }).map(source => source.path)).toEqual(["plugins/review", "plugins/valid"]);
  await expect(resolvePluginImports(archive({ ".claude-plugin/marketplace.json": '{"plugins":[{"name":"remote","source":{"source":"npm","package":"example"}}]}' }), "/project")).rejects.toThrow("no local plugin folders");
});

test("marketplace links may stay inside the catalog but cannot escape its filesystem boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-marketplace-links-"));
  const catalogRoot = join(root, "catalog");
  const catalog = join(catalogRoot, ".agents/plugins/marketplace.json");
  const source = join(catalogRoot, "plugins/linked");
  try {
    for (const [path, text] of Object.entries({ [catalog]: '{"plugins":[{"name":"review-kit","source":"./plugins/linked"}]}', [join(catalogRoot, "plugins/inside/skills/review/SKILL.md")]: skill, [join(root, "outside/skills/review/SKILL.md")]: skill })) {
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
    }
    await symlink(join(catalogRoot, "plugins/inside"), source);
    const request = { source: { provider: "chatgpt", path: source, marketplace: catalog }, scope: "global" } satisfies PluginImportRequest;
    expect((await resolvePluginImports(request, root))[0]?.preview.name).toBe("review-kit");
    await rm(source); await symlink(join(root, "outside"), source);
    await expect(resolvePluginImports(request, root)).rejects.toThrow("outside its marketplace folder");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a discovered local marketplace candidate reviews only its plugin folder and retains metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "legalwork-marketplace-"));
  const previous = process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME;
  process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME = home;
  const source = join(home, "plugins/review");
  const marketplace = join(home, ".agents/plugins/marketplace.json");
  try {
    for (const [path, content] of Object.entries({ [marketplace]: JSON.stringify({ name: "local", plugins: [{ name: "review-kit", source: "./plugins/review", skills: "./instructions/", apps: "./config/apps.json", interface: { displayName: "Local Review" } }] }), [join(source, "instructions/review/SKILL.md")]: skill, [join(source, "config/apps.json")]: "{}" })) {
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
    }
    const candidate = (await discoverPluginImports("chatgpt", home)).find(item => item.name === "review-kit");
    expect(candidate).toMatchObject({ path: source, marketplace, displayName: "Local Review", kind: "plugin" });
    const request = parsePluginImportRequest({ source: { provider: "chatgpt", path: candidate?.path, marketplace: candidate?.marketplace }, scope: "global" });
    const [plan] = await resolvePluginImports(request, home);
    expect(plan?.preview.displayName).toBe("Local Review");
    expect(plan?.preview.readiness).toBe("ready");
    expect(plan?.preview.provenance?.marketplace).toBe(marketplace);
    expect(plan?.preview.fileCount).toBe(2);
    const digest = plan?.preview.digest;
    await writeFile(marketplace, JSON.stringify({ plugins: [{ name: "review-kit", source: "./plugins/review", skills: "./instructions/", dependencies: ["required-helper"] }] }));
    const [changed] = await resolvePluginImports(request, home);
    expect(changed?.preview.digest).not.toBe(digest);
    expect(changed?.preview.readiness).toBe("unsupported");
  } finally {
    if (previous === undefined) delete process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME; else process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
