import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Config } from "@opencode/schema/config";
import { archiveNativeProjectProjection, engineProjectStatus, writeNativeEngineProjectRegistry, nativeEngineProjectRegistryPath, writeNativeProjectProjection } from "./engine-project.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(run: (config: ServerConfig, directory: string, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-managed-project-files-")));
  const directory = join(root, "matter"); await mkdir(directory);
  const config: ServerConfig = { configPath: join(root, "private", "server.json"), host: "127.0.0.1", port: 0,
    token: "fixture", hostToken: "fixture-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "matter", path: directory, name: "Matter", preset: "starter", workspaceType: "local" }],
    authorizedRoots: [directory], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, engineProjectTrustRequired: true, engineConfigurationMode: "managed" };
  try { await run(config, directory, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("retiring an unchanged generated project file preserves complete bytes and receipt privately", () => fixture(async (config, directory) => {
  const workspace = config.workspaces[0]!;
  const file = await writeNativeProjectProjection(config, workspace, Schema.decodeUnknownSync(Config.Info)({ default_agent: "legalwork" }));
  const original = await readFile(file, "utf8");
  await archiveNativeProjectProjection(config, workspace);
  expect(await readFile(file).catch(() => undefined)).toBeUndefined();
  const archive = join(runtimeStorageDir(config), "native-project-projection-archive", hash(workspace.id));
  expect(await readFile(join(archive, hash(original) + ".jsonc"), "utf8")).toBe(original);
  const receipt = JSON.parse(await readFile(join(archive, hash(original) + ".receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ workspaceId: workspace.id, record: { directory, projection: { path: file, digest: hash(original) } } });
  await archiveNativeProjectProjection(config, workspace);
  expect(await engineProjectStatus(config, workspace)).toMatchObject({ state: "ready", required: false, projection: {}, plugins: [] });
}));

test("managed admission preserves edited and authored configuration without loading or approving it", () => fixture(async (config, directory, root) => {
  const workspace = config.workspaces[0]!;
  const file = await writeNativeProjectProjection(config, workspace, Schema.decodeUnknownSync(Config.Info)({}));
  const authored = "// My edits must remain\n{not valid native JSON\n";
  await writeFile(file, authored);
  await writeFile(join(root, "opencode.json"), "not valid parent JSON either");
  await archiveNativeProjectProjection(config, workspace);
  expect(await readFile(file, "utf8")).toBe(authored);
  expect(await engineProjectStatus(config, workspace)).toMatchObject({ state: "ready", required: false, projection: {}, plugins: [] });
  await writeNativeEngineProjectRegistry(config);
  expect(JSON.parse(await readFile(nativeEngineProjectRegistryPath(config), "utf8"))).toEqual({ version: 1, projects: [{ directory, approved: true }] });
}));

test("archive corruption stops retirement before the original generated file is removed", () => fixture(async (config) => {
  const workspace = config.workspaces[0]!;
  const file = await writeNativeProjectProjection(config, workspace, Schema.decodeUnknownSync(Config.Info)({}));
  const original = await readFile(file, "utf8");
  const archive = join(runtimeStorageDir(config), "native-project-projection-archive", hash(workspace.id));
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, hash(original) + ".jsonc"), "changed backup");
  await expect(archiveNativeProjectProjection(config, workspace)).rejects.toThrow("archive was changed");
  expect(await readFile(file, "utf8")).toBe(original);
}));
