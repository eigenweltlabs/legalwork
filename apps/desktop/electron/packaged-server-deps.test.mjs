import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findServerDepDrift } from "../scripts/check-server-deps.mjs";
import { findMissingPackageDependencies, findMissingServerImports } from "../scripts/check-packaged-server-imports.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { createPackage } = libRequire("@electron/asar");
const { getCollectorByPackageManager } = libRequire("./node-module-collector/index.js");

test("packaging catches a server import into an excluded plugin directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-server-imports-"));
  const stage = path.join(root, "stage");
  const routes = path.join(stage, "server/dist/routes");
  const archive = path.join(root, "app.asar");
  try {
    await mkdir(routes, { recursive: true });
    await writeFile(path.join(routes, "sessions.js"), 'import { prompt } from "../opencode-plugins/recovery.js";\n');
    await createPackage(stage, archive);
    assert.deepEqual(findMissingServerImports(archive), [{ file: "server/dist/routes/sessions.js", specifier: "../opencode-plugins/recovery.js" }]);
    await mkdir(path.join(stage, "server/dist/reviews"));
    await writeFile(path.join(stage, "server/dist/reviews/recovery.js"), 'export const prompt = "Continue";\n');
    await writeFile(path.join(routes, "sessions.js"), 'import { prompt } from "../reviews/recovery.js";\n');
    const fixedArchive = path.join(root, "fixed.asar");
    await createPackage(stage, fixedArchive);
    assert.deepEqual(findMissingServerImports(fixedArchive), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaging catches missing hoisted dependencies in the Google fetch transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-transport-imports-")), stage = path.join(root, "stage");
  const put = async (name, dependencies, optionalDependencies = {}) => {
    const directory = path.join(stage, "node_modules", name); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, dependencies, optionalDependencies }));
  };
  try {
    await put("@google-cloud/storage", { gaxios: "6" });
    await put("gaxios", { "node-fetch": "2" });
    await put("gaxios/node_modules/node-fetch", { "whatwg-url": "5", encoding: "0.1" }, { encoding: "0.1" });
    const broken = path.join(root, "broken.asar"); await createPackage(stage, broken);
    assert.deepEqual(findMissingPackageDependencies(broken, ["@google-cloud/storage"]), [
      { from: "node_modules/gaxios/node_modules/node-fetch", name: "whatwg-url" },
    ]);
    await put("whatwg-url", { tr46: "0.0.3", "webidl-conversions": "3" });
    await put("tr46", {}); await put("webidl-conversions", {});
    const fixed = path.join(root, "fixed.asar"); await createPackage(stage, fixed);
    assert.deepEqual(findMissingPackageDependencies(fixed, ["@google-cloud/storage"]), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the full pnpm workspace collector preserves required dependencies and aliases", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-workspace-deps-")), stage = path.join(root, "stage");
  let sequence = 0;
  try {
    const collector = getCollectorByPackageManager("pnpm", fileURLToPath(new URL("../../../", import.meta.url)), {
      getTempFile: async () => path.join(root, `${++sequence}.json`),
    });
    const { nodeModules } = await collector.getNodeModules({ packageName: "@legalwork/desktop" });
    const copy = async (nodes, base) => {
      for (const node of nodes) {
        const target = path.join(base, "node_modules", node.name);
        await mkdir(target, { recursive: true });
        await copyFile(path.join(node.dir, "package.json"), path.join(target, "package.json"));
        await copy(node.dependencies ?? [], target);
      }
    };
    await copy(nodeModules, stage);
    const archive = path.join(root, "app.asar"); await createPackage(stage, archive);
    assert.deepEqual(findMissingPackageDependencies(archive, nodeModules.map(node => node.name)), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A missing mirror only surfaces after packaging -- the alpha/release workflows
// go straight from install to build:electron, so catch it here on every PR too.
test("desktop mirrors every server runtime dependency for the packaged asar", () => {
  const { missing, mismatched } = findServerDepDrift();
  assert.deepEqual(
    missing,
    [],
    `apps/desktop/package.json is missing server runtime deps: ${missing.join(", ")}`,
  );
  assert.deepEqual(mismatched, [], `Version ranges drifted from apps/server: ${mismatched.join(", ")}`);
});
