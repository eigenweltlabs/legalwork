import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertOcrProjectIsolation, ocrDevEnvironment } from "./dev-electron-ocr.mjs";

test("OCR rejects imported projects even when the Electron profile is separate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocr-isolation-"));
  try {
    const env = ocrDevEnvironment({ LEGALWORK_OCR_DEV_ROOT: root });
    await mkdir(path.dirname(env.LEGALWORK_SERVER_CONFIG), { recursive: true });
    await writeFile(env.LEGALWORK_SERVER_CONFIG, JSON.stringify({ workspaces: [{ path: path.join(root, "pricing-project") }] }));
    await assert.rejects(assertOcrProjectIsolation(env), /outside its isolated project folder/);
    await writeFile(env.LEGALWORK_SERVER_CONFIG, JSON.stringify({ workspaces: [{ path: path.join(env.LEGALWORK_PROJECT_DATA_DIR, "fixture"), contentPath: path.join(env.LEGALWORK_PROJECT_DATA_DIR, "fixture/files") }] }));
    await assertOcrProjectIsolation(env);
    await writeFile(path.join(env.LEGALWORK_ELECTRON_USERDATA, "legalwork-workspaces.json"), JSON.stringify({ workspaces: [{ path: path.join(root, "pricing-project") }] }));
    await assert.rejects(assertOcrProjectIsolation(env), /outside its isolated project folder/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OCR rejects a project symlink pointing into another dev instance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocr-isolation-link-"));
  try {
    const env = ocrDevEnvironment({ LEGALWORK_OCR_DEV_ROOT: root });
    const foreign = path.join(root, "pricing-project"), linked = path.join(env.LEGALWORK_PROJECT_DATA_DIR, "fixture");
    await mkdir(foreign);
    await mkdir(env.LEGALWORK_PROJECT_DATA_DIR);
    await symlink(foreign, linked, process.platform === "win32" ? "junction" : "dir");
    await mkdir(path.dirname(env.LEGALWORK_SERVER_CONFIG), { recursive: true });
    await writeFile(env.LEGALWORK_SERVER_CONFIG, JSON.stringify({ workspaces: [{ path: linked }] }));
    await assert.rejects(assertOcrProjectIsolation(env), /outside its isolated project folder/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OCR does not inherit another dev instance's runtime or account paths", () => {
  const env = ocrDevEnvironment({ LEGALWORK_OCR_DEV_ROOT: "/ocr", LEGALWORK_ELECTRON_USERDATA: "/pricing", LEGALWORK_RUNTIME_DB: "/pricing/runtime.sqlite", LEGALWORK_DATA_DIR: "/pricing/data", LEGALWORK_WORKSPACES: "/pricing/project", OPENCODE_DB: "/pricing/engine.db" });
  assert.equal(env.LEGALWORK_ELECTRON_USERDATA, path.resolve("/ocr/isolated-electron"));
  assert.equal(env.LEGALWORK_DATA_DIR, path.resolve("/ocr/orchestrator"));
  assert.equal(env.LEGALWORK_RUNTIME_DB, path.join(env.LEGALWORK_ENGINE_STORAGE_DIR, "runtime.sqlite"));
  assert.equal(env.OPENCODE_DB, undefined);
  assert.equal(env.LEGALWORK_WORKSPACES, undefined);
});
