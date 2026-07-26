import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureOpencodeStateDir } from "./opencode-state-dir.js";
import { exists } from "./utils.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "legalwork-state-dir-"));
}

describe("ensureOpencodeStateDir", () => {
  test("creates .opencode when it is missing", async () => {
    const root = await workspace();
    const result = await ensureOpencodeStateDir(root);

    expect(result.path).toBe(join(root, ".opencode"));
    expect(result.movedTo).toBeNull();
    expect((await lstat(result.path)).isDirectory()).toBe(true);
  });

  test("leaves an existing .opencode directory and its contents alone", async () => {
    const root = await workspace();
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(join(root, ".opencode", "legalwork.json"), '{"keep":true}\n', "utf8");

    const result = await ensureOpencodeStateDir(root);

    expect(result.movedTo).toBeNull();
    expect(await readFile(join(root, ".opencode", "legalwork.json"), "utf8")).toBe('{"keep":true}\n');
  });

  test("moves a stray .opencode FILE aside and creates the directory", async () => {
    // The issue #62 shape: the engine's instance bootstrap does mkdir(.opencode),
    // which throws EEXIST on a file and 500s every route for the workspace.
    const root = await workspace();
    await writeFile(join(root, ".opencode"), "stray\n", "utf8");

    const result = await ensureOpencodeStateDir(root, 1700000000000);

    expect(result.movedTo).toBe(join(root, ".opencode.invalid-1700000000000"));
    expect((await lstat(result.path)).isDirectory()).toBe(true);
    // Never destroy user data we did not write.
    expect(await readFile(result.movedTo!, "utf8")).toBe("stray\n");
  });

  test("moves a .opencode symlink aside (it breaks the engine the same way)", async () => {
    const root = await workspace();
    await writeFile(join(root, "target.txt"), "x\n", "utf8");
    await symlink(join(root, "target.txt"), join(root, ".opencode"));

    const result = await ensureOpencodeStateDir(root, 1700000000000);

    expect(result.movedTo).toBe(join(root, ".opencode.invalid-1700000000000"));
    expect((await lstat(result.path)).isDirectory()).toBe(true);
  });

  test("does not overwrite an existing backup from a previous repair", async () => {
    const root = await workspace();
    await writeFile(join(root, ".opencode"), "second\n", "utf8");
    await writeFile(join(root, ".opencode.invalid-1700000000000"), "first\n", "utf8");

    const result = await ensureOpencodeStateDir(root, 1700000000000);

    expect(result.movedTo).toBe(join(root, ".opencode.invalid-1700000000000-1"));
    expect(await readFile(join(root, ".opencode.invalid-1700000000000"), "utf8")).toBe("first\n");
    expect(await readFile(result.movedTo!, "utf8")).toBe("second\n");
  });

  test("is idempotent across repeated runs", async () => {
    const root = await workspace();
    await writeFile(join(root, ".opencode"), "stray\n", "utf8");

    await ensureOpencodeStateDir(root, 1700000000000);
    const second = await ensureOpencodeStateDir(root, 1700000000001);

    expect(second.movedTo).toBeNull();
    expect((await lstat(second.path)).isDirectory()).toBe(true);
  });

  test("reports the offending path when the stray entry cannot be moved", async () => {
    const root = await workspace();
    const statePath = join(root, ".opencode");
    await writeFile(statePath, "stray\n", "utf8");
    // A directory already sitting at every candidate backup name makes rename
    // fail (ENOTDIR/EISDIR), which stands in for the unwritable-folder case.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      await mkdir(`${statePath}.invalid-1700000000000${suffix}`, { recursive: true });
      await writeFile(join(`${statePath}.invalid-1700000000000${suffix}`, "occupied"), "x", "utf8");
    }

    const promise = ensureOpencodeStateDir(root, 1700000000000);
    await expect(promise).rejects.toThrow(/\.opencode/);
    // The stray file is still there for the user to inspect.
    expect(await exists(statePath)).toBe(true);
  });
});
