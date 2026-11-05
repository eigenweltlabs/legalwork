import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import release from "./release.json" with { type: "json" };
import recipe from "./build/recipe.json" with { type: "json" };
import { expectedOpencodeVersion } from "./candidate.mjs";
import { opencodeReleaseTarget } from "./index.mjs";
import { derivativeFileSha256, downloadDerivativeArchive, installLocalDerivativeEngine, verifyDerivativeDistribution, verifyDerivativeDistributionContent, verifyInstalledDerivativeEngine } from "./derivative.mjs";
import { assembleDerivativeDistribution, writeCandidateArchive } from "./build/distribution.mjs";
import { writeFixtureReleaseLibrary } from "./test-fixture.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const target = "darwin-arm64";

test("an existing installation cannot redirect verification through a directory symlink", async () => {
  await fixture(async ({ root, archives, cache, distribution }) => {
    const destination = path.join(root, "installed"), redirected = path.join(root, "redirected");
    await installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: redirected, target });
    await symlink(redirected, destination, "dir");
    await assert.rejects(installLocalDerivativeEngine({ distribution, cacheDirectory: cache, destinationDirectory: destination, target }), /ordinary directory/);
    assert.equal((await stat(redirected)).isDirectory(), true);
  });
});

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-derivative-distribution-")), builds = [];
  try {
    for (const current of recipe.targets) {
      const directory = path.join(root, current); await mkdir(directory);
      const name = current.startsWith("windows-") ? "opencode.exe" : "opencode", binary = Buffer.from(`TEST FIXTURE ONLY ${current}`);
      const provenance = { ...recipe, target: current, officialBase: release.packages[current], sourceDateEpoch: "1770000000",
        compiler: { version: recipe.toolchain.bun, sha256: recipe.toolchain.executables["darwin-arm64"].sha256 },
        binary: { filename: name, sha256: sha(binary), signing: "test-fixture-only" } };
      const bytes = `${JSON.stringify(provenance)}\n`;
      await writeFile(path.join(directory, name), binary);
      await writeFile(path.join(directory, "provenance.json"), bytes);
      await writeFile(path.join(directory, "LICENSE"), "MIT test fixture");
      await writeFile(path.join(directory, "NOTICE"), "Not a real executable or distribution");
      await writeFile(path.join(directory, "SHA256SUMS"), `${sha(binary)}  ${name}\n${sha(bytes)}  provenance.json\n`);
      builds.push({ target: current, directory, provenanceSha256: sha(bytes) });
    }
    const manifestPath = path.join(root, "derivative.json"), archives = path.join(root, "archives"), cache = path.join(root, "cache");
    const assembled = await assembleDerivativeDistribution({ builds, outputDirectory: archives, manifestPath, onProgress: () => {} });
    const distribution = await verifyDerivativeDistribution({ manifestPath, manifestSha256: assembled.manifestSha256 });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await run({ root, builds, manifestPath, archives, cache, distribution, manifest });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("all twelve reviewed targets assemble deterministic archives and retain official defaults", async () => {
  await fixture(async ({ root, builds, archives, manifest, distribution }) => {
    assert.equal(distribution.targets.length, 12);
    assert.equal(distribution.baseVersion, "2.1.4");
    assert.equal(distribution.version, recipe.version);
    const build = builds.find(build => build.target === target), pin = manifest.artifacts[target];
    const second = path.join(root, "second.tar.gz");
    await writeCandidateArchive({ directory: build.directory, filenames: Object.keys(pin.files), destination: second, epoch: 1770000000 });
    assert.equal(await derivativeFileSha256(second), await derivativeFileSha256(path.join(archives, pin.archive.filename)));
    const result = await installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: path.join(root, "cache"), destinationDirectory: path.join(root, "installed"), target });
    const officialLibrary = await writeFixtureReleaseLibrary(path.join(root, "official-host"));
    const officialHost = await import(pathToFileURL(path.join(officialLibrary, "candidate.mjs")));
    assert.equal(await officialHost.expectedOpencodeVersion(result.candidateBuild.path), release.version);
    assert.equal(await expectedOpencodeVersion(result.candidateBuild.path, result.candidateBuild), recipe.version);
  });
});

test("verified cache supports offline installation and concurrent immutable publication", async () => {
  await fixture(async ({ root, archives, cache, distribution }) => {
    const install = destinationDirectory => installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory, target });
    const first = path.join(root, "one"), second = path.join(root, "two");
    const results = await Promise.all([install(first), install(second)]);
    assert.equal(results[0].candidateBuild.sha256, results[1].candidateBuild.sha256);
    await rm(archives, { recursive: true });
    const offline = await installLocalDerivativeEngine({ distribution, cacheDirectory: cache, destinationDirectory: path.join(root, "offline"), target });
    assert.equal(offline.candidateBuild.sha256, results[0].candidateBuild.sha256);
    assert.equal((await installLocalDerivativeEngine({ distribution, cacheDirectory: cache, destinationDirectory: first, target })).reused, true);
  });
});

test("a streamed download must match the compiled archive pin before offline installation", async () => {
  await fixture(async ({ root, archives, cache, distribution, manifest }) => {
    const artifact = manifest.artifacts[target];
    const bytes = await readFile(path.join(archives, artifact.archive.filename));
    let requests = 0;
    const fetcher = async url => {
      requests++;
      assert.equal(String(url), `https://downloads.invalid/engine/${artifact.archive.filename}`);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, 13));
        controller.enqueue(bytes.subarray(13));
        controller.close();
      } }));
    };
    await downloadDerivativeArchive({ distribution, cacheDirectory: cache, downloadBaseUrl: "https://downloads.invalid/engine/", target, fetcher });
    await rm(archives, { recursive: true });
    const installed = await installLocalDerivativeEngine({ distribution, cacheDirectory: cache, destinationDirectory: path.join(root, "downloaded"), target });
    assert.equal(installed.candidateBuild.version, recipe.version);
    await downloadDerivativeArchive({ distribution, cacheDirectory: cache, downloadBaseUrl: "https://downloads.invalid/engine/", target, fetcher });
    assert.equal(requests, 1);
    const cached = path.join(cache, distribution.manifestSha256, artifact.archive.filename);
    await writeFile(cached, "corrupt existing cache");
    await assert.rejects(downloadDerivativeArchive({ distribution, cacheDirectory: cache, downloadBaseUrl: "https://downloads.invalid/engine/", target, fetcher }), /integrity/);
    assert.equal(requests, 1);
  });
});

test("wrong or interrupted downloads never publish an executable archive", async () => {
  await fixture(async ({ cache, distribution }) => {
    const base = { distribution, cacheDirectory: cache, downloadBaseUrl: "https://downloads.invalid/engine/", target };
    await assert.rejects(downloadDerivativeArchive({ ...base, fetcher: async () => new Response("unreviewed bytes") }), /integrity/);
    assert.deepEqual(await readdir(path.join(cache, distribution.manifestSha256)), []);
    await assert.rejects(downloadDerivativeArchive({ ...base, fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection interrupted")); } })) }), /connection interrupted/);
    assert.deepEqual(await readdir(path.join(cache, distribution.manifestSha256)), []);
    await assert.rejects(downloadDerivativeArchive({ ...base, downloadBaseUrl: "http://downloads.invalid/engine/" }), /plain HTTPS/);
  });
});

test("a separate host process reconstructs trust from the pinned manifest and every installed file", async () => {
  await fixture(async ({ root, archives, cache, distribution, manifestPath }) => {
    const directory = path.join(root, "installed");
    const { candidateBuild } = await installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: directory, target });
    const moduleUrl = new URL("./derivative.mjs", import.meta.url).href;
    const candidateUrl = new URL("./candidate.mjs", import.meta.url).href;
    const script = `import{verifyDerivativeDistribution,verifyInstalledDerivativeEngine}from${JSON.stringify(moduleUrl)};import{expectedOpencodeVersion}from${JSON.stringify(candidateUrl)};const distribution=await verifyDerivativeDistribution(${JSON.stringify({ manifestPath, manifestSha256: distribution.manifestSha256 })});const candidate=await verifyInstalledDerivativeEngine({distribution,directory:${JSON.stringify(directory)},target:${JSON.stringify(target)}});console.log(JSON.stringify({version:await expectedOpencodeVersion(candidate.path,candidate),sha256:candidate.sha256}));`;
    const run = () => spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { version: recipe.version, sha256: candidateBuild.sha256 });
    await writeFile(path.join(directory, "NOTICE"), "changed license notice");
    const changed = run();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Installed derivative file changed: NOTICE/);
    await assert.rejects(verifyInstalledDerivativeEngine({ distribution: Object.freeze({ ...distribution }), directory, target }), /unknown derivative/);
  });
});

test("embedded manifests survive removal of source metadata and reject changed content", async () => {
  await fixture(async ({ root, archives, cache, distribution, manifestPath }) => {
    const manifestContent = await readFile(manifestPath, "utf8"), manifestSha256 = distribution.manifestSha256;
    const embedded = await verifyDerivativeDistributionContent({ manifestContent, manifestSha256 });
    await rm(manifestPath);
    const installed = await installLocalDerivativeEngine({ distribution: embedded, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "embedded"), target });
    assert.equal(await expectedOpencodeVersion(installed.candidateBuild.path, installed.candidateBuild), recipe.version);
    await assert.rejects(verifyDerivativeDistributionContent({ manifestContent: manifestContent + " ", manifestSha256 }), /independent build pin/);
  });
});

test("container staging copies all five pinned guest files and rejects partial or changed artifacts", async () => {
  await fixture(async ({ root, builds, manifestPath, distribution }) => {
    const library = path.join(root, "staging-release-library");
    await writeFixtureReleaseLibrary(library, { schemaVersion: 1, kind: "derivative", version: recipe.version, baseVersion: release.version,
      manifestContent: await readFile(manifestPath, "utf8"), manifestSha256: distribution.manifestSha256 });
    const { stageSelectedOpencodeEngine } = await import(pathToFileURL(path.join(library, "selection.mjs")));
    const guestTarget = "linux-x64-baseline";
    const source = builds.find(build => build.target === guestTarget);
    const binary = path.join(source.directory, "opencode");
    const directory = path.join(root, "mount", "opencode-engine", recipe.version, guestTarget);
    const staged = await stageSelectedOpencodeEngine({ binary, directory, target: guestTarget });
    assert.equal(staged, path.join(directory, "opencode"));
    assert.deepEqual((await readdir(directory)).sort(), ["LICENSE", "NOTICE", "SHA256SUMS", "opencode", "provenance.json"].sort());
    for (const name of await readdir(directory)) assert.deepEqual(await readFile(path.join(directory, name)), await readFile(path.join(source.directory, name)));
    assert.equal(await stageSelectedOpencodeEngine({ binary, directory, target: guestTarget }), staged);
    await assert.rejects(stageSelectedOpencodeEngine({ binary, directory: `${directory}-wrong`, target: "darwin-arm64" }), /file changed|target\/version\/channel/);
    await rm(path.join(directory, "NOTICE"));
    await assert.rejects(stageSelectedOpencodeEngine({ binary, directory, target: guestTarget }), /missing or unexpected/);
    await writeFile(path.join(directory, "NOTICE"), "changed notice");
    await assert.rejects(stageSelectedOpencodeEngine({ binary, directory, target: guestTarget }), /file changed/);
    await writeFile(binary, "changed source");
    await assert.rejects(stageSelectedOpencodeEngine({ binary, directory: `${directory}-new`, target: guestTarget }), /file changed/);
    await assert.rejects(stat(`${directory}-new`), { code: "ENOENT" });
  });
});

test("normal host selection independently verifies its compiled manifest without a validation preload", async () => {
  await fixture(async ({ root, archives, cache, distribution, manifestPath }) => {
    const currentTarget = opencodeReleaseTarget();
    const installed = await installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "engine"), target: currentTarget });
    const library = path.join(root, "host-release-library");
    await writeFixtureReleaseLibrary(library, { schemaVersion: 1, kind: "derivative", version: recipe.version, baseVersion: release.version,
      manifestContent: await readFile(manifestPath, "utf8"), manifestSha256: distribution.manifestSha256 });
    await rm(manifestPath);
    const entry = path.join(library, "host.mjs");
    await writeFile(entry, `import{expectedOpencodeVersion,expectedOpencodeServiceFilename}from'./candidate.mjs';const binary=${JSON.stringify(installed.candidateBuild.path)};console.log(JSON.stringify({version:await expectedOpencodeVersion(binary),service:await expectedOpencodeServiceFilename(binary)}));`);
    const valid = spawnSync(process.execPath, [entry], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { version: recipe.version, service: "service-legalwork.json" });
    const compiled = path.join(root, process.platform === "win32" ? "compiled-host.exe" : "compiled-host");
    const build = spawnSync("bun", ["build", "--compile", entry, "--outfile", compiled], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    await rm(library, { recursive: true });
    const compiledValid = spawnSync(compiled, [], { encoding: "utf8" });
    assert.equal(compiledValid.status, 0, compiledValid.stderr);
    assert.deepEqual(JSON.parse(compiledValid.stdout), { version: recipe.version, service: "service-legalwork.json" });
    await writeFile(installed.candidateBuild.path, "tampered selected executable");
    const changed = spawnSync(compiled, [], { encoding: "utf8" });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Installed derivative file changed/);
  });
});

test("independent manifest pin, complete target matrix and opaque host capability are mandatory", async () => {
  await fixture(async ({ root, archives, cache, manifestPath, distribution, manifest }) => {
    await assert.rejects(verifyDerivativeDistribution({ manifestPath, manifestSha256: "0".repeat(64) }), /reviewed digest/);
    await assert.rejects(installLocalDerivativeEngine({ distribution: Object.freeze({ ...distribution }), archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "forged"), target }), /unknown derivative/);
    delete manifest.artifacts["windows-arm64"];
    const bytes = JSON.stringify(manifest); await writeFile(manifestPath, bytes);
    await assert.rejects(verifyDerivativeDistribution({ manifestPath, manifestSha256: sha(bytes) }), /all twelve/);
    await assert.rejects(installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "changed"), target }), /manifest changed/);
  });
});

test("corrupt cached bytes fail explicitly even when the original archive remains available", async () => {
  await fixture(async ({ root, archives, cache, distribution, manifest }) => {
    await installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "initial"), target });
    const cached = path.join(cache, distribution.manifestSha256, manifest.artifacts[target].archive.filename), bytes = await readFile(cached);
    bytes[0] ^= 1; await writeFile(cached, bytes);
    await assert.rejects(installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "corrupt"), target }), /archive integrity/);
    assert.deepEqual(await readFile(cached), bytes);
    await assert.rejects(stat(path.join(root, "corrupt")), { code: "ENOENT" });
  });
});

test("changed installed binaries and unrelated destination files are never overwritten", async () => {
  await fixture(async ({ root, archives, cache, distribution }) => {
    const destinationDirectory = path.join(root, "installed");
    await installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory, target });
    const binary = path.join(destinationDirectory, "opencode"); await writeFile(binary, "changed");
    await assert.rejects(installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory, target }), /Installed derivative file changed/);
    assert.equal(await readFile(binary, "utf8"), "changed");
    const unrelated = path.join(root, "unrelated"); await mkdir(unrelated); await writeFile(path.join(unrelated, "matter.txt"), "preserved");
    await assert.rejects(installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: unrelated, target }), /unexpected files/);
    assert.equal(await readFile(path.join(unrelated, "matter.txt"), "utf8"), "preserved");
  });
});

test("even digest-pinned archives cannot extract unexpected members", async () => {
  await fixture(async ({ root, builds, archives, cache, distribution, manifest, manifestPath }) => {
    const build = builds.find(build => build.target === target), pin = manifest.artifacts[target], archive = path.join(archives, pin.archive.filename);
    await rm(archive); await writeFile(path.join(build.directory, "extra.txt"), "must not extract");
    await writeCandidateArchive({ directory: build.directory, filenames: [...Object.keys(pin.files), "extra.txt"], destination: archive, epoch: 1770000000 });
    pin.archive.sha256 = await derivativeFileSha256(archive); pin.archive.size = (await stat(archive)).size;
    const bytes = JSON.stringify(manifest); await writeFile(manifestPath, bytes);
    const reviewed = await verifyDerivativeDistribution({ manifestPath, manifestSha256: sha(bytes) });
    await assert.rejects(installLocalDerivativeEngine({ distribution: reviewed, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "unexpected"), target }), /unexpected, duplicate or unsafe paths/);
    await assert.rejects(stat(path.join(root, "unexpected")), { code: "ENOENT" });
  });
});

test("local archive symlinks and unresolved offline inputs are rejected", async () => {
  await fixture(async ({ root, archives, cache, distribution, manifest }) => {
    const archive = path.join(archives, manifest.artifacts[target].archive.filename), original = path.join(root, "elsewhere.tar.gz");
    await rename(archive, original); await symlink(original, archive);
    await assert.rejects(installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "symlink"), target }), /ordinary files/);
    await assert.rejects(installLocalDerivativeEngine({ distribution, cacheDirectory: cache, destinationDirectory: path.join(root, "offline-missing"), target }), /not cached/);
    await assert.rejects(installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "unknown"), target: "__proto__" }), /Unsupported derivative target/);
  });
});

test("archive member symlinks are rejected without touching their outside target", async () => {
  await fixture(async ({ root, builds, archives, cache, manifest, manifestPath }) => {
    const build = builds.find(build => build.target === target), pin = manifest.artifacts[target], binary = path.join(build.directory, "opencode");
    const outside = path.join(root, "outside.txt"); await writeFile(outside, "preserved outside");
    await rm(binary); await symlink(outside, binary);
    const archive = path.join(archives, pin.archive.filename); await rm(archive);
    const packed = spawnSync("tar", ["-czf", archive, "-C", build.directory, ...Object.keys(pin.files)], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    pin.archive.sha256 = await derivativeFileSha256(archive); pin.archive.size = (await stat(archive)).size;
    const bytes = JSON.stringify(manifest); await writeFile(manifestPath, bytes);
    const reviewed = await verifyDerivativeDistribution({ manifestPath, manifestSha256: sha(bytes) });
    await assert.rejects(installLocalDerivativeEngine({ distribution: reviewed, archiveDirectory: archives, cacheDirectory: cache, destinationDirectory: path.join(root, "linked-member"), target }), /ordinary files/);
    assert.equal(await readFile(outside, "utf8"), "preserved outside");
  });
});

test("an explicit development scope installs only its reviewed targets without weakening complete distributions", async () => {
  await fixture(async ({ root, builds }) => {
    const manifestPath = path.join(root, "host-only.json"), archives = path.join(root, "host-only-archives");
    const assembled = await assembleDerivativeDistribution({ builds: builds.filter(build => build.target === target),
      developmentTargets: [target], outputDirectory: archives, manifestPath, onProgress: () => {} });
    const distribution = await verifyDerivativeDistribution({ manifestPath, manifestSha256: assembled.manifestSha256 });
    assert.deepEqual(distribution.targets, [target]);
    assert.equal(distribution.scope, "development");
    const installed = await installLocalDerivativeEngine({ distribution, archiveDirectory: archives, cacheDirectory: path.join(root, "host-cache"),
      destinationDirectory: path.join(root, "host-installed"), target });
    assert.equal(installed.candidateBuild.version, recipe.version);
    await assert.rejects(installLocalDerivativeEngine({ distribution, cacheDirectory: path.join(root, "host-cache"),
      destinationDirectory: path.join(root, "wrong-host"), target: "windows-arm64" }), /Unsupported derivative target/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const verify = value => {
      const manifestContent = JSON.stringify(value);
      return verifyDerivativeDistributionContent({ manifestContent, manifestSha256: sha(manifestContent) });
    };
    await assert.rejects(verify({ ...manifest, schemaVersion: 1, scope: undefined }), /all twelve/);
    await assert.rejects(verify({ ...manifest, scope: { kind: "production", targets: [target] } }), /development distribution/);
    await assert.rejects(verify({ ...manifest, scope: { kind: "development", targets: [target, target] } }), /unique reviewed/);
    await assert.rejects(verify({ ...manifest, scope: { kind: "development", targets: ["unreviewed-target"] } }), /unique reviewed/);
    await assert.rejects(verify({ ...manifest, scope: { kind: "development", targets: [target, "windows-arm64"] } }), /exactly its declared/);
    await assert.rejects(assembleDerivativeDistribution({ builds, developmentTargets: [target], outputDirectory: path.join(root, "unexpected-all"),
      manifestPath: path.join(root, "unexpected-all.json") }), /exactly one reviewed build/);
  });
});
