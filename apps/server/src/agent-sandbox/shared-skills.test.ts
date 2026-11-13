import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "../approvals.js";
import { resetOrgPolicyRuntimeForTests } from "../org-policy.js";
import { closeRuntimeOpencodeConfig, GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { WikiStore } from "../wiki/store.js";
import { AgentSandboxService } from "./service.js";
import { writeSandboxDefault } from "./settings.js";
import type { SandboxRun } from "./vm.js";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(runtimeInsideSkill = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-shared-skill-")));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  const engine = join(root, "config", "opencode");
  const library = join(engine, "skills");
  const skill = join(library, "template-helper");
  await mkdir(join(skill, "resources"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: template-helper\ndescription: Read a document template\n---\nRead resources/template.txt.\n");
  await writeFile(join(skill, "resources", "template.txt"), "Example template");
  await writeFile(join(engine, "auth.json"), "private test data");
  const project = join(root, "project");
  await mkdir(project);
  const workspace: WorkspaceInfo = { id: "project", name: "Project", path: project, preset: "starter", workspaceType: "local" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "test-host",
    configPath: join(runtimeInsideSkill ? skill : root, "private", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [project],
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const store = new WikiStore(config);
  const executions: SandboxRun[] = [];
  const service = new AgentSandboxService(config, new ApprovalService(config.approval), {
    status: async () => ({ available: true }), prepare: async () => "test-image",
    run: async input => { executions.push(input); return { output: "done", exitCode: 0, truncated: false }; },
  });
  cleanups.push(async () => {
    service.stop();
    await store.close();
    await closeRuntimeOpencodeConfig(config);
    await resetOrgPolicyRuntimeForTests(config);
    await rm(root, { recursive: true, force: true });
  });
  await writeSandboxDefault(config, { enabled: true, networkMode: "block" });
  await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [{ action: "shell", resource: "*", effect: "allow" }, { action: "read", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "allow" }, { action: "skill", resource: "*", effect: "allow" }] }));
  await store.create({ name: "Knowledge", template: "blank" });
  const run = () => service.run(workspace, { command: "cat /skills/0/resources/template.txt", skills: ["template-helper"], write: true, timeoutMs: 1000 },
    { type: "host" }, new AbortController().signal);
  return { config, workspace, run, executions, engine, library, skill };
}

test("a registered wiki does not block a selected shared skill's resources", async () => {
  const state = await setup();
  await state.run();
  expect(state.executions).toHaveLength(1);
  expect(state.executions[0].mounts).toEqual([
    { source: state.workspace.path, target: "/workspace", writable: true },
    { source: state.skill, target: "/skills/0", writable: false },
  ]);
});

test("sharing the engine configuration or entire skill library still fails with an actionable error", async () => {
  const state = await setup();
  for (const folder of [state.engine, state.library]) {
    await writeRuntimeOpencodeConfig(state.config, state.workspace.id, () => ({ permissions: [{ action: "external_directory", resource: `${folder}/*`, effect: "allow" }] }));
    await expect(state.run()).rejects.toMatchObject({ status: 403, code: "sandbox_private_runtime" });
  }
  expect(state.executions).toHaveLength(0);
});

test("a shared library redirected into another runtime folder stays blocked", async () => {
  const state = await setup();
  const redirected = join(state.engine, "private-library");
  await rename(state.library, redirected);
  await symlink(redirected, state.library, process.platform === "win32" ? "junction" : "dir");
  await expect(state.run()).rejects.toMatchObject({ status: 403, code: "sandbox_private_runtime" });
  expect(state.executions).toHaveLength(0);
});

test("selected shared skills cannot expose an embedded private runtime", async () => {
  const state = await setup(true);
  await expect(state.run()).rejects.toMatchObject({ status: 403, code: "sandbox_private_runtime" });
  expect(state.executions).toHaveLength(0);
});
