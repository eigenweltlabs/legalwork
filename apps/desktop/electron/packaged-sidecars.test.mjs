import assert from "node:assert/strict";
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { opencodeReleaseTarget } from "@legalwork/opencode-release";
import { officialFixtureSelection, writeFixtureDerivativeDistribution, writeFixtureReleaseLibrary } from "../../../packages/opencode-release/test-fixture.mjs";

const require = createRequire(import.meta.url);
const { Arch } = require("electron-builder");
const matrix = [
  ["darwin", "arm64", "aarch64-apple-darwin"],
  ["darwin", "x64", "x86_64-apple-darwin"],
  ["linux", "arm64", "aarch64-unknown-linux-gnu"],
  ["linux", "x64", "x86_64-unknown-linux-gnu"],
  ["win32", "arm64", "aarch64-pc-windows-msvc"],
  ["win32", "x64", "x86_64-pc-windows-msvc"],
];

async function fixture(platform, arch, kind, run) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-packaged-sidecars-"));
  const resources = platform === "darwin" ? join(root, "LegalWork.app", "Contents", "Resources") : join(root, "resources");
  const modules = join(resources, "app.asar.unpacked", "node_modules");
  try {
    let selection = officialFixtureSelection, engineDirectory;
    if (kind === "derivative") {
      const distributionRoot = join(root, "distribution"); await mkdir(distributionRoot);
      const distribution = await writeFixtureDerivativeDistribution(distributionRoot);
      selection = distribution.selection;
      const target = opencodeReleaseTarget(platform, arch);
      engineDirectory = join(resources, "opencode-engine", selection.manifestSha256, target);
      await cp(distribution.builds.find(build => build.target === target).directory, engineDirectory, { recursive: true });
      await mkdir(join(resources, "opencode-engine", selection.manifestSha256, "stale-target"));
      await mkdir(join(resources, "opencode-engine", "stale-version"));
    }
    await writeFixtureReleaseLibrary(join(root, "node_modules", "@legalwork", "opencode-release"), selection);
    await symlink(dirname(require.resolve("electron-builder/package.json")), join(root, "node_modules", "electron-builder"), "junction");
    await mkdir(join(root, "scripts"));
    for (const name of ["electron-after-pack.cjs", "packaged-ocr.cjs", "packaged-opencode-sdk.cjs"]) {
      await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, "scripts", name));
    }
    const afterPack = require(join(root, "scripts", "electron-after-pack.cjs"));
    for (const name of ["onnxruntime-node", "onnxruntime-common", "@napi-rs/canvas", "paddleocr", "image-size"]) {
      const directory = join(modules, name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name, main: "index.cjs" }));
      await writeFile(join(directory, "index.cjs"), "// Resolve-only packaging fixture; no native runtime execution.\n");
    }
    const binding = join(modules, "onnxruntime-node", "bin", "napi-v6", platform, arch);
    await mkdir(binding, { recursive: true });
    await writeFile(join(binding, "onnxruntime_binding.node"), "fixture");
    for (const directory of ["ocr", "node", "opencode-sdk", "sidecars"]) await mkdir(join(resources, directory), { recursive: true });
    for (const name of ["native-worker.cjs", "layout-worker.cjs"]) await writeFile(join(resources, "ocr", name), "fixture");
    await writeFile(join(resources, "node", platform === "win32" ? "node.exe" : "node"), "fixture");
    await writeFile(join(resources, "opencode-sdk", "package.json"), JSON.stringify({ opencode: { version: "2.1.4", runtime: "released-cli", providedModules: ["@opencode/plugin", "effect"] } }));
    await run({ resources, engineDirectory, selection, afterPack, context: { appOutDir: root, electronPlatformName: platform, packager: { appInfo: { productFilename: "LegalWork" } } } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const kind of ["official", "derivative"]) test(`normal afterPack preserves the explicit ${kind} selector across all desktop architectures`, async () => {
  for (const [platform, arch, triple] of matrix) for (const architecture of [arch, Arch[arch]]) {
    await fixture(platform, arch, kind, async ({ resources, engineDirectory, selection, afterPack, context }) => {
      const directory = join(resources, "sidecars"), suffix = platform === "win32" ? ".exe" : "";
      const bases = kind === "official" ? ["opencode", "legalwork-orchestrator"] : ["legalwork-orchestrator"];
      const expected = [];
      for (const base of ["opencode", "legalwork-orchestrator"]) {
        const target = `${base}-${triple}${suffix}`, alias = `${base}${suffix}`;
        await writeFile(join(directory, target), target);
        await writeFile(join(directory, alias), "stale alias");
        if (bases.includes(base)) expected.push(target, alias);
      }
      const metadata = `versions.json-${triple}${suffix}`;
      await writeFile(join(directory, metadata), JSON.stringify({ target: triple }));
      await writeFile(join(directory, "wrong-architecture-binary"), "must be pruned");
      await writeFile(join(directory, `legalwork-server${suffix}`), "retired");
      const pinned = engineDirectory && await readFile(join(engineDirectory, `opencode${suffix}`));
      await afterPack({ ...context, arch: architecture });
      assert.deepEqual((await readdir(directory)).sort(), [...expected, metadata, "versions.json"].sort(), `${platform}/${architecture}`);
      for (const base of bases) assert.equal(await readFile(join(directory, `${base}${suffix}`), "utf8"), `${base}-${triple}${suffix}`);
      assert.deepEqual(JSON.parse(await readFile(join(directory, "versions.json"), "utf8")), { target: triple });
      if (engineDirectory) {
        assert.deepEqual(await readFile(join(engineDirectory, `opencode${suffix}`)), pinned);
        assert.deepEqual((await readdir(engineDirectory)).sort(), ["LICENSE", "NOTICE", "SHA256SUMS", `opencode${suffix}`, "provenance.json"].sort());
        assert.deepEqual(await readdir(join(resources, "opencode-engine")), [selection.manifestSha256]);
        assert.deepEqual(await readdir(join(resources, "opencode-engine", selection.manifestSha256)), [opencodeReleaseTarget(platform, arch)]);
      }
    });
  }
});

for (const kind of ["official", "derivative"]) test(`${kind} afterPack rejects a missing exact-target engine instead of retaining a stale alias`, async () => {
  await fixture("linux", "x64", kind, async ({ resources, engineDirectory, afterPack, context }) => {
    await writeFile(join(resources, "sidecars", "opencode"), "stale wrong-target alias");
    if (engineDirectory) await rm(engineDirectory, { recursive: true });
    await assert.rejects(afterPack({ ...context, arch: Arch.x64 }), kind === "official" ? /Missing packaged sidecar for target: opencode-x86_64-unknown-linux-gnu/ : /ENOENT/);
  });
});
