import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ensureOpencodeStateDir } from "./opencode-state-dir.mjs";

async function workspace() {
  return mkdtemp(path.join(tmpdir(), "legalwork-state-dir-"));
}

test("creates .opencode when it is missing", async () => {
  const root = await workspace();
  const result = await ensureOpencodeStateDir(root);

  assert.equal(result.path, path.join(root, ".opencode"));
  assert.equal(result.movedTo, null);
  assert.equal((await lstat(result.path)).isDirectory(), true);
});

test("leaves an existing .opencode directory and its contents alone", async () => {
  const root = await workspace();
  await mkdir(path.join(root, ".opencode"), { recursive: true });
  await writeFile(path.join(root, ".opencode", "legalwork.json"), '{"keep":true}\n', "utf8");

  const result = await ensureOpencodeStateDir(root);

  assert.equal(result.movedTo, null);
  assert.equal(await readFile(path.join(root, ".opencode", "legalwork.json"), "utf8"), '{"keep":true}\n');
});

// The issue #62 shape: the engine's instance bootstrap runs mkdir(.opencode),
// which throws EEXIST on a file, aborting bootstrap so every route for that
// workspace answers 500.
test("moves a stray .opencode FILE aside and creates the directory", async () => {
  const root = await workspace();
  await writeFile(path.join(root, ".opencode"), "stray\n", "utf8");

  const result = await ensureOpencodeStateDir(root, 1700000000000);

  assert.equal(result.movedTo, path.join(root, ".opencode.invalid-1700000000000"));
  assert.equal((await lstat(result.path)).isDirectory(), true);
  // Never destroy user data we did not write.
  assert.equal(await readFile(result.movedTo, "utf8"), "stray\n");
});

test("moves a .opencode symlink aside (it breaks the engine the same way)", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "target.txt"), "x\n", "utf8");
  await symlink(path.join(root, "target.txt"), path.join(root, ".opencode"));

  const result = await ensureOpencodeStateDir(root, 1700000000000);

  assert.equal(result.movedTo, path.join(root, ".opencode.invalid-1700000000000"));
  assert.equal((await lstat(result.path)).isDirectory(), true);
});

test("does not overwrite an existing backup from a previous repair", async () => {
  const root = await workspace();
  await writeFile(path.join(root, ".opencode"), "second\n", "utf8");
  await writeFile(path.join(root, ".opencode.invalid-1700000000000"), "first\n", "utf8");

  const result = await ensureOpencodeStateDir(root, 1700000000000);

  assert.equal(result.movedTo, path.join(root, ".opencode.invalid-1700000000000-1"));
  assert.equal(await readFile(path.join(root, ".opencode.invalid-1700000000000"), "utf8"), "first\n");
  assert.equal(await readFile(result.movedTo, "utf8"), "second\n");
});

test("is idempotent across repeated runs", async () => {
  const root = await workspace();
  await writeFile(path.join(root, ".opencode"), "stray\n", "utf8");

  await ensureOpencodeStateDir(root, 1700000000000);
  const second = await ensureOpencodeStateDir(root, 1700000000001);

  assert.equal(second.movedTo, null);
  assert.equal((await lstat(second.path)).isDirectory(), true);
});
