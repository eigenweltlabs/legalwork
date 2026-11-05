import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./types.js";
import { registerLocalProject, unregisterWorkspace } from "./routes/workspaces.js";
import { awaitRegisteredEngineProjects, commitRegisteredEngineProjects } from "./project-engine-registration.js";
import { nativeEngineProjectRegistryPath } from "./engine-project.js";
import { nativeEngineLocationApproved } from "./native-engine-project-registry.js";
import { managedEngineSettingsFilePath } from "./legalwork-runtime-config.js";
import { WikiStore } from "./wiki/store.js";

const engineModes = ["managed", "native-project"] satisfies Array<NonNullable<ServerConfig["engineConfigurationMode"]>>;
async function fixture(engineConfigurationMode: NonNullable<ServerConfig["engineConfigurationMode"]>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-registration-")));
  const previous = process.env.LEGALWORK_RUNTIME_DB; process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host-fixture", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, engineConfigurationMode, opencodeBaseUrl: "http://127.0.0.1:1" };
  return { root, config, close: async () => { if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous; await rm(root, { recursive: true, force: true }); } };
}

test.each(engineModes)("%s new local projects and wikis publish native settings and admission before returning", async mode => {
  const run = await fixture(mode), wiki = new WikiStore(run.config);
  try {
    const project = await registerLocalProject(run.config, { folderPath: join(run.root, "matter"), name: "Matter", preset: "starter" });
    expect(project.persisted).toBe(true);
    const registry = nativeEngineProjectRegistryPath(run.config);
    expect(await nativeEngineLocationApproved(registry, project.workspace.path)).toBe(true);
    expect(JSON.parse(await readFile(managedEngineSettingsFilePath(run.config), "utf8")).workspaces[project.workspace.id].directory).toBe(project.workspace.path);
    const created = await wiki.create({ name: "Knowledge", root: join(run.root, "wiki") });
    expect(await nativeEngineLocationApproved(registry, created.root)).toBe(true);
    await wiki.forget(created.id);
    expect(await nativeEngineLocationApproved(registry, created.root)).toBe(false);
    await unregisterWorkspace(run.config, project.workspace);
    expect(JSON.parse(await readFile(registry, "utf8")).projects).toEqual([]);
  } finally { await wiki.close(); await run.close(); }
});

test.each(engineModes)("%s first execution waits for persistence; failed publication blocks until an explicit retry", async mode => {
  const run = await fixture(mode);
  let release = () => {}, started = false, admitted = false;
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    const save = commitRegisteredEngineProjects(run.config, async () => { started = true; await wait; return true; });
    const admission = awaitRegisteredEngineProjects(run.config).then(() => { admitted = true; });
    await Promise.resolve(); expect(started).toBe(true); expect(admitted).toBe(false);
    release(); await save; await admission; expect(admitted).toBe(true);
    const storage = join(run.root, "broken"); await mkdir(storage); run.config.managedEngineStorageDirectory = join(storage, "not-a-directory");
    const { writeFile } = await import("node:fs/promises"); await writeFile(run.config.managedEngineStorageDirectory, "block publication");
    await expect(commitRegisteredEngineProjects(run.config, async () => true)).rejects.toMatchObject({ code: "project_engine_setup_failed" });
    await expect(awaitRegisteredEngineProjects(run.config)).rejects.toMatchObject({ code: "project_engine_setup_failed" });
    run.config.managedEngineStorageDirectory = join(run.root, "fixed");
    await commitRegisteredEngineProjects(run.config, async () => true);
    await expect(awaitRegisteredEngineProjects(run.config)).resolves.toBeUndefined();
  } finally { release(); await run.close(); }
});
