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

test("keeps saved views in their viewer and reads their document type, including moved files", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-views-"));
  roots.push(root);
  await mkdir(join(root, "Moved"));
  const view = { version: 1, id: "11111111-1111-4111-8111-111111111111", title: "Your day", catalog: "legalwork-1", program: 'root = Text("Today")', queries: {}, updatedAt: 1 };
  await writeFile(join(root, "Moved/day.view.json"), JSON.stringify({ ...view, mode: "dashboard" }));
  await writeFile(join(root, "briefing.view.json"), JSON.stringify({ ...view, mode: "report" }));
  await writeFile(join(root, "settings.json"), JSON.stringify({ mode: "dashboard" }));
  await writeFile(join(root, "invalid.view.json"), "invalid");
  const result = await resolveWorkspaceArtifactTargets(root, [
    { value: "Moved/day.view.json", preview: "view" }, { value: "briefing.view.json" },
    { value: "settings.json" }, { value: "invalid.view.json" },
  ]);
  expect(result[0]).toMatchObject({ exists: true, preview: "view", documentType: "dashboard" });
  expect(result[1]).toMatchObject({ exists: true, preview: "view", documentType: "report" });
  expect(result[2]).toMatchObject({ exists: true, preview: "text" });
  expect(result[2]).not.toHaveProperty("documentType");
  // Invalid views reach the view error UI instead of being silently opened as code.
  expect(result[3]).toMatchObject({ exists: true, preview: "view" });
  expect(result[3]).not.toHaveProperty("documentType");
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
