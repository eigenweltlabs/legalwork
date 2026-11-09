import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { pruneOcrRuntime } = require("../scripts/packaged-ocr.cjs");
const { assertWindowsVcRuntime, extractWindowsVcRuntime, prepareWindowsVcRuntime } = require("../scripts/windows-vc-runtime.cjs");
const { zipSync } = require("fflate");
const defaults = require("../build/windows-vc-runtime.json");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function vcFixture(arch) {
  const files = Object.fromEntries(Object.keys(defaults.targets[arch].files).map(name => [name, Buffer.from(`${arch}:${name}`)]));
  const archive = zipSync(Object.fromEntries([
    ...Object.entries(files).map(([name, bytes]) => [`Contents/VC/Redist/MSVC/${defaults.directoryVersion}/${arch}/Microsoft.VC143.CRT/${name}`, bytes]),
    ["../escape.dll", Buffer.from("must never be extracted")],
    ["Contents/VC/Redist/debug_nonredist/debug.dll", Buffer.from("must never be shipped")],
  ]));
  const pin = { ...defaults, targets: { [arch]: { url: `https://example.invalid/${arch}.vsix`, sha256: sha256(archive), files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])) } } };
  return { files, archive, pin };
}

test("packaged OCR retains only its target runtime and fails if required payload is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocr-package-"));
  try {
    for (const platform of ["darwin", "win32", "linux"]) for (const arch of ["arm64", "x64"]) {
      const resources = path.join(root, platform, arch), modules = path.join(resources, "app.asar.unpacked/node_modules");
      for (const name of ["onnxruntime-node", "onnxruntime-common", "@napi-rs/canvas", "paddleocr", "image-size"]) {
        const dir = path.join(modules, name); await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
        await writeFile(path.join(dir, "index.js"), "");
      }
      const bin = path.join(modules, "onnxruntime-node/bin/napi-v6");
      for (const os of ["darwin", "win32", "linux"]) for (const cpu of ["arm64", "x64"]) {
        await mkdir(path.join(bin, os, cpu), { recursive: true });
        await writeFile(path.join(bin, os, cpu, "onnxruntime_binding.node"), "fixture");
      }
      await mkdir(path.join(resources, "ocr")); await writeFile(path.join(resources, "ocr/native-worker.cjs"), "");
      await writeFile(path.join(resources, "ocr/layout-worker.cjs"), "");
      await writeFile(path.join(resources, "ocr/llama-launcher.cjs"), "");
      const { files, pin } = vcFixture(arch);
      const prune = (target = arch) => pruneOcrRuntime(resources, platform, target, pin);
      if (platform === "win32") {
        assert.throws(() => prune(), /Missing or invalid Windows/);
        for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(bin, platform, arch, name), bytes);
      }
      prune();
      assert.deepEqual(await readdir(bin), [platform]);
      assert.deepEqual(await readdir(path.join(bin, platform)), [arch]);
      assert.throws(() => prune("missing"), /Missing OCR runtime|Unsupported Windows/);
      await rm(path.join(resources, "ocr/layout-worker.cjs"));
      assert.throws(() => prune(), /Missing bundled layout worker/);
      await writeFile(path.join(resources, "ocr/layout-worker.cjs"), "");
      await rm(path.join(resources, "ocr/native-worker.cjs"));
      assert.throws(() => prune(), /Missing bundled OCR worker/);
      await writeFile(path.join(resources, "ocr/native-worker.cjs"), "");
      await rm(path.join(resources, "ocr/llama-launcher.cjs"));
      assert.throws(() => prune(), /Missing bundled quality OCR launcher/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const arch of ["x64", "arm64"]) test(`Windows ${arch} CRT rejects corrupted archives and incomplete members`, () => {
  const { archive, files, pin } = vcFixture(arch);
  const extracted = extractWindowsVcRuntime(archive, arch, pin);
  assert.deepEqual(Object.keys(extracted).sort(), Object.keys(files).sort());
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(Buffer.from(extracted[name]), bytes);
  assert.throws(() => extractWindowsVcRuntime(Buffer.from("corrupt"), arch, pin), /archive checksum mismatch/);
  const missing = zipSync({ "unrelated.dll": Buffer.from("wrong archive") });
  assert.throws(() => extractWindowsVcRuntime(missing, arch, { ...pin, targets: { [arch]: { ...pin.targets[arch], sha256: sha256(missing) } } }), /archive member/);
  const changed = structuredClone(pin);
  changed.targets[arch].files["msvcp140.dll"] = "0".repeat(64);
  assert.throws(() => extractWindowsVcRuntime(archive, arch, changed), /archive member/);
  assert.throws(() => extractWindowsVcRuntime(archive, "x86", pin), /Unsupported Windows/);
});

test("Windows CRT preparation reuses verified files and repairs a stale architecture cache", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-vc-runtime-"));
  try {
    const x64 = vcFixture("x64"), arm64 = vcFixture("arm64");
    const pin = { ...defaults, targets: { ...x64.pin.targets, ...arm64.pin.targets } };
    let requests = 0;
    t.mock.method(globalThis, "fetch", async url => {
      requests++;
      return new Response(url.endsWith("x64.vsix") ? x64.archive : arm64.archive);
    });
    await prepareWindowsVcRuntime(root, "x64", pin);
    await prepareWindowsVcRuntime(root, "x64", pin);
    assert.equal(requests, 1, "A verified cache needs no network");
    assertWindowsVcRuntime(root, "x64", pin);
    await writeFile(path.join(root, "msvcp140.dll"), "damaged");
    assert.throws(() => assertWindowsVcRuntime(root, "x64", pin), /Missing or invalid/);
    await prepareWindowsVcRuntime(root, "x64", pin);
    assert.equal(requests, 2);
    await prepareWindowsVcRuntime(root, "arm64", pin);
    assert.equal(requests, 3);
    assertWindowsVcRuntime(root, "arm64", pin);
    assert.throws(() => assertWindowsVcRuntime(root, "x64", pin), /Missing or invalid/);
    assert.deepEqual((await readdir(root)).sort(), Object.keys(arm64.files).sort());
    assert.deepEqual(await readFile(path.join(root, "msvcp140.dll")), arm64.files["msvcp140.dll"]);
    t.mock.method(globalThis, "fetch", async () => new Response("offline", { status: 503 }));
    await assert.rejects(prepareWindowsVcRuntime(root, "x64", pin), /HTTP 503/);
    assertWindowsVcRuntime(root, "arm64", pin);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows builder rules copy only the target CRT beside the native addon", async () => {
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const { FileMatcher, copyFiles } = libRequire("app-builder-lib/out/fileMatcher.js");
  const config = require("yaml").parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const rule = config.win.extraResources.find(entry => entry.from === "resources/node");
  assert.ok(rule, "Windows must copy the prepared runtime DLLs");
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-crt-copy-"));
  try {
    for (const arch of ["x64", "arm64"]) {
      const { files, pin } = vcFixture(arch);
      const source = path.join(root, arch, "source"), resources = path.join(root, arch, "resources");
      await mkdir(source, { recursive: true });
      for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(source, name), bytes);
      for (const name of ["node.exe", "unrelated.dll", "debug.dll"]) await writeFile(path.join(source, name), "exclude");
      await copyFiles([new FileMatcher(source, path.join(resources, rule.to), value => value.replaceAll("${arch}", arch), rule.filter)]);
      const target = path.join(resources, "app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32", arch);
      assertWindowsVcRuntime(target, arch, pin);
      assert.deepEqual((await readdir(target)).sort(), Object.keys(files).sort());
      await rm(path.join(target, "msvcp140.dll"));
      assert.throws(() => assertWindowsVcRuntime(target, arch, pin), /Missing or invalid/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
