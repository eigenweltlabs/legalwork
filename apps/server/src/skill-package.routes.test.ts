import { nativePluginTools } from "./opencode-plugins/native-plugin-test-support.js";
const LegalWorkSkillTools = (context = {}) => nativePluginTools(LegalWorkSkillToolsDefinition, context);
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { startServer } from "./server.js";
import { upsertSkill } from "./skills.js";
import { upsertSkillResource } from "./skill-resources.js";
import LegalWorkSkillToolsDefinition from "./opencode-plugins/legalwork-skill-tools.js";
import type { OpenCodeContext } from "./opencode-plugins/office-plugin-shared.js";
import type { ServerConfig } from "./types.js";

test("a global workflow exposes current Markdown and Word resources in fresh projects without external-folder grants", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skill-package-http-")));
  const previous = Object.fromEntries(["XDG_CONFIG_HOME", "LEGALWORK_RUNTIME_DB", "LEGALWORK_SERVER_URL", "LEGALWORK_SERVER_TOKEN"].map(key => [key, process.env[key]]));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace = join(root, "matter"), other = join(root, "other");
  await mkdir(workspace); await mkdir(other);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "token", hostToken: "host-token", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [],
    workspaces: [workspace, other].map((path, index) => ({ id: `ws_${index}`, name: "Test", path, preset: "starter", workspaceType: "local" })),
    authorizedRoots: [workspace, other], readOnly: false, startedAt: Date.now(),
    tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    process.env.LEGALWORK_SERVER_URL = base; process.env.LEGALWORK_SERVER_TOKEN = "token";
    const name = "workflow-assistant-bkl-mandatsaufnahme";
    const skill = await upsertSkill(workspace, { name, scope: "global", content: "Read resources/felder.md and resources/template.docx.", description: "Firm intake workflow" });
    await upsertSkillResource(workspace, name, { name: "felder.md", content: "Current intake fields" });
    const docx = await readFile(new URL("../resources/core-opencode/skills/workflow-assistant-due-diligence/resources/DD-Report-Template.docx", import.meta.url));
    await upsertSkillResource(workspace, name, { name: "template.docx", contentBase64: docx.toString("base64") });
    const sibling = await upsertSkill(workspace, { name: "unrelated", scope: "global", content: "Private unrelated instructions", description: "Other skill" });
    await upsertSkillResource(workspace, "unrelated", { name: "private.md", content: "Unrelated resource" });
    const requests: Array<{ permission: string; patterns: string[] }> = [];
    let denied = "";
    const ask: NonNullable<OpenCodeContext["ask"]> = async input => {
      requests.push(input);
      if (input.permission === "external_directory") throw new Error("Unexpected external-folder request");
      if (input.permission === denied) throw new Error("Permission denied");
    };
    const plugin = await LegalWorkSkillTools();
    const context = { directory: workspace, sessionID: "chat-a", ask };
    const load = () => plugin.tool.legalwork_skill_load.execute({ name }, context);
    const read = (path: string, ctx = context, selectedName = name) => plugin.tool.legalwork_skill_read.execute({ name: selectedName, path }, ctx);
    await expect(read("resources/felder.md")).rejects.toThrow("Load this skill");
    const loaded = JSON.parse(await load());
    expect(loaded.payload.chain[0]).toMatchObject({ name, directory: dirname(skill.path), scope: "global" });
    expect(loaded.payload.resources.shell).toMatchObject({ skills: [name], mounts: [{ name, hostDirectory: dirname(skill.path), sandboxDirectory: "/skills/0" }] });
    expect(JSON.parse(await read("resources/felder.md")).payload.content).toBe("Current intake fields");
    expect(JSON.parse(await read("resources/template.docx")).payload.content).toContain("{{matter_name}}");
    expect(requests.map(request => request.permission)).toEqual(["skill", "read", "skill", "read", "skill", "read"]);
    expect(requests.at(-1)?.patterns).toEqual([join(dirname(skill.path), "resources/template.docx")]);
    await expect(read("resources/private.md", context, "unrelated")).rejects.toThrow("Load this skill");
    await expect(read("../unrelated/resources/private.md")).rejects.toThrow("exact path");
    await expect(read("resources/felder.md", { ...context, sessionID: "chat-b" })).rejects.toThrow("Load this skill");
    await expect(read("resources/felder.md", { ...context, directory: other })).rejects.toThrow("Load this skill");
    denied = "read";
    await expect(read("resources/felder.md")).rejects.toThrow("Permission denied");
    denied = "skill";
    await expect(plugin.tool.legalwork_skill_load.execute({ name: "unrelated" }, context)).rejects.toThrow("Permission denied");
    await expect(read("resources/private.md", context, "unrelated")).rejects.toThrow("Load this skill");
    denied = "";
    await upsertSkillResource(workspace, name, { name: "felder.md", content: "Reimported intake fields" });
    expect(JSON.parse(await read("resources/felder.md")).payload.content).toBe("Reimported intake fields");
    const freshContext = { ...context, directory: other, sessionID: "fresh-chat" };
    await plugin.tool.legalwork_skill_load.execute({ name }, freshContext);
    expect(JSON.parse(await read("resources/felder.md", freshContext)).payload.content).toBe("Reimported intake fields");
    for (const path of [workspace, other]) expect(await readFile(join(path, ".opencode/skills", name, "SKILL.md")).catch(() => null)).toBeNull();
    const endpoint = `${base}/workspace/ws_0/skills/${name}/package-file`;
    const query = new URLSearchParams({ directory: dirname(skill.path), path: "resources/felder.md" });
    expect((await fetch(`${endpoint}?${query}`)).status).toBe(401);
    query.set("path", "../unrelated/resources/private.md");
    expect((await fetch(`${endpoint}?${query}`, { headers: { Authorization: "Bearer token" } })).status).toBe(400);
    query.set("path", "resources/felder.md"); query.set("directory", dirname(sibling.path));
    expect((await fetch(`${endpoint}?${query}`, { headers: { Authorization: "Bearer token" } })).status).toBe(409);
    // A project override is a different package and needs a new load, even if
    // it uses the same name as a previously granted global workflow.
    await upsertSkill(workspace, { name, scope: "project", content: "Different package", description: "Project override" });
    const replaced = z.object({ ok: z.boolean(), error: z.string() }).parse(JSON.parse(await read("resources/felder.md")));
    expect(replaced.ok).toBe(false); expect(replaced.error).toContain("Load it again");
  } finally {
    await server.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    Bun.gc(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
