import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { closeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

test("rebuilding settings never rewrites immutable plugin entries or publishes partial concurrent bundles", async () => {
  const root = await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/native-bundle-identity-"));
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "private", "runtime.sqlite");
  const directory = join(root, "matter"); await mkdir(directory);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "private", "server.json"), token: "fixture", hostToken: "fixture-host", workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }], authorizedRoots: [directory], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  try {
    await writeLegalworkRuntimeConfigFile(config, "matter");
    const bundles = join(root, "private", "bundled-plugins");
    const entries = (await readdir(bundles)).map(name => join(bundles, name, "index.js"));
    expect(entries.length).toBeGreaterThan(20);
    const before = await Promise.all(entries.map(path => stat(path)));
    await Promise.all([writeLegalworkRuntimeConfigFile(config, "matter"), writeLegalworkRuntimeConfigFile(config, "matter")]);
    const after = await Promise.all(entries.map(path => stat(path)));
    expect(after.map(file => ({ ino: file.ino, mtime: file.mtimeMs, size: file.size }))).toEqual(before.map(file => ({ ino: file.ino, mtime: file.mtimeMs, size: file.size })));
    const first = entries[0]; if (!first) throw new Error("Missing native bundle fixture");
    await writeFile(first, "Corrupted immutable plugin");
    await expect(writeLegalworkRuntimeConfigFile(config, "matter")).rejects.toThrow("immutable LegalWork plugin bundle");
  } finally {
    await closeRuntimeOpencodeConfig(config);
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});
