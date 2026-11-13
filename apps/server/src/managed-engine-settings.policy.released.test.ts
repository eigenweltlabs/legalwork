import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { managedSettingsRpc } from "./managed-engine-settings.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("released native policy runs after managed additions and still denies them on refresh", async () => {
  if (!binary) throw new Error("An isolated engine binary is required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "managed-native-policy-")));
  const plugin = join(root, "plugin"), workspace = join(root, "workspace");
  for (const folder of [plugin, workspace, "home", "config", "data", "cache", "state"].map(folder => folder.startsWith(root) ? folder : join(root, folder))) await mkdir(folder, { recursive: true });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    const build = Bun.spawn([process.execPath, "build", resolve(import.meta.dir, "opencode-plugins/legalwork-managed-config.ts"), "--outfile", join(plugin, "index.mjs"), "--target", "node", "--format", "esm", "--external", "@opencode/plugin", "--external", "@opencode/plugin/*", "--external", "effect", "--external", "effect/*"], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    if (status !== 0) throw new Error(`${stdout}\n${stderr}`);
    const settingsPath = join(root, "settings.json");
    const skills = ["blocked", "allowed"].map(id => ({ id, name: id, path: join(workspace, id, "SKILL.md"), content: `Instructions for ${id}` }));
    const settings = { version: 2, sharedConfiguration: {}, workspaces: { fixture: { directory: workspace,
      configuration: {
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", models: { fixture: { limit: { context: 128000, output: 4096 } } } }, allowed: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:7/v1" }, models: { fixture: { limit: { context: 128000, output: 4096 } } } } },
        skills: skills.map(skill => join(workspace, skill.id)),
        mcp: { servers: { blocked: { type: "remote", url: "https://example.invalid/mcp", disabled: true } } },
      },
      providerActivation: {}, projectPermissionApprovals: [],
    } } };
    for (const skill of skills) {
      await mkdir(join(workspace, skill.id));
      await writeFile(skill.path, `---\nname: ${skill.name}\ndescription: Policy fixture\n---\n${skill.content}\n`);
    }
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    engine = await createManagedOpencodeServer({ bin: binary, cwd: workspace, timeoutMs: 30000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "data", "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...settings.workspaces.fixture.configuration, update: "disable", plugins: [{ package: plugin, options: { settingsPath } }], policies: [
        { action: "provider.use", resource: "fixture", effect: "deny" },
        { action: "integration.use", resource: "skill:blocked", effect: "deny" },
        { action: "integration.use", resource: "mcp:blocked", effect: "deny" },
      ] }),
    } });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const location = { directory: workspace };
    await client.location.get({ location });
    await client.model.list({ location });
    for (const refresh of [false, true]) {
      if (refresh) await client.rpc(managedSettingsRpc).refresh({}, { location });
      const [providers, models, skills, mcp, plugins] = await Promise.all([client.provider.list({ location }), client.model.list({ location }), client.skill.list({ location }), client.mcp.list({ location }), client.plugin.list({ location })]);
      expect(plugins.data.find(plugin => plugin.id === "legalwork.managed-config")?.state, JSON.stringify(plugins.data.filter(plugin => plugin.source.type !== "builtin"))).toMatchObject({ status: "active" });
      expect(providers.data.some(provider => provider.id === "fixture")).toBe(false);
      expect(models.data.some(model => model.providerID === "fixture")).toBe(false);
      expect(models.data.some(model => model.providerID === "allowed")).toBe(true);
      expect(skills.data.some(skill => skill.id === "blocked")).toBe(false);
      expect(skills.data.some(skill => skill.id === "allowed"), JSON.stringify(skills.data)).toBe(true);
      expect(mcp.data.some(server => server.name === "blocked")).toBe(false);
      expect(plugins.data.filter(plugin => plugin.state.status === "failed")).toEqual([]);
    }
    expect(await client.session.active()).toEqual({});
  } finally {
    await engine?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
