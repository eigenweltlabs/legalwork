import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMounts } from "./files.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
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

test("project skills have the same edit access through both aliases; global skills stay read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-skill-mounts-")); roots.push(root);
  const project = join(root, "project"), skill = join(project, ".opencode/skills/helper"), global = join(root, "global");
  await mkdir(skill, { recursive: true }); await mkdir(global);
  const mounts = [{ source: project, target: "/workspace", writable: true }, { source: skill, target: "/skills/0", writable: true }];
  expect((await validateMounts(mounts))[1].writable).toBe(true);
  await expect(validateMounts([{ ...mounts[0], writable: false }, mounts[1]])).rejects.toThrow("read-only");
  await expect(validateMounts([mounts[0], { ...mounts[1], source: global }])).rejects.toThrow("read-only");
});
