import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as util from "../scripts/_util.mjs";
import { opencodeReleaseTarget } from "../../../packages/opencode-release/index.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-e2e-path-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("reviewed CI executable wins over the legacy explicit override", async () => {
  assert.equal(await util.resolveOpencodeBinary({ env: { LEGALWORK_TEST_OPENCODE_BIN: process.execPath, OPENCODE_BIN: "/missing-legacy-override" } }), realpathSync(process.execPath));
});

test("legacy explicit executable remains supported without a CI override", async () => {
  assert.equal(await util.resolveOpencodeBinary({ env: { OPENCODE_BIN: process.execPath } }), realpathSync(process.execPath));
});

test("default derivative paths preserve all six desktop target layouts", async t => {
  const resourcesDirectory = await fixture(t);
  const selection = { kind: "derivative", version: "2.1.4-legalwork.http-policy.3", artifactId: "a".repeat(64) };
  for (const [platform, arch, target, filename] of [
    ["darwin", "arm64", "darwin-arm64", "opencode"],
    ["darwin", "x64", "darwin-x64-baseline", "opencode"],
    ["linux", "arm64", "linux-arm64", "opencode"],
    ["linux", "x64", "linux-x64-baseline", "opencode"],
    ["win32", "arm64", "windows-arm64", "opencode.exe"],
    ["win32", "x64", "windows-x64-baseline", "opencode.exe"],
  ]) {
    const file = path.join(resourcesDirectory, "opencode-engine", selection.artifactId, target, filename);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "path-selection-fixture", { mode: 0o700 });
    assert.equal(await util.resolveOpencodeBinary({ env: {}, resourcesDirectory, selection, platform, arch }), realpathSync(file));
  }
});

test("same-version local generations select their exact manifest and never an old version folder", async t => {
  const resourcesDirectory = await fixture(t), target = opencodeReleaseTarget();
  const filename = process.platform === "win32" ? "opencode.exe" : "opencode";
  const first = { kind: "derivative", version: "2.1.4-legalwork.http-policy.3", artifactId: "a".repeat(64) };
  const second = { ...first, artifactId: "b".repeat(64) };
  const old = path.join(resourcesDirectory, "opencode-engine", first.version, target, filename);
  await mkdir(path.dirname(old), { recursive: true }); await writeFile(old, "stale version alias", { mode: 0o700 });
  await assert.rejects(util.resolveOpencodeBinary({ env: {}, resourcesDirectory, selection: first }), /unavailable/);
  for (const selection of [first, second]) {
    const file = path.join(resourcesDirectory, "opencode-engine", selection.artifactId, target, filename);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, selection.artifactId, { mode: 0o700 });
    assert.equal(await util.resolveOpencodeBinary({ env: {}, resourcesDirectory, selection }), realpathSync(file));
  }
});

test("official local default keeps the ordinary sidecar layout", async t => {
  const resourcesDirectory = await fixture(t);
  const file = path.join(resourcesDirectory, "sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");
  await mkdir(path.dirname(file));
  await writeFile(file, "path-selection-fixture", { mode: 0o700 });
  assert.equal(await util.resolveOpencodeBinary({ env: {}, resourcesDirectory, selection: { kind: "official", version: "2.1.4" } }), realpathSync(file));
});

test("invalid explicit CI candidate fails instead of falling back", async t => {
  const root = await fixture(t);
  const missing = path.join(root, "missing-reviewed-engine");
  await assert.rejects(util.resolveOpencodeBinary({ env: { LEGALWORK_TEST_OPENCODE_BIN: missing, OPENCODE_BIN: process.execPath } }), error => error.message.includes(missing) && error.cause?.code === "ENOENT");
  await assert.rejects(util.spawnOpencodeServe({ directory: root, port: 12345, env: { LEGALWORK_TEST_OPENCODE_BIN: missing, OPENCODE_BIN: process.execPath } }), error => error.message.includes(missing) && error.cause?.code === "ENOENT");
});

test("directory and empty overrides cannot become executable fallbacks", async t => {
  const root = await fixture(t);
  await assert.rejects(util.resolveOpencodeBinary({ env: { LEGALWORK_TEST_OPENCODE_BIN: root } }), /regular executable file/);
  await assert.rejects(util.resolveOpencodeBinary({ env: { LEGALWORK_TEST_OPENCODE_BIN: "", OPENCODE_BIN: process.execPath } }), /nonempty path/);
});

test("an actual exec failure reports its executable and original spawn cause", async t => {
  const root = await fixture(t);
  const executable = path.join(root, process.platform === "win32" ? "invalid.exe" : "missing-interpreter");
  await writeFile(executable, process.platform === "win32" ? "not a Windows executable" : "#!/definitely-missing-legalwork-test-interpreter\n", { mode: 0o700 });
  let unexpectedServer;
  try {
    await assert.rejects(util.spawnOpencodeServe({ directory: root, port: 12345, env: { LEGALWORK_TEST_OPENCODE_BIN: executable } }).then(server => { unexpectedServer = server; return server; }), error => error.message.includes("Cannot start OpenCode") && error.message.includes(executable) && error.cause instanceof Error);
  } finally {
    await unexpectedServer?.close();
  }
});
