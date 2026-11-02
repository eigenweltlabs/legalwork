import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { extractFile, listPackage } = libRequire("@electron/asar");
const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { preProcessFile } = serverRequire("typescript");

export function findMissingServerImports(archive) {
  const files = new Set(listPackage(archive).map(file => file.replaceAll("\\", "/").replace(/^\//, "")));
  const missing = [];
  for (const file of files) {
    if (!file.startsWith("server/dist/") || file.startsWith("server/dist/opencode-plugins/") || !file.endsWith(".js") || file.endsWith(".test.js")) continue;
    // ASAR looks up entries using the host separator, including on Windows.
    const source = extractFile(archive, file.split("/").join(path.sep)).toString("utf8");
    for (const { fileName: specifier } of preProcessFile(source, true, true).importedFiles) {
      if (!specifier.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!files.has(target)) missing.push({ file, specifier });
    }
  }
  return missing;
}

export function assertPackagedServerImports(archive) {
  const missing = findMissingServerImports(archive);
  assert.deepEqual(missing, [], `Packaged server imports missing files: ${JSON.stringify(missing)}`);
  const dependencies = findMissingPackageDependencies(archive, ["@google-cloud/storage"]);
  assert.deepEqual(dependencies, [], `Packaged Google transport dependencies missing: ${JSON.stringify(dependencies)}`);
  console.log("PASS: packaged server relative imports exist inside app.asar");
}

/** Check required dependency edges after the packager has hoisted the modules. */
export function findMissingPackageDependencies(archive, roots) {
  const files = new Set(listPackage(archive).map(file => file.replaceAll("\\", "/").replace(/^\//, "")));
  const queue = roots.map(name => ({ from: "", name })), visited = new Set(), missing = [];
  for (const edge of queue) {
    let directory = edge.from, manifest;
    while (true) {
      const candidate = path.posix.join(directory, "node_modules", edge.name, "package.json");
      if (path.posix.basename(directory) !== "node_modules" && files.has(candidate)) { manifest = candidate; break; }
      if (!directory) break;
      const parent = path.posix.dirname(directory); directory = parent === "." ? "" : parent;
    }
    if (!manifest) { missing.push(edge); continue; }
    if (visited.has(manifest)) continue;
    visited.add(manifest);
    const value = JSON.parse(extractFile(archive, manifest.split("/").join(path.sep)).toString("utf8"));
    for (const name of Object.keys(value.dependencies ?? {})) {
      if (!Object.hasOwn(value.optionalDependencies ?? {}, name)) queue.push({ from: path.posix.dirname(manifest), name });
    }
  }
  return missing;
}
