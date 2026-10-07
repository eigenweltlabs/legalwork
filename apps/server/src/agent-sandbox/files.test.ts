import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyChanges, safeRelative, snapshotFolders } from "./files.js";
const roots: string[] = [];
const signal = new AbortController().signal;
async function fixture(writable = true) {
  const root = await mkdtemp(join(tmpdir(), "sandbox-files-")); roots.push(root);
  return { root, snapshot: () => snapshotFolders([{ source: root, target: "/workspace", writable }], signal) };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("portable paths reject traversal, Windows aliases, devices and alternate streams", () => {
  for (const path of ["../secret", "a/../../b", "/root", "a\\b", "a:secret", "CON", "x/nul.txt", "x.", "a /b", "a\u0000b", "a//b"]) expect(safeRelative(path)).toBe(false);
  expect(safeRelative("Müller/contract v2.docx")).toBe(true);
});
test("snapshots exclude host configuration and secrets but include task scratch files and empty folders", async () => {
  const f = await fixture();
  await mkdir(join(f.root, ".legalwork", "scratch"), { recursive: true });
  await mkdir(join(f.root, "empty"));
  for (const file of [".env", ".env.local", ".npmrc", ".legalwork/settings.json", ".legalwork/scratch/result.txt", "input.txt"]) await writeFile(join(f.root, file), file);
  const snapshot = await f.snapshot();
  expect([...snapshot.files.keys()].sort()).toEqual(["/workspace/.legalwork/scratch/result.txt", "/workspace/input.txt"]);
  expect(snapshot.directories).toContain("/workspace/empty");
});
test("input links cannot import files outside the approved folder", async () => {
  const f = await fixture(), outside = await fixture();
  await writeFile(join(outside.root, "secret"), "secret");
  await symlink(join(outside.root, "secret"), join(f.root, "link"));
  await expect(f.snapshot()).rejects.toThrow("symbolic links");
});
test("copy-back refuses read-only folders and validates the entire batch before writes", async () => {
  const f = await fixture(false), snapshot = await f.snapshot();
  await expect(applyChanges(snapshot, [{ path: "/workspace/test", content: Buffer.from("data") }], signal)).rejects.toThrow("read-only");
  snapshot.mounts[0].writable = true;
  await expect(applyChanges(snapshot, [{ path: "/workspace/test", content: Buffer.from("data") }, { path: "/workspace/../escape", content: Buffer.from("bad") }], signal)).rejects.toThrow("Unsafe");
  expect(await readFile(join(f.root, "test")).catch(() => null)).toBeNull();
});
test("copy-back cannot replace host execution configuration", async () => {
  const f = await fixture(), snapshot = await f.snapshot();
  for (const path of [".opencode/plugin/evil.ts", ".legalwork/settings.json", ".env", ".GIT/hooks/pre-commit"]) {
    await expect(applyChanges(snapshot, [{ path: `/workspace/${path}`, content: Buffer.from("bad") }], signal)).rejects.toThrow("host execution settings");
  }
});
test("a concurrent host edit or destination symlink prevents overwrite", async () => {
  const f = await fixture(), outside = await fixture();
  await writeFile(join(f.root, "input"), "before");
  const snapshot = await f.snapshot();
  await writeFile(join(f.root, "input"), "user edit");
  await expect(applyChanges(snapshot, [{ path: "/workspace/input", content: Buffer.from("agent edit") }], signal)).rejects.toThrow("changed outside");
  await symlink(outside.root, join(f.root, "link"));
  await expect(applyChanges(snapshot, [{ path: "/workspace/link/new", content: Buffer.from("bad") }], signal)).rejects.toThrow("regular directory");
  expect(await readFile(join(f.root, "input"), "utf8")).toBe("user edit");
});
test("atomic replacement preserves hard links outside the workspace", async () => {
  const f = await fixture(), outside = await fixture();
  await writeFile(join(outside.root, "shared"), "original");
  await link(join(outside.root, "shared"), join(f.root, "input"));
  await applyChanges(await f.snapshot(), [{ path: "/workspace/input", content: Buffer.from("changed") }, { path: "/workspace/new/output", content: Buffer.from("new") }], signal);
  expect(await readFile(join(outside.root, "shared"), "utf8")).toBe("original");
  expect(await readFile(join(f.root, "input"), "utf8")).toBe("changed");
  expect(await readFile(join(f.root, "new/output"), "utf8")).toBe("new");
});


test("empty directory creation and removal survive copy-back", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "remove"));
  await applyChanges(await f.snapshot(), [
    { path: "/workspace/created/empty", directory: true },
    { path: "/workspace/remove", directory: true, deleted: true },
  ], signal);
  const snapshot = await f.snapshot();
  expect(snapshot.directories).toContain("/workspace/created/empty");
  expect(snapshot.directories).not.toContain("/workspace/remove");
});

test("overlapping folder aliases cannot write the same host file twice", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "child"));
  await writeFile(join(f.root, "child", "input"), "original");
  const snapshot = await snapshotFolders([
    { source: f.root, target: "/workspace", writable: true },
    { source: join(f.root, "child"), target: "/authorized/0", writable: true },
  ], signal);
  await expect(applyChanges(snapshot, [
    { path: "/workspace/other", content: Buffer.from("must not be applied") },
    { path: "/workspace/child/input", content: Buffer.from("first") },
    { path: "/authorized/0/input", content: Buffer.from("second") },
  ], signal)).rejects.toThrow("Duplicate sandbox output path");
  expect(await readFile(join(f.root, "child", "input"), "utf8")).toBe("original");
  expect(await readFile(join(f.root, "other")).catch(() => null)).toBeNull();
});

test("a read-only external folder rejects the whole output batch", async () => {
  const writable = await fixture(), readOnly = await fixture();
  const snapshot = await snapshotFolders([
    { source: writable.root, target: "/workspace", writable: true },
    { source: readOnly.root, target: "/authorized/0", writable: false },
  ], signal);
  await expect(applyChanges(snapshot, [
    { path: "/workspace/result", content: Buffer.from("must not be applied") },
    { path: "/authorized/0/result", content: Buffer.from("forbidden") },
  ], signal)).rejects.toThrow("read-only folder");
  expect(await readFile(join(writable.root, "result")).catch(() => null)).toBeNull();
  expect(await readFile(join(readOnly.root, "result")).catch(() => null)).toBeNull();
});
