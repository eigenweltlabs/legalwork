import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { startServer } from "./server.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { ensureCoreOpencodeFiles } from "./workspace-init.js";
import { managedCoreLibraryRoot } from "./managed-core-library.js";
import { legalworkMandatoryRuntimeConfigContent, legalworkRuntimeConfigFilePath, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { closeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { CORE_OPENCODE_FILES } from "./core-skills.js";
import { coreManifest, rememberCoreManifest } from "./core-bundle.js";
import { Schema } from "effect";
import { commandDefinitionsSchema } from "./native-command-schema.js";

test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("released engine and UI select shared defaults, preserve overrides and load shared updates without project rewrites", async () => {
  const root = await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/shared-core-")), previous = { ...process.env };
  const ids = ["stock", "custom", "unknown", "fresh"];
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "private/server.json"), token: "fixture", hostToken: "fixture-host",
    workspaces: ids.map(id => ({ id, name: id, path: join(root, id), preset: "starter", workspaceType: "local" })),
    authorizedRoots: ids.map(id => join(root, id)), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false,
    engineProjectTrustRequired: true, engineConfigurationMode: "native-project", startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  let server: Awaited<ReturnType<typeof startServer>> | undefined, engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  const projectSkill = (id: string) => join(root, id, ".opencode/skills/docx-edit/SKILL.md");
  try {
    process.env.LEGALWORK_RUNTIME_DB = join(root, "private/runtime.sqlite");
    process.env.LEGALWORK_TOKEN_STORE = join(root, "private/tokens.json");
    process.env.XDG_CONFIG_HOME = join(root, "profile");
    process.env.EIGENWELT_PLATFORM_URL = "http://127.0.0.1:1";
    for (const id of ids) await mkdir(join(root, id, ".git"), { recursive: true });
    for (const id of ["stock", "custom", "unknown"]) await ensureCoreOpencodeFiles(join(root, id));
    // An older release's pristine package must not win over current built-ins.
    const oldPaths = new Set([".opencode/skills/docx-edit/SKILL.md", ".opencode/agents/document-extractor.md", ".opencode/commands/edit-docx.md"]);
    const oldFiles = CORE_OPENCODE_FILES.map(file => oldPaths.has(file.path) ? { ...file, content: file.content + "\nOld bundled version marker.\n" } : file);
    for (const file of oldFiles.filter(file => oldPaths.has(file.path))) await writeFile(join(root, "stock", file.path), file.content);
    const old = coreManifest(oldFiles);
    await rememberCoreManifest(managedCoreLibraryRoot(config), old);
    await writeFile(join(root, "stock/.opencode/.legalwork-core"), old.bundle);
    const original = await readFile(projectSkill("stock"), "utf8"), before = await stat(projectSkill("stock"));
    await writeFile(join(root, "custom/.opencode/skills/docx-edit/assets/docx-agent.mjs"), "// My project-specific Word helper\n");
    const customAgent = join(root, "custom/.opencode/agents/document-extractor.md");
    await writeFile(customAgent, await readFile(customAgent, "utf8") + "\nMy custom agent instructions.\n");
    const customCommand = join(root, "custom/.opencode/commands/edit-docx.md");
    await writeFile(customCommand, await readFile(customCommand, "utf8") + "\nMy custom shortcut instructions.\n");
    await writeFile(join(root, "unknown/.opencode/.legalwork-core"), "unknown-legacy-bundle");
    await mkdir(join(root, "custom/.opencode/skills/case-specific"));
    await writeFile(join(root, "custom/.opencode/skills/case-specific/SKILL.md"), "---\nname: case-specific\ndescription: My custom skill\n---\nProject instructions.\n");
    await writeLegalworkRuntimeConfigFile(config, "stock");
    const shared = join(managedCoreLibraryRoot(config), ".opencode/skills/docx-edit/SKILL.md");
    server = await startServer(config);
    engine = await createManagedOpencodeServer({ bin: process.env.LEGALWORK_TEST_OPENCODE_BIN, cwd: root, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "profile"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: orgPolicyEngineDir(config), OPENCODE_CONFIG: legalworkRuntimeConfigFilePath(config), OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config), OPENCODE_DB: join(root, "engine.db"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", LEGALWORK_SERVER_URL: `http://127.0.0.1:${server.port}`, LEGALWORK_SERVER_TOKEN: config.token,
    } });
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    for (const id of ids) {
      await client.model.list({ location: { directory: join(root, id) } });
      const expected = ["custom", "unknown"].includes(id) ? projectSkill(id) : shared;
      const native = (await client.skill.list({ location: { directory: join(root, id) } })).data;
      const failed = (await client.plugin.list({ location: { directory: join(root, id) } })).data.filter(plugin => plugin.state.status === "failed");
      expect(failed).toEqual([]);
      expect(native.find(skill => skill.id === "docx-edit")?.path).toBe(expected);
      const agent = (await client.agent.list({ location: { directory: join(root, id) } })).data.find(agent => agent.id === "document-extractor");
      expect(agent?.system).toContain(id === "custom" ? "My custom agent instructions." : "isolated text inference worker");
      expect(agent?.system).not.toContain("Old bundled version marker.");
      const commandResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/${id}/commands/definitions`, { headers: { authorization: `Bearer ${config.token}` } });
      const commands = Schema.decodeUnknownSync(commandDefinitionsSchema)(await commandResponse.json());
      expect(commands.commands["edit-docx"]?.template).toBeDefined();
      expect(commands.commands["edit-docx"]?.template).not.toContain("Old bundled version marker.");
      if (id === "custom") expect(commands.commands["edit-docx"]?.template).toContain("My custom shortcut instructions.");
      const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${id}/skills?includeGlobal=true`, { headers: { authorization: `Bearer ${config.token}` } });
      expect(response.status).toBe(200);
      const visible = await response.json();
      expect(visible.items.find((skill: { name: string }) => skill.name === "docx-edit").path).toBe(expected);
    }
    expect((await client.skill.list({ location: { directory: join(root, "custom") } })).data.some(skill => skill.id === "case-specific")).toBe(true);
    expect(await stat(join(root, "fresh/.opencode/skills")).catch(() => null)).toBeNull();
    await writeFile(customAgent, await readFile(customAgent, "utf8") + "\nLive agent edit.\n");
    const deadline = Date.now() + 5_000;
    let updated = false;
    while (!updated && Date.now() < deadline) {
      updated = (await client.agent.list({ location: { directory: join(root, "custom") } })).data.some(agent => agent.id === "document-extractor" && agent.system?.includes("Live agent edit."));
      if (!updated) await Bun.sleep(25);
    }
    expect(updated).toBe(true);
    await writeFile(shared, await readFile(shared, "utf8") + "\nShared update verification marker.\n");
    await writeLegalworkRuntimeConfigFile(config, "stock");
    await client.location.reload();
    for (const id of ["stock", "fresh"]) {
      await client.model.list({ location: { directory: join(root, id) } });
      const loaded = (await client.skill.list({ location: { directory: join(root, id) } })).data.find(skill => skill.id === "docx-edit");
      expect(loaded?.path).toBe(shared);
      expect(loaded?.content).toContain("Shared update verification marker.");
    }
    expect(await readFile(projectSkill("stock"), "utf8")).toBe(original);
    expect((await stat(projectSkill("stock"))).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(join(root, "custom/.opencode/skills/docx-edit/assets/docx-agent.mjs"), "utf8")).toContain("My project-specific");
  } finally {
    await engine?.close(); await server?.stop(); await closeRuntimeOpencodeConfig(config);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
