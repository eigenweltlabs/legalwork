import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadOpencodeBinary, opencodeRelease, opencodeReleaseTarget } from "./opencode-release.mjs";
import { checkOpencodeRuntime } from "../scripts/check-opencode-runtime.mjs";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";
import { installSelectedOpencodeEngine, opencodeEngineSelection } from "@legalwork/opencode-release/selection";

test("released binary selection covers desktop targets and Linux libc variants", () => {
  for (const platform of ["darwin", "linux", "win32"]) for (const arch of ["arm64", "x64"]) {
    const target = opencodeReleaseTarget(platform, arch);
    assert.equal(opencodeRelease.packages[target].name, `@opencode/cli-${target}`);
    assert.ok(target.endsWith(arch === "x64" ? "x64-baseline" : "arm64"));
  }
  for (const arch of ["arm64", "x64"]) assert.ok(opencodeRelease.packages[opencodeReleaseTarget("linux", arch, "musl")]);
});

test("a corrupted offline archive never installs or bypasses pinned integrity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-corrupt-cache-"));
  const destination = path.join(root, "bin", "opencode"), target = opencodeReleaseTarget();
  let networkCalls = 0;
  try {
    await writeFile(path.join(root, `${target}-${opencodeRelease.version}.tgz`), "corrupted cached package");
    await assert.rejects(downloadOpencodeBinary({ destination, cacheDirectory: root, fetcher: async () => { networkCalls++; throw new Error("offline"); } }), /integrity verification failed/);
    await assert.rejects(stat(destination), { code: "ENOENT" });
    assert.equal(networkCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a different engine version cannot silently use the pinned release package", async () => {
  await assert.rejects(downloadOpencodeBinary({ destination: "unused", cacheDirectory: "unused", version: "2.1.5" }), /no reviewed release digests/);
});

test("the released binary loads a native directory plugin through the host runtime", { skip: !process.env.LEGALWORK_TEST_OPENCODE_BIN }, async () => {
  assert.deepEqual(await checkOpencodeRuntime(process.env.LEGALWORK_TEST_OPENCODE_BIN), {
    version: await expectedOpencodeVersion(process.env.LEGALWORK_TEST_OPENCODE_BIN), authenticated: true, nativePlugin: true, paidCalls: 0,
  });
});

test("the selected verified package installs offline without a package manager", { skip: !process.env.LEGALWORK_TEST_OPENCODE_CACHE }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-offline-package-"));
  try {
    await mkdir(root, { recursive: true });
    const result = await installSelectedOpencodeEngine({ directory: path.join(root, "engine"), cacheDirectory: process.env.LEGALWORK_TEST_OPENCODE_CACHE, fetcher: async () => { throw new Error("network must not be used"); } });
    assert.equal(result.version, opencodeEngineSelection.version);
    assert.ok((await stat(result.path)).size > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a packaged Electron production dependency resolves the shared downloader and pinned metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-shared-package-"));
  try {
    const desktop = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(desktop.dependencies["@legalwork/opencode-release"], "workspace:*");
    await mkdir(path.join(root, "electron"), { recursive: true });
    await cp(new URL("../../../packages/opencode-release", import.meta.url), path.join(root, "node_modules", "@legalwork", "opencode-release"), { recursive: true });
    await copyFile(fileURLToPath(new URL("./opencode-release.mjs", import.meta.url)), path.join(root, "electron", "opencode-release.mjs"));
    const packaged = await import(pathToFileURL(path.join(root, "electron", "opencode-release.mjs")).href);
    assert.equal(packaged.opencodeRelease.version, opencodeRelease.version);
    assert.equal(Object.keys(packaged.opencodeRelease.packages).length, 12);
    assert.equal(packaged.opencodeReleaseTarget(), opencodeReleaseTarget());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a compiled CLI embeds the shared digest manifest without requiring a source JSON file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-shared-compiled-"));
  try {
    const source = path.join(root, "entry.mjs"), binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
    const library = path.join(root, "source-library");
    await cp(new URL("../../../packages/opencode-release", import.meta.url), library, { recursive: true });
    await writeFile(source, `import {opencodeRelease,opencodeReleaseTarget} from ${JSON.stringify(path.join(library, "index.mjs"))};console.log(JSON.stringify({version:opencodeRelease.version,target:opencodeReleaseTarget(),count:Object.keys(opencodeRelease.packages).length}));`);
    const build = spawnSync("bun", ["build", source, "--compile", "--outfile", binary], { encoding: "utf8", cwd: root });
    assert.equal(build.status, 0, build.error?.message || build.stderr);
    await rm(source);
    await rm(library, { recursive: true });
    const result = spawnSync(binary, [], { encoding: "utf8", cwd: root });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: opencodeRelease.version, target: opencodeReleaseTarget(), count: 12 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
