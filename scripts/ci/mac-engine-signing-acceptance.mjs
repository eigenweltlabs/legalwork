// Manual CI acceptance only: no release API, default selector or signing-secret access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, chmod, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyReviewedPatch, assertBuildReady, buildCandidate, verifyCompiler, verifyInputs } from "../../packages/opencode-release/build/candidate.mjs";
import { verifyOpencodeCandidate } from "../../packages/opencode-release/candidate.mjs";
import { developerIdRequirement, macEntitlementsSha256 } from "../../packages/opencode-release/build/mac-signing.mjs";

export const macSigningIdentity = Object.freeze({ mode: "developer-id", identitySha1: "5eccdbc844b673d12b8528f6b8ea5f41f6d4e4a6", certificateSha256: "dec87895435a1392571678dfd71a8ebeea873a7e3602b372de65dd217a79a228", teamId: "9VTQ834B95" });
export const macTargets = ["darwin-arm64", "darwin-x64", "darwin-x64-baseline"];
const files = ["LICENSE", "NOTICE", "SHA256SUMS", "opencode", "provenance.json"];
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
async function digest(file) { const value = createHash("sha256"); for await (const bytes of createReadStream(file)) value.update(bytes); return value.digest("hex"); }
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd ?? repository, env: options.env ?? process.env, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  let stdout = "", stderr = "";
  child.stdout?.on("data", bytes => { stdout += bytes; }); child.stderr?.on("data", bytes => { stderr += bytes; });
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
  if (options.evidence) await writeFile(options.evidence, JSON.stringify({ command, args, ...result }, null, 2) + "\n");
  if (result.code !== 0 && !options.allowFailure) throw new Error(`${path.basename(command)} failed (${result.signal ?? result.code}). See retained CI evidence.`);
  return result;
}
async function identityProbe(signingConfig, root) {
  const signing = JSON.parse(await readFile(signingConfig, "utf8"));
  assert.deepEqual({ ...signing, keychainPath: undefined }, { ...macSigningIdentity, keychainPath: undefined });
  assert(path.isAbsolute(signing.keychainPath)); await mkdir(root);
  const binary = path.join(root, "owned-true"); await copyFile("/usr/bin/true", binary); await chmod(binary, 0o755);
  const minimal = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  minimal.LANG = "en_US.UTF-8"; minimal.LC_ALL = "en_US.UTF-8";
  const results = {};
  for (const [name, env] of [["minimal", minimal], ["parent", process.env]]) {
    for (const [label, args] of [["search-list", ["list-keychains", "-d", "user"]], ["identity", ["find-identity", "-v", "-p", "codesigning", signing.keychainPath]]])
      await run("/usr/bin/security", args, { env, capture: true, allowFailure: true, evidence: path.join(root, `${name}-${label}.json`) });
    results[name] = await run("/usr/bin/codesign", ["--dryrun", "--force", "--sign", signing.identitySha1, "--options", "runtime", "--timestamp", "--keychain", signing.keychainPath, binary],
      { env, capture: true, allowFailure: true, evidence: path.join(root, `${name}-codesign.json`) });
  }
  await writeFile(path.join(root, "summary.json"), JSON.stringify({ kind: "public-signing-context-diagnostic", minimalCode: results.minimal.code, parentCode: results.parent.code, noEnvironmentValuesRecorded: true }, null, 2) + "\n");
  assert.equal(results.minimal.code, 0, "The exact build helper signing context must pass before compilation; inspect public identity-probe evidence.");
  assert.equal(results.parent.code, 0, "The ordinary CI signing context must pass before compilation.");
}
export function parseKeychainSearchList(text) {
  return text.split("\n").filter(line => line.trim()).map(line => {
    const value = JSON.parse(line.trim());
    assert(typeof value === "string" && path.isAbsolute(value) && !/[\0\r\n]/.test(value), "Invalid native keychain search-list path");
    return value;
  });
}
async function keychainList(keychain, evidence, register) {
  assert(path.isAbsolute(keychain));
  const query = async () => parseKeychainSearchList((await run("/usr/bin/security", ["list-keychains", "-d", "user"], { capture: true })).stdout);
  const before = await query();
  if (register) {
    assert(!before.includes(keychain), "Only a new CI-owned keychain may be registered");
    // codesign requires search-list membership even with its exact --keychain.
    await run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...before, keychain]);
    const after = await query(); assert.deepEqual(after, [...before, keychain]);
    await writeFile(evidence, JSON.stringify({ before, after, ownedKeychain: keychain }, null, 2) + "\n", { flag: "wx" });
  } else {
    // security delete-keychain removes only the owned entry; never restore an
    // old array over unrelated entries another normal build tool may have added.
    assert(!before.includes(keychain), "Owned signing keychain remained registered after deletion");
    await writeFile(evidence, JSON.stringify({ afterCleanup: before, ownedKeychainAbsent: true }, null, 2) + "\n", { flag: "wx" });
  }
}
export function validateMacAcceptanceManifest(manifest, recipeSha256) {
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, "signed-mac-engine-acceptance-not-adopted");
  assert.equal(manifest.recipeSha256, recipeSha256); assert.deepEqual(manifest.signer, macSigningIdentity);
  assert.deepEqual(manifest.builds.map(build => build.target).sort(), [...macTargets].sort());
  assert.equal(manifest.archive.filename, "engines.tgz"); assert.match(manifest.archive.sha256, /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(manifest.archive.bytes) && manifest.archive.bytes > 0);
  for (const build of manifest.builds) {
    assert.equal(build.directory, `build-${build.target}/artifact`); assert.match(build.provenanceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(build.files).sort(), files);
    for (const [name, value] of Object.entries(build.files)) {
      assert.match(value.sha256, /^[a-f0-9]{64}$/); assert(Number.isSafeInteger(value.bytes) && value.bytes > 0);
      assert(Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777);
      if (name === "opencode") assert.equal(value.mode, 0o755);
    }
  }
}
async function build(root, signingConfig) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The recipe permits only its pinned macOS ARM64 compiler.");
  const signing = JSON.parse(await readFile(signingConfig, "utf8"));
  assert.deepEqual({ ...signing, keychainPath: undefined }, { ...macSigningIdentity, keychainPath: undefined });
  assert(path.isAbsolute(signing.keychainPath));
  const recipeBytes = await readFile(path.join(repository, "packages/opencode-release/build/recipe.json")), recipe = JSON.parse(recipeBytes);
  await verifyInputs(recipe); assertBuildReady(recipe); await mkdir(root);
  const compiler = recipe.toolchain.executables["darwin-arm64"], response = await fetch(compiler.tarball);
  if (!response.ok) throw new Error(`Pinned compiler download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, compiler.integrity);
  await writeFile(path.join(root, "compiler.tgz"), bytes, { flag: "wx" }); await mkdir(path.join(root, "compiler"));
  await run("tar", ["-xzf", path.join(root, "compiler.tgz"), "-C", path.join(root, "compiler")]);
  const bun = path.join(root, "compiler/package/bin/bun"); verifyCompiler(recipe, await readFile(bun)); await chmod(bun, 0o755);
  const prepared = path.join(root, "upstream");
  await run("git", ["clone", "--depth=1", "--branch", recipe.upstream.tag, recipe.upstream.repository, prepared]);
  await applyReviewedPatch(prepared, path.join(repository, recipe.inputs.patch.path));
  await run(bun, ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts", "--os=*", "--cpu=*", "--libc=*"], { cwd: prepared });
  const builds = []; let first;
  for (const target of macTargets) {
    const output = path.join(root, `build-${target}`);
    const built = await buildCandidate({ output, bun, target, preparedSource: prepared, macSigning: signing,
      ...(first ? { reuseArtifact: first.artifact, reuseProvenanceSha256: first.provenanceSha256 } : {}) });
    first ??= built;
    const inventory = {};
    assert.deepEqual((await readdir(built.artifact)).sort(), files);
    for (const name of files) { const file = path.join(built.artifact, name), stat = await lstat(file); assert(stat.isFile() && stat.nlink === 1); inventory[name] = { bytes: stat.size, mode: stat.mode & 0o777, sha256: await digest(file) }; }
    builds.push({ target, directory: `build-${target}/artifact`, provenanceSha256: built.provenanceSha256, files: inventory });
    await writeFile(path.join(output, "result.json"), JSON.stringify(built, null, 2) + "\n");
    // Same bounded duplicate-output cleanup as the existing producer. Artifacts,
    // signing evidence and the sole independent source/dependency staging remain.
    await rm(path.join(output, "compiled"), { recursive: true });
    if (built !== first) await rm(path.join(output, "source-review"), { recursive: true });
  }
  const bundle = path.join(root, "bundle"); await mkdir(bundle);
  const archive = path.join(bundle, "engines.tgz");
  await run("tar", ["-czf", archive, "-C", root, ...builds.map(value => value.directory)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const manifest = { schemaVersion: 1, kind: "signed-mac-engine-acceptance-not-adopted", recipeSha256: hash(recipeBytes), signer: macSigningIdentity,
    builds, archive: { filename: "engines.tgz", bytes: (await lstat(archive)).size, sha256: await digest(archive) } };
  validateMacAcceptanceManifest(manifest, hash(recipeBytes));
  const document = JSON.stringify(manifest, null, 2) + "\n"; await writeFile(path.join(bundle, "manifest.json"), document);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `manifest-sha256=${hash(document)}\n`);
}
async function verifySignature(binary, target, evidence) {
  await mkdir(evidence, { recursive: true }); let sequence = 0;
  const tool = (command, args) => run(command, args, { capture: true, evidence: path.join(evidence, `${sequence++}.json`) });
  const architecture = await tool("/usr/bin/lipo", ["-archs", binary]); assert.equal(architecture.stdout.trim(), target === "darwin-arm64" ? "arm64" : "x86_64");
  await tool("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "-R", `=${developerIdRequirement(macSigningIdentity.teamId)}`, binary]);
  const metadata = await tool("/usr/bin/codesign", ["--display", "--verbose=4", binary]);
  const details = metadata.stdout + "\n" + metadata.stderr;
  assert.match(details, /^Authority=Developer ID Application:/m); assert.match(details, /^TeamIdentifier=9VTQ834B95$/m);
  assert.match(details, /^Timestamp=(?!none$|not set$).+/m);
  const flags = details.match(/^CodeDirectory .*\bflags=0x([a-fA-F0-9]+)/m); assert(flags && (parseInt(flags[1], 16) & 0x10000));
  const prefix = path.join(evidence, "public-certificate-"); await tool("/usr/bin/codesign", ["--display", `--extract-certificates=${prefix}`, binary]);
  const certificate = await readFile(`${prefix}0`); assert.equal(hash(certificate), macSigningIdentity.certificateSha256); assert.equal(hash(certificate, "sha1"), macSigningIdentity.identitySha1);
  const extracted = await tool("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", binary]);
  const plist = path.join(evidence, "entitlements.plist"); await writeFile(plist, extracted.stdout);
  const actual = await tool("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
  const source = path.join(repository, "packages/opencode-release/build/macos-entitlements.plist"); assert.equal(await digest(source), macEntitlementsSha256);
  const expected = await tool("/usr/bin/plutil", ["-convert", "json", "-o", "-", source]); assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(expected.stdout));
}
async function runtime(bundle, expectedManifestSha256, root, selectedTargets) {
  if (process.platform !== "darwin") throw new Error("Native Mac acceptance must execute on macOS.");
  const document = await readFile(path.join(bundle, "manifest.json")); assert.equal(hash(document), expectedManifestSha256);
  const manifest = JSON.parse(document), recipeSha256 = await digest(path.join(repository, "packages/opencode-release/build/recipe.json")); validateMacAcceptanceManifest(manifest, recipeSha256);
  const archive = path.join(bundle, manifest.archive.filename); assert.equal((await lstat(archive)).size, manifest.archive.bytes); assert.equal(await digest(archive), manifest.archive.sha256);
  await mkdir(root); await run("tar", ["-xzf", archive, "-C", root]);
  await mkdir(path.join(root, "verification")); await writeFile(path.join(root, "verification/manifest.json"), document);
  for (const build of manifest.builds) {
    const directory = path.join(root, build.directory); assert.deepEqual((await readdir(directory)).sort(), files);
    for (const name of files) { const file = path.join(directory, name), stat = await lstat(file), expected = build.files[name]; assert(stat.isFile() && stat.nlink === 1); assert.equal(stat.mode & 0o777, expected.mode); assert.equal(stat.size, expected.bytes); assert.equal(await digest(file), expected.sha256); }
    await verifyOpencodeCandidate({ directory, provenanceSha256: build.provenanceSha256 });
    const evidence = path.join(root, "verification", build.target);
    await verifySignature(path.join(directory, "opencode"), build.target, evidence);
    await writeFile(path.join(evidence, "provenance.json"), await readFile(path.join(directory, "provenance.json")));
  }
  const targets = selectedTargets.split(","); assert.deepEqual(targets, process.arch === "arm64" ? ["darwin-arm64"] : ["darwin-x64", "darwin-x64-baseline"]);
  for (const target of targets) {
    const build = manifest.builds.find(value => value.target === target), directory = path.join(root, build.directory), evidence = path.join(root, "runtime", target); await mkdir(evidence, { recursive: true });
    // Separate native suites avoid shared test-runner state across engine owners.
    for (const file of ["managed-opencode.released.test.ts", "opencode-plugins/native-codemode-host.integration.test.ts", "opencode-mac-signing.released.test.ts"]) {
      console.log(`Signed ${target}: ${file}`);
      await run("bun", ["test", "--preload", "./apps/server/test-preload.ts", "--preload", "./packages/opencode-release/build/validation-preload.mjs", `apps/server/src/${file}`],
      { capture: true, evidence: path.join(evidence, `${path.basename(file)}.log.json`),
        env: { ...process.env, LEGALWORK_TEST_OPENCODE_BIN: path.join(directory, "opencode"), LEGALWORK_TEST_CANDIDATE_DIRECTORY: directory,
          LEGALWORK_TEST_CANDIDATE_PROVENANCE_SHA256: build.provenanceSha256, LEGALWORK_MAC_SIGNED_ACCEPTANCE_DIR: evidence } });
    }
    await verifyOpencodeCandidate({ directory, provenanceSha256: build.provenanceSha256 });
  }
  await writeFile(path.join(root, "verification/receipt.json"), JSON.stringify({ manifestSha256: expectedManifestSha256, archive: manifest.archive,
    signer: macSigningIdentity, allThreeSignaturesVerified: true, nativeTargetsExecuted: targets, finalBytesReverified: true, adopted: false }, null, 2) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "policy" && args.length === 2) { assert(path.isAbsolute(args[0])); await writeFile(args[1], JSON.stringify({ ...macSigningIdentity, keychainPath: args[0] }) + "\n", { flag: "wx", mode: 0o600 }); }
  else if (["keychain-register", "keychain-removed"].includes(command) && args.length === 2) await keychainList(args[0], args[1], command === "keychain-register");
  else if (command === "identity-probe" && args.length === 2) await identityProbe(args[0], path.resolve(args[1]));
  else if (command === "build" && args.length === 2) await build(path.resolve(args[0]), args[1]);
  else if (command === "runtime" && args.length === 4) await runtime(path.resolve(args[0]), args[1], path.resolve(args[2]), args[3]);
  else throw new Error("Use policy <keychain> <new-public-config>, identity-probe <public-config> <new-root>, build <new-root> <public-config>, or runtime <bundle> <independent-manifest-SHA> <new-root> <native-targets>.");
}
