import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { backupRuntimeConfigSource } from "./runtime-config-source-backup.js";

test("explicit file import backups preserve exact bytes and provenance privately without modifying the case source", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-config-source-backup-")), previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "private", "runtime.sqlite");
  const source = join(root, "opencode.jsonc"), content = '// Keep comments and spacing\n{ "permission": "deny", "provider": {"fixture":{"options":{"apiKey":"synthetic-only"}}} }\n';
  try {
    await writeFile(source, content);
    const config = { configPath: join(root, "private", "server.json") };
    const first = await backupRuntimeConfigSource(config, "../project", source);
    expect(await readFile(first.path, "utf8")).toBe(content);
    expect(await readFile(source, "utf8")).toBe(content);
    expect(relative(join(root, "private", "configuration-import-backups"), first.path).startsWith("..")).toBe(false);
    expect(await backupRuntimeConfigSource(config, "../project", source)).toEqual(first);
    if (process.platform !== "win32") expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    await writeFile(first.path, "corrupted backup");
    await expect(backupRuntimeConfigSource(config, "../project", source)).rejects.toThrow("does not match");
    expect(await readFile(source, "utf8")).toBe(content);
  } finally { if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous; await rm(root, { recursive: true, force: true }); }
});
