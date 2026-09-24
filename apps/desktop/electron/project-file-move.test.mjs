import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { moveFilesIntoProject, resolveProjectFolder } from "./project-file-move.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-move-"));
  roots.push(root);
  const project = path.join(root, "Project");
  await mkdir(project);
  const source = path.join(root, "Agreement (DE).txt");
  await writeFile(source, "Original contract – unchanged");
  return { root, project, source };
}
const crossDevice = async () => { throw Object.assign(new Error("Cross-device link"), { code: "EXDEV" }); };

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
    assert.equal((await moveFilesIntoProject(resolved, [source])).files[0].status, "moved");
    await assert.rejects(resolveProjectFolder("unknown-project", [], info), /Local project not found/);
    await assert.rejects(resolveProjectFolder("remote-project", [], info), /Local project not found/);
    await assert.rejects(resolveProjectFolder("new-project", [{ id: "new-project", name: "Remote", preset: "starter", workspaceType: "remote", path: project }], info), /Local project not found/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("moves original bytes without replacing collisions and deduplicates a drop", async () => {
  const { project, source } = await fixture();
  await writeFile(path.join(project, path.basename(source)), "Existing contract");
  const result = await moveFilesIntoProject(project, [source, source]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].status, "moved");
  assert.equal(result.files[0].path, "Agreement (DE) (2).txt");
  assert.equal(await readFile(path.join(project, result.files[0].path), "utf8"), "Original contract – unchanged");
  assert.equal(await readFile(path.join(project, path.basename(source)), "utf8"), "Existing contract");
  await assert.rejects(stat(source), { code: "ENOENT" });
});

test("cross-volume fallback finishes copying before removing the source", async () => {
  const { project, source } = await fixture();
  const before = await stat(source);
  const result = await moveFilesIntoProject(project, [source], crossDevice);
  assert.equal(result.files[0].status, "moved");
  const moved = path.join(project, path.basename(source));
  assert.equal(await readFile(moved, "utf8"), "Original contract – unchanged");
  assert.ok(Math.abs((await stat(moved)).mtimeMs - before.mtimeMs) < 2);
  await assert.rejects(stat(source), { code: "ENOENT" });
});

test("failed copy preserves the source", async () => {
  const { project, source } = await fixture();
  const result = await moveFilesIntoProject(project, [source], async () => {
    await rm(project, { recursive: true });
    return crossDevice();
  });
  assert.equal(result.files[0].status, "failed");
  assert.equal(await readFile(source, "utf8"), "Original contract – unchanged");
});

test("files already in the project stay put and unavailable sources do not stop other files", async () => {
  const { root, project, source } = await fixture();
  const existing = path.join(project, "Existing.md");
  await writeFile(existing, "Keep me");
  const result = await moveFilesIntoProject(project, [existing, path.join(root, "missing"), source]);
  assert.deepEqual(result.files.map((file) => file.status), ["already_here", "failed", "moved"]);
  assert.equal(await readFile(existing, "utf8"), "Keep me");
});

test("folders and symlinks are rejected without moving their contents", async () => {
  const { root, project, source } = await fixture();
  const alias = path.join(root, "alias.txt");
  await symlink(source, alias);
  const result = await moveFilesIntoProject(project, [root, alias]);
  assert.deepEqual(result.files.map((file) => file.error), ["file_only", "file_only"]);
  assert.deepEqual(await readdir(project), []);
  assert.equal(await readFile(source, "utf8"), "Original contract – unchanged");
});
