import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("mail consistency diagnostics run against encrypted storage in Node", () => {
  const output = mkdtempSync(join(tmpdir(), "mail-consistency-build-"));
  const server = resolve(import.meta.dir, "../../..");
  try {
    const compiled = spawnSync("pnpm", ["exec", "tsc", "--outDir", output, "--rootDir", "src", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--types", "bun-types,node",
      "src/mail/storage/consistency.ts", "src/mail/storage/content-store.ts", "src/mail/storage/database.ts"], { cwd: server, encoding: "utf8", timeout: 30000 });
    expect(compiled.error).toBeUndefined();
    if (compiled.status !== 0) throw new Error(`${compiled.stdout}\n${compiled.stderr}`);
    writeFileSync(join(output, "package.json"), '{"type":"module"}');
    symlinkSync(realpathSync(join(server, "node_modules")), join(output, "node_modules"), "dir");
    const target = join(output, "mail/storage/consistency.node-test.mjs");
    copyFileSync(join(import.meta.dir, "consistency.node-test.mjs"), target);
    const result = spawnSync("node", ["--test", target], { encoding: "utf8", timeout: 60000 });
    expect(result.error).toBeUndefined();
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    expect(result.status).toBe(0);
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 95000);
