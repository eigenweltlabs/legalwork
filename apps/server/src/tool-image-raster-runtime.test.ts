import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeToolImageRasterRuntime, resolveNodeToolImageRasterRuntime } from "./tool-image-raster-runtime.js";

async function install(root: string, name: string, entry: string) {
  const directory = join(root, "node_modules", name), file = join(directory, entry);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, main: entry }));
  await writeFile(file, "// Fixture module identity; never executed.\n");
  return file;
}
test("ordinary Node host resolves only physical installed package entries and canonical executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-raster-runtime-"));
  try {
    const canvas = await install(root, "@napi-rs/canvas", "index.js"), imageSize = await install(root, "image-size", "dist/cjs/index.js");
    const result = nodeToolImageRasterRuntime({ executable: process.execPath, moduleUrl: pathToFileURL(join(root, "apps/server/dist/runtime.js")).href, versions: { node: "22.23.4" } });
    expect(result).toEqual({ executable: realpathSync(process.execPath), canvas: realpathSync(canvas), imageSize: realpathSync(imageSize) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Bun/Electron/unknown hosts fail before executable or module lookup", () => {
  for (const versions of [{ bun: "1.3.14", node: "22.6.0" }, { electron: "43.8.3", node: "22.23.4" }, { bun: "", node: "22.23.4" }, {}])
    expect(() => nodeToolImageRasterRuntime({ executable: "/missing", moduleUrl: "not-a-file", versions })).toThrow("must supply an existing Node runtime callback");
  expect(() => resolveNodeToolImageRasterRuntime()).toThrow("must supply an existing Node runtime callback");
});

test("missing dependencies do not resolve through NODE_PATH, configuration or environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-raster-runtime-missing-"));
  try {
    // The fixture's installed packages are intentionally outside the trusted
    // module's ancestor chain, like a global/NODE_PATH installation.
    const global = join(root, "unrelated"); await install(global, "@napi-rs/canvas", "index.js"); await install(global, "image-size", "index.js");
    expect(() => nodeToolImageRasterRuntime({ executable: process.execPath, moduleUrl: pathToFileURL(join(root, "server/dist/runtime.js")).href, versions: { node: "22.23.4" } })).toThrow("dependency is not installed beside this server");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual Node production resolver ignores an otherwise working NODE_PATH fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-raster-runtime-node-"));
  try {
    const global = join(root, "unrelated"); await install(global, "@napi-rs/canvas", "index.js"); await install(global, "image-size", "index.js");
    const output = join(root, "server/runtime.mjs"); await mkdir(dirname(output), { recursive: true });
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "tool-image-raster-runtime.ts")], target: "node", format: "esm" });
    expect(built.success).toBe(true); expect(built.outputs).toHaveLength(1); await writeFile(output, await built.outputs[0].text());
    const script = join(root, "server/probe.mjs");
    await writeFile(script, `import {createRequire} from 'node:module';import {resolveNodeToolImageRasterRuntime} from './runtime.mjs';const bare=createRequire(import.meta.url).resolve('@napi-rs/canvas');try{resolveNodeToolImageRasterRuntime();throw new Error('Unexpected fallback');}catch(error){if(!error.message.includes('not installed beside this server'))throw error;console.log(JSON.stringify({bare,rejected:true}));}`);
    const executable = join(import.meta.dir, "../../desktop/resources/node", process.platform === "win32" ? "node.exe" : "node");
    const child = Bun.spawn([executable, script], { env: { NODE_PATH: join(global, "node_modules"), HOME: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout)).toEqual({ bare: realpathSync(join(global, "node_modules/@napi-rs/canvas/index.js")), rejected: true });
    // An ordinary physical installation next to that same runtime now works.
    await install(join(root, "server"), "@napi-rs/canvas", "index.js"); await install(join(root, "server"), "image-size", "index.js");
    await writeFile(script, "import {resolveNodeToolImageRasterRuntime} from './runtime.mjs';console.log(JSON.stringify(resolveNodeToolImageRasterRuntime()));");
    const normal = Bun.spawn([executable, script], { env: { HOME: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdout: "pipe", stderr: "pipe" });
    const result = JSON.parse(await new Response(normal.stdout).text()); expect(await new Response(normal.stderr).text()).toBe(""); expect(await normal.exited).toBe(0);
    expect(result.executable).toBe(realpathSync(executable)); expect(result.canvas).toBe(realpathSync(join(root, "server/node_modules/@napi-rs/canvas/index.js")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a broken nearest package never falls through to a working ancestor package", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-raster-runtime-broken-"));
  try {
    await install(root, "@napi-rs/canvas", "index.js"); await install(root, "image-size", "index.js");
    const nearest = join(root, "server/dist/node_modules/@napi-rs/canvas"); await mkdir(nearest, { recursive: true });
    await writeFile(join(nearest, "package.json"), JSON.stringify({ main: "missing.js" }));
    expect(() => nodeToolImageRasterRuntime({ executable: process.execPath, moduleUrl: pathToFileURL(join(root, "server/dist/runtime.js")).href, versions: { node: "22.23.4" } })).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("relative executable and non-file module identity cannot establish a runtime", () => {
  expect(() => nodeToolImageRasterRuntime({ executable: "node", moduleUrl: import.meta.url, versions: { node: "22.23.4" } })).toThrow("absolute host path");
  expect(() => nodeToolImageRasterRuntime({ executable: process.execPath, moduleUrl: "https://invalid.test/runtime.js", versions: { node: "22.23.4" } })).toThrow();
});

test.skipIf(process.platform === "win32")("normal dependency symlinks resolve to actual regular module files", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-raster-runtime-link-"));
  try {
    const target = join(root, "packages"), source = join(root, "server"), canvas = await install(target, "@napi-rs/canvas", "index.js"), imageSize = await install(target, "image-size", "index.js");
    await mkdir(join(source, "node_modules/@napi-rs"), { recursive: true });
    await symlink(join(target, "node_modules/@napi-rs/canvas"), join(source, "node_modules/@napi-rs/canvas"));
    await symlink(join(target, "node_modules/image-size"), join(source, "node_modules/image-size"));
    const result = nodeToolImageRasterRuntime({ executable: process.execPath, moduleUrl: pathToFileURL(join(source, "runtime.js")).href, versions: { node: "22.23.4" } });
    expect(result.canvas).toBe(realpathSync(canvas)); expect(result.imageSize).toBe(realpathSync(imageSize));
  } finally { await rm(root, { recursive: true, force: true }); }
});
