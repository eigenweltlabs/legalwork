import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import recipe from "./build/recipe.json" with { type: "json" };
import { engineBuildMode, engineTargetsForBuild, prepareForBuild } from "./prepare.mjs";
import { opencodeReleaseTarget } from "./index.mjs";
import { sourceBuildPolicy } from "./build-policy.mjs";
import { validateSourceBuildRequest } from "./build/producer.mjs";
import { writeFixtureDerivativeDistribution, writeFixtureReleaseLibrary } from "./test-fixture.mjs";

async function fixture(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "legalwork-engine-entry-")));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const execute = (filename, args = [], options = {}) => spawnSync(process.execPath, [filename, ...args], { encoding: "utf8", ...options });
async function write(root, name, contents) {
  const filename = path.join(root, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
  return filename;
}

// The stub is only the build boundary; the CLI and desktop startup scripts are
// executed unchanged. No engine, account or provider is started by these tests.
async function cliFixture(root) {
  const directory = path.join(root, "packages/opencode-release");
  await mkdir(path.join(directory, "build"), { recursive: true });
  for (const name of ["prepare.mjs", "index.mjs", "release.json", "build-policy.mjs", "selection.json"]) await copyFile(new URL(name, import.meta.url), path.join(directory, name));
  await copyFile(new URL("build/recipe.json", import.meta.url), path.join(directory, "build/recipe.json"));
  await write(root, "packages/opencode-release/build/prepare.mjs", `
    export async function prepareOpencodeEngine(input) { console.log(JSON.stringify({operation:"prepare",input})); return input; }
    export async function checkPreparedOpencodeEngine(input) { throw new Error("missing or stale fixture preparation"); }
  `);
  return path.join(directory, "prepare.mjs");
}

test("build mode is explicit, validated, and cannot be specified twice", () => {
  assert.equal(engineBuildMode([]), "development");
  assert.equal(engineBuildMode(["--engine-mode=production"]), "production");
  assert.equal(engineBuildMode(["--engine-mode", "development"]), "development");
  for (const args of [["--engine-mode"], ["--engine-mode", "auto"], ["--engine-mode=production", "--engine-mode", "development"]]) {
    assert.throws(() => engineBuildMode(args), /explicit/);
  }
});

test("standalone cross-builds request corresponding reviewed engine artifacts", () => {
  assert.equal(engineTargetsForBuild([]), undefined);
  assert.deepEqual(engineTargetsForBuild(["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64-baseline-musl", "bun-windows-arm64"]),
    ["darwin-arm64", "darwin-x64-baseline", "linux-x64-baseline-musl", "windows-arm64"]);
  assert.deepEqual(engineTargetsForBuild(["bun-windows-x64", "bun-windows-x64-baseline"]), ["windows-x64-baseline"]);
  assert.throws(() => engineTargetsForBuild(["bun-darwin-arm64-musl"]), /No reviewed/);
  assert.throws(() => engineTargetsForBuild(["arbitrary-target"]), /No reviewed/);
});

test("development uses the host default and production requests the complete reviewed matrix", async () => {
  const calls = [];
  const implementation = { prepareOpencodeEngine: async input => calls.push(input) };
  await prepareForBuild({ mode: "development" }, implementation);
  await prepareForBuild({ mode: "production" }, implementation);
  assert.deepEqual(calls, [{ mode: "development" }, { mode: "production", targets: recipe.targets, macSigning: sourceBuildPolicy.productionMacSigner }]);
  for (const input of calls) validateSourceBuildRequest(input, "darwin-arm64");
});

test("an explicit signing configuration is preserved and rejected by the real policy validator when wrong", async () => {
  const incorrect = { ...sourceBuildPolicy.productionMacSigner, teamId: "WRONGTEAM1" };
  let observed;
  await assert.rejects(prepareForBuild({ mode: "production", macSigning: incorrect }, {
    prepareOpencodeEngine(input) {
      observed = input.macSigning;
      return validateSourceBuildRequest(input, "darwin-arm64");
    },
  }), /exact committed public certificate policy/);
  assert.equal(observed, incorrect);
  const correct = { ...sourceBuildPolicy.productionMacSigner, keychainPath: "/private/reviewed-fixture.keychain-db" };
  await prepareForBuild({ mode: "production", macSigning: correct }, {
    prepareOpencodeEngine(input) {
      assert.equal(input.macSigning, correct);
      return validateSourceBuildRequest(input, "darwin-arm64");
    },
  });
});

test("read-only starts call only check and preserve missing/stale errors", async () => {
  let compiled = false;
  await assert.rejects(prepareForBuild({ mode: "development", checkOnly: true }, {
    prepareOpencodeEngine: () => { compiled = true; },
    checkPreparedOpencodeEngine: () => { throw new Error("source key changed"); },
  }), /preparation check failed.*pnpm engine:prepare.*source key changed/);
  assert.equal(compiled, false);
});

test("the actual preparation CLI rejects malformed requests before reaching the producer", () => fixture(async root => {
  const cli = await cliFixture(root);
  for (const args of [[], ["--mode", "auto"], ["--mode", "development", "--mode", "production"],
    ["--mode", "development", "--target", "unknown"], ["--mode", "development", "--target"],
    ["--mode", "development", "--all-targets", "--target", recipe.targets[0]],
    ["--mode", "development", "--check", "--mac-signing-config", "unused"],
    ["--mode", "production", "--run", process.execPath], ["--mode", "development", "--dev-mode"],
    ["--mode", "development", "--run"]]) {
    const result = execute(cli, args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  }
}));

test("the actual preparation CLI keeps production intent and explicit signing input", () => fixture(async root => {
  const cli = await cliFixture(root);
  const config = await write(root, "signing-policy.json", JSON.stringify({ mode: "developer-id", teamId: "fixture-only" }));
  const result = execute(cli, ["--mode", "production", "--mac-signing-config", config]);
  assert.equal(result.status, 0, result.stderr);
  const firstLine = JSON.parse(result.stdout.split("\n")[0]);
  assert.deepEqual(firstLine, { operation: "prepare", input: {
    mode: "production", targets: recipe.targets, macSigning: { mode: "developer-id", teamId: "fixture-only" },
  } });
}));

test("the actual preparation CLI reports missing setup without invoking compilation", () => fixture(async root => {
  const cli = await cliFixture(root);
  const result = execute(cli, ["--mode", "development", "--check"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /pnpm engine:prepare.*missing or stale/);
}));

async function desktopFixture(root, preparation) {
  const desktop = path.join(root, "apps/desktop");
  await mkdir(path.join(desktop, "scripts"), { recursive: true });
  await mkdir(path.join(desktop, "electron"), { recursive: true });
  await copyFile(new URL("../../apps/desktop/scripts/prepare-sidecar.mjs", import.meta.url), path.join(desktop, "scripts/prepare-sidecar.mjs"));
  await copyFile(new URL("../../apps/desktop/scripts/electron-dev.mjs", import.meta.url), path.join(desktop, "scripts/electron-dev.mjs"));
  for (const name of ["prepare-node-runtime.mjs", "prepare-opencode-sdk.mjs"]) await write(root, `apps/desktop/scripts/${name}`, "// Resource preparation is independent of the engine-selection fixture.\n");
  await write(root, "apps/desktop/electron/opencode-release.mjs", "export const downloadOpencodeBinary=()=>{}; export const opencodeReleaseTarget=()=> 'darwin-arm64';");
  await write(root, "constants.json", JSON.stringify({ opencodeVersion: "2.1.4" }));
  await write(root, "packages/opencode-release/prepare.mjs", preparation);
  const marker = path.join(root, "prepared");
  await write(root, "node_modules/@legalwork/opencode-release/package.json", JSON.stringify({ type: "module", exports: { "./selection": "./selection.mjs" } }));
  await write(root, "node_modules/@legalwork/opencode-release/selection.mjs", `import{existsSync}from'node:fs';if(!existsSync(${JSON.stringify(marker)}))throw Error('SELECTION_LOADED_BEFORE_PREPARATION');throw Error('SELECTION_AFTER_PREPARATION');`);
  return { desktop, marker };
}

test("the real desktop sidecar entry prepares before importing fixed runtime selection", () => fixture(async root => {
  const { desktop, marker } = await desktopFixture(root, `import{writeFile}from'node:fs/promises';export const engineBuildMode=()=> 'development';export async function prepareForBuild(input){await writeFile(${JSON.stringify(path.join(root, "prepared"))},JSON.stringify(input));return {archiveDirectory:'fixture-only'};}`);
  const result = execute(path.join(desktop, "scripts/prepare-sidecar.mjs"), [], { env: { ...process.env, TARGET: "aarch64-apple-darwin" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SELECTION_AFTER_PREPARATION/);
  assert.doesNotMatch(result.stderr, /Error: SELECTION_LOADED_BEFORE_PREPARATION/);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { mode: "development", targets: ["darwin-arm64"] });
}));

test("a missing desktop preparation blocks selection and all sidecar work", () => fixture(async root => {
  const { desktop } = await desktopFixture(root, "export const engineBuildMode=()=> 'development';export async function prepareForBuild(){throw Error('MISSING_PREPARATION');}");
  const result = execute(path.join(desktop, "scripts/prepare-sidecar.mjs"), [], { env: { ...process.env, TARGET: "aarch64-apple-darwin" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MISSING_PREPARATION/);
  assert.doesNotMatch(result.stderr, /SELECTION_/);
  await assert.rejects(readFile(path.join(desktop, "resources/sidecars/opencode")), { code: "ENOENT" });
}));

test("the real shared-skip desktop entry checks preparation instead of compiling or launching", () => fixture(async root => {
  const { desktop, marker } = await desktopFixture(root, `import{writeFile}from'node:fs/promises';export async function prepareForBuild(input){await writeFile(${JSON.stringify(path.join(root, "prepared"))},JSON.stringify(input));throw Error('STALE_SKIP_PREPARATION');}`);
  const result = execute(path.join(desktop, "scripts/electron-dev.mjs"), [], { env: { ...process.env, LEGALWORK_ELECTRON_SKIP_SHARED_PREPARE: "1" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STALE_SKIP_PREPARATION/);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { mode: "development", checkOnly: true });
}));

test("frontend preview starts without importing engine preparation", () => fixture(async root => {
  const entry = await write(root, "scripts/dev.mjs", await readFile(new URL("../../scripts/dev.mjs", import.meta.url), "utf8"));
  await write(root, "apps/app/node_modules/vite/bin/vite.js", "console.log('FRONTEND_ONLY_STARTED');");
  await write(root, "packages/opencode-release/prepare.mjs", "throw Error('ENGINE_PREPARATION_IMPORTED');");
  const result = execute(entry, ["--host", "127.0.0.1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FRONTEND_ONLY_STARTED/);
}));

async function serverWrapperFixture(root, checkSource) {
  const entry = path.join(root, "apps/server/bin/legalwork-server.mjs");
  await mkdir(path.dirname(entry), { recursive: true });
  await copyFile(new URL("../../apps/server/bin/legalwork-server.mjs", import.meta.url), entry);
  await write(root, "apps/server/package.json", JSON.stringify({ type: "module" }));
  await write(root, "apps/server/src/cli.ts", "// Marks this as an ordinary source checkout.\n");
  await write(root, "apps/server/dist/cli.js", "console.log('NODE_SERVER_STARTED');\n");
  await write(root, "packages/opencode-release/prepare.mjs", checkSource);
  return entry;
}

test("the actual source server wrapper blocks stale setup before loading built JS", () => fixture(async root => {
  const entry = await serverWrapperFixture(root, "console.error('STALE_SERVER_SETUP');process.exitCode=1;");
  const result = execute(entry);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STALE_SERVER_SETUP/);
  assert.doesNotMatch(result.stdout, /NODE_SERVER_STARTED/);
}));

test("the actual source server wrapper uses check-only then the existing Node runtime", () => fixture(async root => {
  const entry = await serverWrapperFixture(root, `import{spawnSync}from'node:child_process';const args=process.argv.slice(2);if(JSON.stringify(args.slice(0,5))!==JSON.stringify(['--mode','development','--check','--with-engine-binary','--run']))throw Error('NOT_CHECK_ONLY');console.log('CHECK_ONLY_COMPLETE');process.exitCode=spawnSync(args[5],args.slice(6),{stdio:'inherit'}).status;`);
  const result = execute(entry, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CHECK_ONLY_COMPLETE\nNODE_SERVER_STARTED\n");
}));


async function realHandoffFixture(root) {
  const distributionRoot = path.join(root, "distribution"); await mkdir(distributionRoot);
  const distribution = await writeFixtureDerivativeDistribution(distributionRoot);
  const library = await writeFixtureReleaseLibrary(path.join(root, "library"), distribution.selection);
  await copyFile(new URL("prepare.mjs", import.meta.url), path.join(library, "prepare.mjs"));
  const prepared = { manifestSha256: distribution.selection.manifestSha256, archiveDirectory: distribution.archives, receiptPath: path.join(library, "generated/receipt.json"), sourceKey: "e".repeat(64) };
  await write(root, "library/build/prepare.mjs", `export async function prepareOpencodeEngine(){return ${JSON.stringify(prepared)}};export async function checkPreparedOpencodeEngine(){return ${JSON.stringify(prepared)}};`);
  return { distribution, cli: path.join(library, "prepare.mjs") };
}

test("the actual dev launcher delivers verified archives and a fully installed host binary", () => fixture(async root => {
  const { cli, distribution } = await realHandoffFixture(root);
  const target = opencodeReleaseTarget();
  const expected = await readFile(path.join(distribution.builds.find(build => build.target === target).directory, target.startsWith("windows-") ? "opencode.exe" : "opencode"), "utf8");
  const child = await write(root, "consume.mjs", `import assert from 'node:assert/strict';import{readFile,readdir}from'node:fs/promises';import path from'node:path';assert.equal(process.env.LEGALWORK_OPENCODE_ARCHIVES,${JSON.stringify(distribution.archives)});const binary=process.env.LEGALWORK_OPENCODE_BIN;assert.equal(await readFile(binary,'utf8'),${JSON.stringify(expected)});assert.equal((await readdir(path.dirname(binary))).length,5);console.log('VERIFIED_HOST_HANDOFF');`);
  const result = execute(cli, ["--mode", "development", "--check", "--with-engine-binary", "--run", process.execPath, child], { env: { ...process.env, LEGALWORK_OPENCODE_ARCHIVES: "/untrusted-old-location", LEGALWORK_OPENCODE_BIN: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "VERIFIED_HOST_HANDOFF\n");
}));

test("archive-only dev handoff leaves an explicit user binary unchanged and propagates child failure", () => fixture(async root => {
  const { cli, distribution } = await realHandoffFixture(root);
  const child = await write(root, "consume.mjs", `import assert from'node:assert/strict';assert.equal(process.env.LEGALWORK_OPENCODE_ARCHIVES,${JSON.stringify(distribution.archives)});assert.equal(process.env.LEGALWORK_OPENCODE_BIN,'existing-user-setting');assert.equal(process.env.LEGALWORK_DEV_MODE,'1');process.exitCode=23;`);
  const result = execute(cli, ["--mode", "development", "--dev-mode", "--run", process.execPath, child], { env: { ...process.env, LEGALWORK_OPENCODE_BIN: "existing-user-setting" } });
  assert.equal(result.status, 23, result.stderr);
}));

test("corrupt prepared archives stop dev launch before the child can run", () => fixture(async root => {
  const { cli, distribution } = await realHandoffFixture(root);
  await writeFile(path.join(distribution.archives, distribution.manifest.artifacts[opencodeReleaseTarget()].archive.filename), "corrupt archive");
  const child = await write(root, "consume.mjs", "console.log('MUST_NOT_RUN');");
  const result = execute(cli, ["--mode", "development", "--with-engine-binary", "--run", process.execPath, child]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive integrity/);
  assert.doesNotMatch(result.stdout, /MUST_NOT_RUN/);
}));


test("standalone staging keeps all five selected files under the full artifact identity", () => fixture(async root => {
  const { cli, distribution } = await realHandoffFixture(root);
  const driver = await write(root, "stage.mjs", `import{prepareForBuild,stagePreparedEngineBuild}from ${JSON.stringify("./library/prepare.mjs")};const prepared=await prepareForBuild({mode:'development'});console.log(JSON.stringify(await stagePreparedEngineBuild({prepared,outputDirectory:${JSON.stringify(path.join(root, "bundle"))}})));`);
  const result = execute(driver);
  assert.equal(result.status, 0, result.stderr);
  const [binary] = JSON.parse(result.stdout);
  assert.equal(path.dirname(path.dirname(path.dirname(binary))), path.join(root, "bundle/opencode-engine"));
  assert.equal(path.basename(path.dirname(path.dirname(binary))), distribution.selection.manifestSha256);
  assert.deepEqual((await readdir(path.dirname(binary))).sort(),
    ["LICENSE", "NOTICE", "SHA256SUMS", "provenance.json", opencodeReleaseTarget().startsWith("windows-") ? "opencode.exe" : "opencode"].sort());
  await writeFile(binary, "changed standalone binary");
  const corrupted = execute(driver);
  assert.notEqual(corrupted.status, 0);
  assert.match(corrupted.stderr, /Installed derivative file changed/);
}));


test("an explicit dev engine path wins only after exact selected-file verification", () => fixture(async root => {
  const { cli, distribution } = await realHandoffFixture(root);
  const build = distribution.builds.find(build => build.target === opencodeReleaseTarget());
  const binary = path.join(build.directory, opencodeReleaseTarget().startsWith("windows-") ? "opencode.exe" : "opencode");
  const child = await write(root, "consume-explicit.mjs", `import assert from'node:assert/strict';assert.equal(process.env.LEGALWORK_OPENCODE_BIN,${JSON.stringify(binary)});console.log('EXPLICIT_VERIFIED');`);
  const args = ["--mode", "development", "--with-engine-binary", "--run", process.execPath, child];
  const options = { env: { ...process.env, LEGALWORK_OPENCODE_BIN: binary } };
  const valid = execute(cli, args, options);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, "EXPLICIT_VERIFIED\n");
  await writeFile(binary, "changed explicit engine");
  const changed = execute(cli, args, options);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /Installed derivative file changed/);
  assert.doesNotMatch(changed.stdout, /EXPLICIT_VERIFIED/);
}));
