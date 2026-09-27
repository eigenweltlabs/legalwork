import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceArtifactTargets } from "./routes/files.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("resolves bare filenames in nested folders and preserves their real path and case", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-resolution-"));
  roots.push(root);
  const folder = "benchmark/robert-hourly-rate/sources";
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, folder, "Engagement.docx"), "document");
  const result = await resolveWorkspaceArtifactTargets(root, [
    { value: "engagement.docx" }, { value: `${folder}/Engagement.docx` },
  ]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ value: `${folder}/Engagement.docx`, name: "Engagement.docx", exists: true, preview: "word" });
});

test("does not guess between duplicates, rewrite explicit missing paths, or follow folder symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-resolution-"));
  const outside = await mkdtemp(join(tmpdir(), "artifact-outside-"));
  roots.push(root, outside);
  for (const folder of ["a", "b"]) {
    await mkdir(join(root, folder));
    await writeFile(join(root, folder, "contract.docx"), folder);
  }
  await writeFile(join(root, "a", "only.docx"), "a");
  await writeFile(join(outside, "private.docx"), "outside");
  await symlink(outside, join(root, "linked"), "dir");
  const result = await resolveWorkspaceArtifactTargets(root, [
    { value: "contract.docx" }, { value: "wrong/only.docx" }, { value: "private.docx" },
    { value: "a/contract.docx" }, { value: "../private.docx" },
  ]);
  expect(result).toHaveLength(4);
  expect(result.filter(item => item.exists)).toEqual([
    expect.objectContaining({ value: "a/contract.docx", exists: true }),
  ]);
});
