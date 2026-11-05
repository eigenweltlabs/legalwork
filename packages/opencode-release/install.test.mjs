import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { opencodeRelease, opencodeReleaseTarget } from "./index.mjs";
import { writeFixtureDerivativeDistribution, writeFixtureReleaseLibrary } from "./test-fixture.mjs";

test("the CI installer retains all selected files, exports its actual path, and reuses verified cache offline", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "selected-engine-install-")));
  try {
    const distributionRoot = path.join(root, "distribution"); await mkdir(distributionRoot);
    const distribution = await writeFixtureDerivativeDistribution(distributionRoot);
    const library = await writeFixtureReleaseLibrary(path.join(root, "library"), distribution.selection);
    const cache = path.join(root, "cache"), target = opencodeReleaseTarget();
    const environment = path.join(root, "github-env"), githubPath = path.join(root, "github-path");
    const args = [path.join(library, "install.mjs"), "--install-root", path.join(root, "installed"), "--cache-directory", cache, "--archive-directory", distribution.archives, "--github-actions"];
    const child = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, GITHUB_ENV: environment, GITHUB_PATH: githubPath } });
    assert.equal(child.status, 0, child.stderr);
    const installed = JSON.parse(child.stdout);
    assert.equal(installed.version, distribution.selection.version);
    assert.equal(installed.baseVersion, opencodeRelease.version);
    assert.equal(installed.kind, "derivative");
    const filename = target.startsWith("windows-") ? "opencode.exe" : "opencode";
    assert.equal(installed.path, path.join(root, "installed", distribution.selection.manifestSha256, target, filename));
    assert.deepEqual((await readdir(path.dirname(installed.path))).sort(), [filename, "LICENSE", "NOTICE", "provenance.json", "SHA256SUMS"].sort());
    assert.equal(await readFile(githubPath, "utf8"), `${path.dirname(installed.path)}\n`);
    assert.equal(await readFile(environment, "utf8"), `LEGALWORK_TEST_OPENCODE_BIN=${installed.path}\nLEGALWORK_TEST_OPENCODE_CACHE=${cache}\n`);
    await rm(distributionRoot, { recursive: true });
    const { installSelectedEngineForHost } = await import(pathToFileURL(path.join(library, "install.mjs")));
    const offline = await installSelectedEngineForHost({ installRoot: path.join(root, "offline"), cacheDirectory: cache, fetcher: () => { throw new Error("No network fallback"); } });
    assert.deepEqual(await readFile(offline.path), await readFile(installed.path));
    await writeFile(offline.path, "tampered");
    await assert.rejects(installSelectedEngineForHost({ installRoot: path.join(root, "offline"), cacheDirectory: cache }), /Installed derivative file changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unpublished selected derivative fails clearly without local archives or cache", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "unpublished-engine-install-")));
  try {
    const distributionRoot = path.join(root, "distribution"); await mkdir(distributionRoot);
    const distribution = await writeFixtureDerivativeDistribution(distributionRoot);
    const library = await writeFixtureReleaseLibrary(path.join(root, "library"), distribution.selection);
    const child = spawnSync(process.execPath, [path.join(library, "install.mjs"), "--install-root", path.join(root, "installed"), "--cache-directory", path.join(root, "empty-cache")], {
      encoding: "utf8", env: { ...process.env, LEGALWORK_OPENCODE_ARCHIVES: "" },
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Unpublished derivatives require their exact reviewed local archives or verified cache/);
    assert.match(child.stderr, /not cached/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source-built selectors reject a runtime download URL before installation", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "downloaded-engine-install-")));
  try {
    const distributionRoot = path.join(root, "distribution"); await mkdir(distributionRoot);
    const distribution = await writeFixtureDerivativeDistribution(distributionRoot);
    const selection = { ...distribution.selection, downloadBaseUrl: "https://downloads.invalid/engine/" };
    const library = await writeFixtureReleaseLibrary(path.join(root, "library"), selection);
    await assert.rejects(import(pathToFileURL(path.join(library, "install.mjs"))), /runtime download URL is not permitted/);
    await assert.rejects(readdir(path.join(root, "installed")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an explicit official selector rejects corrupt archive bytes without a network fallback", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "official-engine-install-")));
  try {
    const library = await writeFixtureReleaseLibrary(path.join(root, "library"));
    const cache = path.join(root, "cache"); await mkdir(cache);
    await writeFile(path.join(cache, `${opencodeReleaseTarget()}-${opencodeRelease.version}.tgz`), "corrupt official bytes");
    const { installSelectedEngineForHost } = await import(pathToFileURL(path.join(library, "install.mjs")));
    await assert.rejects(installSelectedEngineForHost({ installRoot: path.join(root, "installed"), cacheDirectory: cache, fetcher: () => { throw new Error("No network fallback"); } }), /integrity verification failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
