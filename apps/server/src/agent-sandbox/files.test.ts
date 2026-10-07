import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRelative, validateMounts } from "./files.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("portable paths reject traversal, Windows aliases, devices and alternate streams", () => {
  for (const path of ["../secret", "a/../../b", "/root", "a\\b", "a:secret", "CON", "x/nul.txt", "x.", "a /b", "a\u0000b", "a//b"]) expect(safeRelative(path)).toBe(false);
  expect(safeRelative("Müller/contract v2.docx")).toBe(true);
});
test("mounts use canonical folders and protect private runtime overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-mounts-")); roots.push(root);
  const workspace = join(root, "workspace"), privatePath = join(root, "private");
  await mkdir(workspace); await mkdir(privatePath);
  const mounts = [{ source: workspace, target: "/workspace", writable: true }];
  expect(await validateMounts(mounts, [privatePath])).toEqual([{ ...mounts[0], source: await realpath(workspace) }]);
  await expect(validateMounts([{ ...mounts[0], source: root }], [privatePath])).rejects.toThrow("private runtime");
  await expect(validateMounts([...mounts, { source: privatePath, target: "/skills/0", writable: true }])).rejects.toThrow("read-only");
  await expect(validateMounts([...mounts, mounts[0]])).rejects.toThrow("Invalid sandbox folder");
});
