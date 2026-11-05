import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageOpencodeSdk } from "../scripts/prepare-opencode-sdk.mjs";
import { parse } from "yaml";
import { assertPackagedOpencodeSdk } from "../scripts/packaged-opencode-sdk.cjs";

test("Electron Builder ships the v2 host-runtime declaration without a foreign SDK tree", async () => {
  const require = createRequire(import.meta.url);
  const { getFileMatchers, copyFiles } = createRequire(require.resolve("electron-builder"))("app-builder-lib/out/fileMatcher.js");
  const config = parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "opencode-sdk-package-"));
  try {
    const desktop = join(root, "desktop"), resources = join(root, "packaged", "resources");
    const source = join(root, "source"), sdk = join(desktop, "resources", "opencode-sdk");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "@opencode/plugin", version: "2.1.4" }));
    await stageOpencodeSdk({ sourcePackage: source, destination: sdk, expectedVersion: "2.1.4" });
    const matchers = getFileMatchers({ extraResources: config.extraResources.filter((entry) => entry.from.startsWith("resources/opencode-sdk")) }, "extraResources", resources, {
      defaultSrc: desktop, globalOutDir: join(root, "packaged"), customBuildOptions: {}, macroExpander: (value) => value,
    });
    await copyFiles(matchers);
    assert.equal(assertPackagedOpencodeSdk(resources), join(resources, "opencode-sdk"));
    await mkdir(join(resources, "opencode-sdk", "node_modules"));
    assert.throws(() => assertPackagedOpencodeSdk(resources), /without a foreign SDK tree/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaging excludes retired v1 browser and Anthropic auth output while retaining native plugins", async () => {
  const require = createRequire(import.meta.url);
  const { FileMatcher } = createRequire(require.resolve("electron-builder"))("app-builder-lib/out/fileMatcher.js");
  const config = parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "retired-auth-package-"));
  try {
    const resource = config.extraResources.find((entry) => entry.to === "opencode-plugins");
    const directory = join(root, resource.from);
    await mkdir(directory, { recursive: true });
    const inAsar = new FileMatcher(root, join(root, "asar"), (value) => value, config.files).createFilter();
    const inResources = new FileMatcher(directory, join(root, "resources"), (value) => value, resource.filter).createFilter();
    for (const name of ["legalwork-chrome-devtools", "legalwork-anthropic-auth", "legalwork-anthropic-adaptive-thinking", "legalwork-anthropic-tool-schema"]) {
      await mkdir(join(directory, name), { recursive: true });
      const file = join(directory, name, "index.js");
      await writeFile(file, "export default {};\n");
      const info = await stat(file);
      assert.equal(inAsar(file, info), false, "plugins must stay outside the ASAR");
      assert.equal(inResources(file, info), !["legalwork-anthropic-auth", "legalwork-chrome-devtools"].includes(name), name);
    }
    const stale = join(directory, "legacy-flat-plugin.js");
    await writeFile(stale, "export default {};\n");
    assert.equal(inResources(stale, await stat(stale)), false, "v1 flat output is never packaged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop packaging includes license texts for native browser, client and controller dependencies", async () => {
  const config = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(config, /- from: resources\/licenses\s+to: licenses/);
  const notices = await readFile(new URL("../resources/licenses/THIRD_PARTY_NOTICES.txt", import.meta.url), "utf8");
  const apache = await readFile(new URL("../resources/licenses/Apache-2.0.txt", import.meta.url), "utf8");
  const serverPackage = JSON.parse(await readFile(new URL("../../server/package.json", import.meta.url), "utf8"));
  for (const name of ["@opencode/plugin", "@opencode/client", "@opencode/plugin-browser"])
    assert.ok(notices.includes(`${name} ${serverPackage.devDependencies[name] ?? serverPackage.dependencies[name]}`), `License notice needs ${name}'s pinned version`);
  for (const notice of ["Copyright (c) 2025 opencode", "Copyright (c) 2025 Colin McDonnell", "Copyright (c) 2023 Effectful Technologies Inc", "Lighthouse 13.4.1", "Copyright 2016 Google LLC"])
    assert.ok(notices.includes(notice), `Missing bundled dependency attribution: ${notice}`);
  assert.ok(!notices.includes("opencode-chrome-devtools"), "retired browser attribution must not describe the current controller");
  assert.ok(!notices.includes("Additional staged SDK package notices"), "no foreign v1 SDK tree is staged");
  assert.match(apache, /Apache License/);
  assert.match(apache, /END OF TERMS AND CONDITIONS/);
});

test("SDK preparation removes v1 copies and pins the base API independently of the executable identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-sdk-stage-"));
  const source = join(root, "source"), output = join(root, "output");
  try {
    await mkdir(source, { recursive: true });
    await mkdir(join(output, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "@opencode/plugin", version: "2.1.4" }));
    assert.deepEqual(await stageOpencodeSdk({ sourcePackage: source, destination: output, expectedVersion: "2.1.4" }), { version: "2.1.4", packages: 0 });
    await assert.rejects(stat(join(output, "node_modules")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(join(output, "package.json"), "utf8")).opencode, {
      version: "2.1.4", runtime: "released-cli", providedModules: ["@opencode/plugin", "effect"],
    });
    await assert.rejects(stageOpencodeSdk({ sourcePackage: source, destination: output, expectedVersion: "2.1.5" }), /must match engine/);
    await assert.rejects(stageOpencodeSdk({ sourcePackage: source, destination: output, expectedVersion: "2.1.4-legalwork.mcp-ready.1" }), /must match engine API 2\.1\.4/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production resource copy preserves native directory entrypoints and excludes loose v1 output", async () => {
  const require = createRequire(import.meta.url);
  const { getFileMatchers, copyFiles } = createRequire(require.resolve("electron-builder"))("app-builder-lib/out/fileMatcher.js");
  const config = parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "native-plugin-resources-"));
  try {
    const source = join(root, "desktop", "server", "dist", "opencode-plugins");
    const resources = join(root, "packaged", "resources");
    for (const name of ["legalwork-word-tools", "legalwork-anthropic-auth"]) {
      await mkdir(join(source, name), { recursive: true });
      await writeFile(join(source, name, "index.js"), 'import { Plugin } from "@opencode/plugin";\nimport { Effect } from "effect";\nexport default Plugin.define({id:"copy-proof",setup(){}});\n');
    }
    await writeFile(join(source, "legalwork-word-tools.js"), "export default {};\n");
    const matchers = getFileMatchers({ extraResources: config.extraResources.filter(entry => entry.to === "opencode-plugins") }, "extraResources", resources, {
      defaultSrc: join(root, "desktop"), globalOutDir: join(root, "packaged"), customBuildOptions: {}, macroExpander: value => value,
    });
    await copyFiles(matchers);
    assert.match(await readFile(join(resources, "opencode-plugins", "legalwork-word-tools", "index.js"), "utf8"), /@opencode\/plugin/);
    await assert.rejects(stat(join(resources, "opencode-plugins", "legalwork-word-tools.js")), { code: "ENOENT" });
    await assert.rejects(stat(join(resources, "opencode-plugins", "legalwork-anthropic-auth", "index.js")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
