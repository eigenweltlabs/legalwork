import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { opencodeReleaseTarget } from "./index.mjs";
import { assembleDerivativeDistribution } from "./build/distribution.mjs";
import { writeFixtureDerivativeDistribution, writeFixtureReleaseLibrary } from "./test-fixture.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

test("same-version source generations install side by side without rewriting prior engine or cached archives", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "legalwork-engine-generations-")));
  try {
    const firstRoot = path.join(root, "first"), secondRoot = path.join(root, "second");
    await mkdir(firstRoot); await mkdir(secondRoot);
    const first = await writeFixtureDerivativeDistribution(firstRoot), second = await writeFixtureDerivativeDistribution(secondRoot);
    const target = opencodeReleaseTarget(), binary = target.startsWith("windows-") ? "opencode.exe" : "opencode";
    const changed = second.builds.find(build => build.target === target);
    const provenance = JSON.parse(await readFile(path.join(changed.directory, "provenance.json"), "utf8"));
    const bytes = Buffer.from(`SECOND GENERATION FIXTURE ONLY ${target}`);
    provenance.binary.sha256 = sha(bytes);
    const document = JSON.stringify(provenance) + "\n";
    await writeFile(path.join(changed.directory, binary), bytes);
    await writeFile(path.join(changed.directory, "provenance.json"), document);
    await writeFile(path.join(changed.directory, "SHA256SUMS"), `${sha(bytes)}  ${binary}\n${sha(document)}  provenance.json\n`);
    changed.provenanceSha256 = sha(document);
    const assembled = await assembleDerivativeDistribution({ builds: second.builds, outputDirectory: path.join(secondRoot, "new-archives"), manifestPath: path.join(secondRoot, "new-manifest.json"), onProgress: () => {} });
    const secondSelection = { ...second.selection, manifestSha256: assembled.manifestSha256, manifestContent: await readFile(assembled.manifestPath, "utf8") };
    assert.equal(first.selection.version, secondSelection.version);
    assert.notEqual(first.selection.manifestSha256, secondSelection.manifestSha256);
    const firstLibrary = await writeFixtureReleaseLibrary(path.join(root, "first-library"), first.selection);
    const secondLibrary = await writeFixtureReleaseLibrary(path.join(root, "second-library"), secondSelection);
    const installRoot = path.join(root, "installed"), cache = path.join(root, "cache");
    function install(library, archives) {
      const child = spawnSync(process.execPath, [path.join(library, "install.mjs"), "--install-root", installRoot, "--cache-directory", cache, "--archive-directory", archives], { encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    }
    const firstInstalled = install(firstLibrary, first.archives), originalBytes = await readFile(firstInstalled.path);
    const firstCachedArchive = path.join(cache, first.selection.manifestSha256, first.manifest.artifacts[target].archive.filename);
    const originalArchiveBytes = await readFile(firstCachedArchive);
    const secondInstalled = install(secondLibrary, assembled.archiveDirectory);
    assert.equal(firstInstalled.version, secondInstalled.version);
    assert.equal(firstInstalled.path, path.join(installRoot, first.selection.manifestSha256, target, binary));
    assert.equal(secondInstalled.path, path.join(installRoot, secondSelection.manifestSha256, target, binary));
    assert.deepEqual(await readFile(firstInstalled.path), originalBytes);
    assert.deepEqual(await readFile(firstCachedArchive), originalArchiveBytes);
    assert.deepEqual(await readFile(secondInstalled.path), bytes);
    assert.deepEqual(install(firstLibrary, first.archives), firstInstalled);
    assert.deepEqual(install(secondLibrary, assembled.archiveDirectory), secondInstalled);
    await writeFile(secondInstalled.path, "tampered latest generation");
    const corrupt = spawnSync(process.execPath, [path.join(secondLibrary, "install.mjs"), "--install-root", installRoot, "--cache-directory", cache], { encoding: "utf8" });
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /Installed derivative file changed/);
    assert.deepEqual(await readFile(firstInstalled.path), originalBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
