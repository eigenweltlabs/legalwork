import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyAssistantFiles } from "./assistant-delegation-files.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "assistant-files-")); roots.push(root);
  const source = join(root, "assistant"), target = join(root, "matter");
  await mkdir(join(source, "uploads"), { recursive: true }); await mkdir(target);
  await writeFile(join(source, "one.pdf"), Buffer.from([0, 1, 255, 20]));
  await writeFile(join(source, "uploads/one.pdf"), "Another source");
  await writeFile(join(root, "private.txt"), "Outside source workspace");
  return { root, source, target };
}

test("delegation copies exact bytes, keeps sources, handles duplicate filenames and approves before writing", async () => {
  const f = await fixture();
  const copied = await copyAssistantFiles(f.source, f.target, ["one.pdf", "uploads/one.pdf", "one.pdf"], async paths => {
    expect(paths).toHaveLength(2); expect(await readdir(f.target)).toEqual([]);
  });
  expect(copied).toHaveLength(2);
  expect(copied[0].path).not.toBe(copied[1].path);
  for (const item of copied) expect(await readFile(join(f.target, item.path))).toEqual(await readFile(join(f.source, item.sourcePath)));
});

test("invalid files and denied approval never start publishing the valid file", async () => {
  const f = await fixture();
  for (const bad of ["../private.txt", join(f.root, "private.txt"), "missing.txt"]) {
    await expect(copyAssistantFiles(f.source, f.target, ["one.pdf", bad], async () => { throw new Error("Must not request approval"); })).rejects.toThrow();
    expect(await readdir(f.target)).toEqual([]);
  }
  await expect(copyAssistantFiles(f.source, f.target, ["one.pdf"], async () => { throw new Error("Denied"); })).rejects.toThrow("Denied");
  expect(await readdir(f.target)).toEqual([]);
});

test("linked sources and destination folders cannot escape either project", async () => {
  const f = await fixture();
  await symlink(join(f.root, "private.txt"), join(f.source, "linked.txt"));
  await expect(copyAssistantFiles(f.source, f.target, ["linked.txt"], async () => {})).rejects.toThrow("inside this workspace");
  await mkdir(join(f.root, "outside"));
  await symlink(join(f.root, "outside"), join(f.target, "Files"));
  await expect(copyAssistantFiles(f.source, f.target, ["one.pdf"], async () => {})).rejects.toThrow("inside this workspace");
  expect(await readdir(join(f.root, "outside"))).toEqual([]);
});
