import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { approveEngineProject, assertEngineProjectReady, engineProjectStatus, writeNativeProjectProjection } from "./engine-project.js";
import { approvedNativePluginIdentities, nativePluginIdentity } from "./native-project-plugins.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-engine-project-")));
  const directory = join(root, "project"); await mkdir(directory);
  const workspace: WorkspaceInfo = { id: "matter", path: directory, name: "Matter", preset: "starter", workspaceType: "local" };
  const config: ServerConfig = { configPath: join(root, "private", "server.json"), host: "127.0.0.1", port: 0,
    token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [workspace], authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, engineProjectTrustRequired: true };
  return { root, directory, config, workspace };
}

test("recovery readiness reveals only the selected project's interrupted chats", async () => {
  const { root, directory, config, workspace } = await fixture();
  try {
    config.managedEngineRecoveryState = () => ({ mode: "recovery", heldSessions: [
      { id: "own-interrupted-chat", directory }, { id: "private-other-chat", directory: join(root, "private-other-project") },
    ], error: { code: "private-other-project-failure", message: "Secret path: " + join(root, "private-other-project", "private.docx") } });
    const status = await engineProjectStatus(config, workspace);
    expect(status.recovery).toEqual({ mode: "recovery", heldSessionIds: ["own-interrupted-chat"], waitingForOtherProjects: true,
      error: { code: "engine_recovery_pending", message: "Interrupted work remains paused. Review pending project approvals and unfinished Undo, then retry recovery." } });
    expect(JSON.stringify(status)).not.toContain("private-other");
    config.managedEngineRecoveryState = () => ({ mode: "service", heldSessions: [] });
    expect((await engineProjectStatus(config, workspace)).recovery).toEqual({ mode: "service", heldSessionIds: [], waitingForOtherProjects: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native project trust persists canonical folder and ancestor scope; changed executable targets require review", async () => {
  const { root, directory, config, workspace } = await fixture();
  try {
    await writeFile(join(root, "opencode.jsonc"), "// Authored ancestor\n{\"plugins\":[\"@example/first@1.0.0\"]}\n");
    const initial = await engineProjectStatus(config, workspace);
    expect(initial.state).toBe("approval_required");
    expect(initial.approvalScope.find(item => item.directory === root)?.configPaths).toContain(join(root, "opencode.jsonc"));
    await expect(assertEngineProjectReady(config, workspace)).rejects.toMatchObject({ code: "project_automation_approval_required" });
    await expect(approveEngineProject(config, workspace, directory, [])).rejects.toMatchObject({ code: "project_plugin_approval_changed" });
    const approved = await approveEngineProject(config, workspace, directory, initial.plugins.map(item => item.target));
    expect(approved.state).toBe("ready"); expect(approved.approvedAt).toBeGreaterThan(0);
    await assertEngineProjectReady(config, workspace);
    expect(await approvedNativePluginIdentities(config)).toEqual(["@example/first"]);
    // Native policy grants package identities; versions are deliberately not
    // presented as an enforced package lock.
    await writeFile(join(root, "opencode.jsonc"), "{\"plugins\":[\"@example/first@2.0.0\"]}");
    expect((await engineProjectStatus(config, workspace)).state).toBe("ready");
    await writeFile(join(directory, "opencode.json"), "{\"plugins\":[\"@example/new@1.0.0\"]}");
    expect((await engineProjectStatus(config, workspace)).state).toBe("approval_required");
    await expect(approveEngineProject(config, workspace, join(root, "another"), [])).rejects.toMatchObject({ code: "project_directory_changed" });
    expect(nativePluginIdentity(join(directory, "local@folder"))).toBe(join(directory, "local@folder"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("projection preserves authored JSONC and uses private references for full native strings and secrets", async () => {
  const { root, directory, config, workspace } = await fixture();
  try {
    const authored = "// User comments stay intact\n{ \"model\": \"fixture/authored\", }\n";
    await writeFile(join(directory, "opencode.json"), authored);
    const input = Schema.decodeUnknownSync(Config.Info)({ agents: { legalwork: { system: " \n private prompt \n " } },
      providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: "synthetic-private-key" }, models: { model: { variants: [{ id: "deep", settings: { reasoningEffort: "high" } }] } } } } });
    const path = await writeNativeProjectProjection(config, workspace, input);
    expect(path).toBe(join(directory, "opencode.jsonc"));
    expect(await readFile(join(directory, "opencode.json"), "utf8")).toBe(authored);
    const generated = await readFile(path, "utf8");
    expect(generated).toContain("{file:"); expect(generated).not.toContain("synthetic-private-key"); expect(generated).not.toContain("private prompt");
    expect(generated).not.toContain("reasoningEffort\": \"high");
    await approveEngineProject(config, workspace, directory, []);
    await writeNativeProjectProjection(config, workspace, input);
    expect((await engineProjectStatus(config, workspace)).state).toBe("ready");
    await writeFile(path, "// Modified outside LegalWork\n{}\n");
    await expect(writeNativeProjectProjection(config, workspace, input)).rejects.toMatchObject({ code: "project_engine_configuration_conflict" });
    expect(await readFile(path, "utf8")).toContain("Modified outside LegalWork");
    expect((await engineProjectStatus(config, workspace)).state).toBe("configuration_conflict");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent managed projection changes and admission checks never report a false authored-file conflict", async () => {
  const { root, directory, config, workspace } = await fixture();
  try {
    await writeNativeProjectProjection(config, workspace, Schema.decodeUnknownSync(Config.Info)({}));
    await approveEngineProject(config, workspace, directory, []);
    let complete = false;
    const changes = Promise.all(Array.from({ length: 8 }, (_, index) => writeNativeProjectProjection(config, workspace,
      Schema.decodeUnknownSync(Config.Info)({ agents: { legalwork: { system: `Managed update ${index}` } } }))))
      .finally(() => { complete = true; });
    const observed: string[] = [];
    while (!complete) observed.push((await engineProjectStatus(config, workspace)).state);
    await changes;
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(state => state === "ready")).toBe(true);
    expect((await engineProjectStatus(config, workspace)).state).toBe("ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all occupied native document slots are preserved and produce an actionable conflict", async () => {
  const { root, directory, config, workspace } = await fixture();
  try {
    await mkdir(join(directory, ".opencode"));
    const files = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"];
    for (const path of files) await writeFile(join(directory, path), "// Authored\n{}\n");
    expect((await engineProjectStatus(config, workspace)).state).toBe("configuration_conflict");
    await expect(writeNativeProjectProjection(config, workspace, Schema.decodeUnknownSync(Config.Info)({}))).rejects.toMatchObject({ code: "project_engine_configuration_conflict" });
    for (const path of files) expect(await readFile(join(directory, path), "utf8")).toBe("// Authored\n{}\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("unapproved plugin file references remain literal in the review and are resolved privately only on approval", async () => {
  const { root, directory, config, workspace } = await fixture();
  try {
    const privateTarget = join(root, "private-target.txt");
    await writeFile(privateTarget, "@example/private-package@1.0.0");
    const label = `{file:${privateTarget}}`;
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ plugins: [label] }));
    const pending = await engineProjectStatus(config, workspace);
    expect(pending.plugins.map(item => item.target)).toEqual([label]);
    expect(JSON.stringify(pending)).not.toContain("@example/private-package");
    const approved = await approveEngineProject(config, workspace, directory, [label]);
    expect(approved.state).toBe("ready");
    expect(approved.plugins.map(item => item.target)).toEqual([label]);
    expect(await approvedNativePluginIdentities(config)).toEqual(["@example/private-package"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
