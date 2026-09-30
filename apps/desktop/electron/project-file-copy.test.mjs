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

test("folders cannot be copied into themselves and symlinks are not followed", async () => {
  const { root, project, source } = await fixture();
  const alias = path.join(root, "alias.txt");
  await symlink(source, alias);
  const result = await copyFilesIntoProject(project, [root, alias]);
  assert.deepEqual(result.files.map((file) => file.error), ["recursive", "file_only"]);
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


test("folder drops copy all 500 documents, nested and empty folders, without changing originals", async () => {
  const { root, project } = await fixture();
  const source = path.join(root, "Corpus");
  await mkdir(path.join(source, "nested", "empty"), { recursive: true });
  for (let i = 0; i < 500; i++) await writeFile(path.join(source, "nested", `${i}.txt`), `Contract ${i}`);
  const result = await copyFilesIntoProject(project, [source]);
  assert.ok(result.files.every((file) => file.status === "copied"));
  assert.equal((await readdir(path.join(project, "Corpus", "nested"))).length, 501);
  assert.deepEqual(await readdir(path.join(project, "Corpus", "nested", "empty")), []);
  for (let i = 0; i < 500; i++) {
    assert.equal(await readFile(path.join(project, "Corpus", "nested", `${i}.txt`), "utf8"), `Contract ${i}`);
  }
  await writeFile(path.join(project, "Corpus", "nested", "0.txt"), "Edited copy");
  assert.equal(await readFile(path.join(source, "nested", "0.txt"), "utf8"), "Contract 0");
});

test("folder collisions get a separate name in the selected destination", async () => {
  const { root, project } = await fixture();
  const source = path.join(root, "Agreements.v2");
  await mkdir(source);
  await writeFile(path.join(source, "contract.txt"), "New agreement");
  await mkdir(path.join(project, "Documents", "Agreements.v2"), { recursive: true });
  await writeFile(path.join(project, "Documents", "Agreements.v2", "contract.txt"), "Existing agreement");
  await copyFilesIntoProject(project, [source], undefined, "Documents");
  assert.equal(await readFile(path.join(project, "Documents", "Agreements.v2", "contract.txt"), "utf8"), "Existing agreement");
  assert.equal(await readFile(path.join(project, "Documents", "Agreements.v2 (2)", "contract.txt"), "utf8"), "New agreement");
  const alreadyHere = await copyFilesIntoProject(project, [path.join(project, "Documents", "Agreements.v2")], undefined, "Documents");
  assert.equal(alreadyHere.files[0].status, "already_here");
});

test("a failed child is reported without stopping the remaining folder contents", async () => {
  const { root, project } = await fixture();
  const source = path.join(root, "Documents");
  await mkdir(source);
  await writeFile(path.join(source, "a.txt"), "Keep original");
  await writeFile(path.join(source, "b.txt"), "Copy this");
  const result = await copyFilesIntoProject(project, [source], async (...args) => {
    if (typeof args[0] === "string" && args[0].endsWith("a.txt")) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    return copyFile(...args);
  });
  assert.ok(result.files.some((file) => file.name === path.join("Documents", "a.txt") && file.status === "failed"));
  assert.equal(await readFile(path.join(source, "a.txt"), "utf8"), "Keep original");
  assert.equal(await readFile(path.join(project, "Documents", "b.txt"), "utf8"), "Copy this");
});
