import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { copyFilesIntoProject, resolveProjectFolder } from "./project-file-copy.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-copy-"));
  roots.push(root);
  const project = path.join(root, "Project");
  await mkdir(project);
  const source = path.join(root, "Agreement (DE).txt");
  await writeFile(source, "Original contract – unchanged");
  return { root, project, source };
}

test("resolves newly server-created projects without requiring a desktop registry entry", async () => {
  const { project, source } = await fixture();
  const server = createServer((req, res) => {
    assert.equal(req.url, "/workspaces");
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items: [
      { id: "new-project", workspaceType: "local", path: project },
      { id: "remote-project", workspaceType: "remote", path: project },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const info = { running: true, baseUrl: `http://127.0.0.1:${address.port}`, ownerToken: "fixture-token", clientToken: null };
  try {
    const resolved = await resolveProjectFolder("new-project", [], info);
    assert.equal(resolved, project);
    assert.equal((await copyFilesIntoProject(resolved, [source])).files[0].status, "copied");
    await assert.rejects(resolveProjectFolder("unknown-project", [], info), /Local project not found/);
    await assert.rejects(resolveProjectFolder("remote-project", [], info), /Local project not found/);
    await assert.rejects(resolveProjectFolder("new-project", [{ id: "new-project", name: "Remote", preset: "starter", workspaceType: "remote", path: project }], info), /Local project not found/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("copies original bytes without replacing collisions and deduplicates a drop", async () => {
  const { project, source } = await fixture();
  await writeFile(path.join(project, path.basename(source)), "Existing contract");
  const result = await copyFilesIntoProject(project, [source, source]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].status, "copied");
  assert.equal(result.files[0].path, "Agreement (DE) (2).txt");
  assert.equal(await readFile(path.join(project, result.files[0].path), "utf8"), "Original contract – unchanged");
  assert.equal(await readFile(path.join(project, path.basename(source)), "utf8"), "Existing contract");
  assert.equal(await readFile(source, "utf8"), "Original contract – unchanged");
});

test("copy is independent of the original and preserves modification time", async () => {
  const { project, source } = await fixture();
  const before = await stat(source);
  const result = await copyFilesIntoProject(project, [source]);
  assert.equal(result.files[0].status, "copied");
  const copied = path.join(project, path.basename(source));
  assert.equal(await readFile(copied, "utf8"), "Original contract – unchanged");
  assert.ok(Math.abs((await stat(copied)).mtimeMs - before.mtimeMs) < 2);
  await writeFile(copied, "Edited project copy");
  assert.equal(await readFile(source, "utf8"), "Original contract – unchanged");
});

test("failed copy preserves the source", async () => {
  const { project, source } = await fixture();
  const result = await copyFilesIntoProject(project, [source], async () => {
    throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
  });
  assert.equal(result.files[0].status, "failed");
  assert.equal(await readFile(source, "utf8"), "Original contract – unchanged");
});

test("files already in the project stay put and unavailable sources do not stop other files", async () => {
  const { root, project, source } = await fixture();
  const existing = path.join(project, "Existing.md");
  await writeFile(existing, "Keep me");
  const result = await copyFilesIntoProject(project, [existing, path.join(root, "missing"), source]);
  assert.deepEqual(result.files.map((file) => file.status), ["already_here", "failed", "copied"]);
  assert.equal(await readFile(existing, "utf8"), "Keep me");
});

test("folders and symlinks are rejected without copying their contents", async () => {
  const { root, project, source } = await fixture();
  const alias = path.join(root, "alias.txt");
  await symlink(source, alias);
  const result = await copyFilesIntoProject(project, [root, alias]);
  assert.deepEqual(result.files.map((file) => file.error), ["file_only", "file_only"]);
  assert.deepEqual(await readdir(project), []);
  assert.equal(await readFile(source, "utf8"), "Original contract – unchanged");
});

test("source changes during copying discard only the incomplete destination", async () => {
  const { project, source } = await fixture();
  const result = await copyFilesIntoProject(project, [source], async (...args) => {
    await copyFile(...args);
    await writeFile(source, "Changed outside the app");
  });
  assert.equal(result.files[0].error, "changed");
  assert.equal(await readFile(source, "utf8"), "Changed outside the app");
  assert.deepEqual(await readdir(project), []);
});

test("sidebar copies into the open subfolder and preserves originals and collisions", async () => {
  const { project, source } = await fixture();
  const folder = path.join(project, "Documents");
  await mkdir(folder);
  await writeFile(path.join(folder, path.basename(source)), "Existing document");
  const result = await copyFilesIntoProject(project, [source], undefined, "Documents");
  assert.equal(result.files[0].status, "copied");
  assert.equal(result.files[0].path, path.join("Documents", "Agreement (DE) (2).txt"));
  assert.equal(await readFile(path.join(project, result.files[0].path), "utf8"), "Original contract – unchanged");
  assert.equal(await readFile(source, "utf8"), "Original contract – unchanged");
  assert.equal(await readFile(path.join(folder, path.basename(source)), "utf8"), "Existing document");
});

test("sidebar destination cannot escape the registered project", async () => {
  const { project, source, root } = await fixture();
  await symlink(root, path.join(project, "outside"), "dir");
  for (const folder of ["..", root, "outside"]) {
    await assert.rejects(copyFilesIntoProject(project, [source], undefined, folder), /Invalid project folder/);
  }
  assert.equal(await readFile(source, "utf8"), "Original contract – unchanged");
});
