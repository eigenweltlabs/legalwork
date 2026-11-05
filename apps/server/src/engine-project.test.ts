import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { assertEngineProjectReady, engineProjectStatus, nativeEngineProjectRegistryPath, writeNativeEngineProjectRegistry, writeNativeProjectProjection } from "./engine-project.js";
import { nativeEngineLocationApproved, nativeEngineLocationApprovedSync } from "./native-engine-project-registry.js";
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
      error: { code: "engine_recovery_pending", message: "Interrupted work remains paused. Resolve unfinished chat recovery, then retry." } });
    expect(JSON.stringify(status)).not.toContain("private-other");
    config.managedEngineRecoveryState = () => ({ mode: "service", heldSessions: [] });
    expect((await engineProjectStatus(config, workspace)).recovery).toEqual({ mode: "service", heldSessionIds: [], waitingForOtherProjects: false });
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
    expect(path).toBe(join(directory, ".opencode", "opencode.json"));
    expect(await readFile(join(directory, "opencode.json"), "utf8")).toBe(authored);
    const generated = await readFile(path, "utf8");
    expect(generated).toContain("{file:"); expect(generated).not.toContain("synthetic-private-key"); expect(generated).not.toContain("private prompt");
    expect(generated).not.toContain("reasoningEffort\": \"high");
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


test("native project documents and ancestor configuration require no automation prompt", async () => {
  const {root,directory,config,workspace}=await fixture();
  try {
    config.engineConfigurationMode="native-project";
    const path=await writeNativeProjectProjection(config,workspace,Schema.decodeUnknownSync(Config.Info)({agents:{legalwork:{system:"Owned"}}}));
    expect(path).toBe(join(directory,".opencode","opencode.json"));
    const ready=await engineProjectStatus(config,workspace);
    expect(ready.state).toBe("ready");expect(ready.required).toBe(false);expect(ready.approvedAt).toBeUndefined();
    await assertEngineProjectReady(config,workspace);
    await writeFile(join(root,"opencode.jsonc"),'{"providers":{"untrusted":{"settings":{"baseURL":"https://example.invalid"}}}}');
    const review=await engineProjectStatus(config,workspace);expect(review.required).toBe(false);expect(review.state).toBe("ready");
  } finally {await rm(root,{recursive:true,force:true});}
});

test("native admission selects the nearest LegalWork project instead of an approved parent",async()=>{
  const {root,directory}=await fixture();
  try { const child=join(directory,"child");await mkdir(child);const registry=join(root,"approvals.json");
    await writeFile(registry,JSON.stringify({version:1,projects:[{directory,approved:true},{directory:child,approved:false}]}));
    expect(await nativeEngineLocationApproved(registry,child)).toBe(false);expect(nativeEngineLocationApprovedSync(registry,child)).toBe(false);
    expect(await nativeEngineLocationApproved(registry,directory)).toBe(true);
  } finally {await rm(root,{recursive:true,force:true});}
});


test("automatic admission remains coherent during consecutive owned projection replacements", async () => {
  const { root, directory, config, workspace } = await fixture();
  try {
    await writeNativeProjectProjection(config, workspace, Schema.decodeUnknownSync(Config.Info)({}));
    await writeNativeEngineProjectRegistry(config);
    const registry = nativeEngineProjectRegistryPath(config);
    let complete = false, observations = 0;
    await Promise.all([
      (async () => {
        try { for (let index = 0; index < 20; index++) await writeNativeProjectProjection(config, workspace, Schema.decodeUnknownSync(Config.Info)({ experimental: { todo: index % 2 === 0 } })); }
        finally { complete = true; }
      })(),
      (async () => {
        while (!complete) { expect(nativeEngineLocationApprovedSync(registry, directory)).toBe(true); observations++; await Bun.sleep(0); }
      })(),
    ]);
    expect(observations).toBeGreaterThan(0);
    const final = JSON.parse(await readFile(registry, "utf8")).projects[0];
    expect(final).toEqual({ directory, approved: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("registered projects require no automation approval and retain their native location boundary", async () => {
  const {root,directory,config,workspace}=await fixture();
  try {
    await writeFile(join(directory,"opencode.jsonc"),'{"$schema":"https://opencode.ai/config.json"}');
    await writeFile(join(root,"opencode.jsonc"),'{"providers":{"fixture":{"settings":{"baseURL":"https://example.invalid"}}}}');
    const status=await engineProjectStatus(config,workspace);
    expect(status.state).toBe("ready"); expect(status.required).toBe(false); expect(status.approvedAt).toBeUndefined();
    await assertEngineProjectReady(config,workspace);
    await writeNativeEngineProjectRegistry(config);
    const registry=nativeEngineProjectRegistryPath(config);
    expect(await nativeEngineLocationApproved(registry,directory)).toBe(true);
    expect(nativeEngineLocationApprovedSync(registry,directory)).toBe(true);
    expect(await nativeEngineLocationApproved(registry,root)).toBe(false);
    expect(nativeEngineLocationApprovedSync(registry,root)).toBe(false);
    await writeFile(join(directory,"opencode.jsonc"),'{"mcp":{"servers":{"fixture":{"type":"local","command":["fixture"]}}}}');
    expect((await engineProjectStatus(config,workspace)).required).toBe(false);
    expect(nativeEngineLocationApprovedSync(registry,directory)).toBe(true);
  } finally {await rm(root,{recursive:true,force:true});}
});
