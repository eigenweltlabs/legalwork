// Opt-in: isolate packaged libraries and run with the same Node binary shipped in the app.
import { createRequire } from "node:module";
import { mkdir, mkdtemp, cp, writeFile, readFile, stat, readdir, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const modelRoot = process.env.LEGALWORK_OCR_NATIVE_SMOKE_ROOT;
if (!modelRoot) throw new Error("Set LEGALWORK_OCR_NATIVE_SMOKE_ROOT to a prepared OCR directory");
const node = resolve("resources/node", process.platform === "win32" ? "node.exe" : "node");
await access(node); // Run scripts/prepare-node-runtime.mjs first.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { createPackageWithOptions } = libRequire("@electron/asar");
const { pruneOcrRuntime } = require("./packaged-ocr.cjs");
const root = await mkdtemp(join(tmpdir(), "legalwork-ocr-packaged-"));
const stage = join(root, "stage"), resources = join(root, "Resources"), modules = join(stage, "node_modules");
await mkdir(modules, { recursive: true });
await mkdir(resources);
const nativeCanvas = process.platform === "win32" ? `@napi-rs/canvas-win32-${process.arch}-msvc`
  : process.platform === "linux" ? `@napi-rs/canvas-linux-${process.arch}-gnu` : `@napi-rs/canvas-darwin-${process.arch}`;
const additions = ["onnxruntime-node", "onnxruntime-common", "paddleocr", "image-size"];
for (const name of [...additions, "@napi-rs/canvas", nativeCanvas]) {
  let source;
  if (name === "onnxruntime-common") source = resolve(dirname(createRequire(require.resolve("onnxruntime-node")).resolve(name)), "../..");
  else if (name === "image-size") source = resolve(dirname(require.resolve(name)), "../..");
  else if (name === nativeCanvas) source = dirname(createRequire(require.resolve("@napi-rs/canvas")).resolve(`${name}/package.json`));
  else source = dirname(require.resolve(`${name}/package.json`));
  await cp(source, join(modules, name), { recursive: true, dereference: true });
}
await writeFile(join(stage, "package.json"), "{}");
const builderConfig = parse(await readFile("electron-builder.yml", "utf8"));
// Builder matches files; ASAR's unpackDir matches their parent directories.
const unpackDirectories = builderConfig.asarUnpack.map(pattern => pattern.replace(/\/\*\*$/, ""));
await createPackageWithOptions(stage, join(resources, "app.asar"), { unpackDir: `{${unpackDirectories.join(",")}}` });
await cp(resolve("../server/resources/ocr"), join(resources, "ocr"), { recursive: true });
pruneOcrRuntime(resources, process.platform, process.arch);
const unpacked = join(resources, "app.asar.unpacked/node_modules");
const image = await readFile(resolve("../server/resources/ocr/test-page.png"));
const result = spawnSync(node, [join(resources, "ocr/native-worker.cjs"), "--model-dir", join(modelRoot, "models")], {
  input: JSON.stringify({ width: 1000, height: 260, image: image.toString("base64") }),
  encoding: "utf8", cwd: root, env: { NODE_PATH: unpacked, PATH: "", HOME: root, ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) }, timeout: 120000,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr);
const output = JSON.parse(result.stdout);
if (!output.text.includes("Agreement") || !output.text.includes("fällig")) throw new Error("Recognition mismatch");
async function size(directory) {
  const info = await stat(directory);
  if (info.isFile()) return info.size;
  let bytes = 0;
  for (const entry of await readdir(directory)) bytes += await size(join(directory, entry));
  return bytes;
}
let extra = 0;
for (const name of additions) extra += await size(join(unpacked, name));
extra += (await stat(join(resources, "ocr/native-worker.cjs"))).size;
const tar = join(root, "native-ocr-payload.tar.gz");
const archive = spawnSync("tar", ["-czf", tar, ...additions], { cwd: unpacked });
if (archive.status !== 0) throw new Error("Archive failed");
console.log(JSON.stringify({ root, recognition: output.text, additionalInstalledBytes: extra, gzipPayloadBytes: (await stat(tar)).size, existingCanvasAndNodeReused: true }, null, 2));
