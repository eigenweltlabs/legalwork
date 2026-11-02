// Synthetic headless checks. Actual main-process HTTP/vault checks are in
// packaged-startup-regression.mjs --mail, with the production fuses enabled.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { verifyMailNodeRuntime } from "./verify-node-runtime.mjs";

const target = process.argv[2];
if (!target || process.argv.length !== 3 || !["darwin", "win32", "linux"].includes(process.platform)) {
  throw Error("Usage: node scripts/mail/verify-built-application.mjs <built .app, unpacked directory or executable>");
}
const application = resolve(target), info = await lstat(application);
const resources = process.platform === "darwin"
  ? info.isFile() ? resolve(dirname(application), "../Resources") : join(application, "Contents/Resources")
  : join(info.isFile() ? dirname(application) : application, "resources");
const archive = join(resources, "app.asar"), unpacked = join(resources, "app.asar.unpacked");
await access(archive);
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const builderRequire = createRequire(require.resolve("electron-builder"));
const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
const manifest = JSON.parse(asar.extractFile(archive, "server/dist/mail-node-runtime.json"));
assert.notEqual(asar.statFile(archive, "server/dist/mail-node-runtime.json").unpacked, true);
assert.equal(manifest.version, 1);
assert.deepEqual(manifest.files.map(file => file.name), ["worker.mjs", "maintenance-worker.mjs", "process.js", "package.json"]);
for (const file of manifest.files) {
  const relative = `server/dist/mail-node-runtime/${file.name}`, path = join(unpacked, relative);
  assert.equal(asar.statFile(archive, relative).unpacked, true);
  assert.equal((await lstat(path)).isFile(), true);
  assert.ok((await realpath(path)).startsWith(await realpath(unpacked) + sep));
  const bytes = await readFile(path);
  assert.equal(bytes.length, file.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
}
const executable = join(resources, "node", process.platform === "win32" ? "node.exe" : "node");
const evidence = await verifyMailNodeRuntime({ executable,
  directory: join(unpacked, "server/dist/mail-node-runtime"),
  nativeDirectory: join(unpacked, "node_modules/better-sqlite3-multiple-ciphers"),
  expectedArch: process.env.MAIL_EXPECT_ARCH ?? process.arch });
const nodeManifest = JSON.parse(await readFile(join(resources, "node/runtime.json"), "utf8"));
assert.equal(evidence.node, nodeManifest.source.version);
console.log(JSON.stringify({ ...evidence, checks: ["protected-manifest", "physical-packaged-dependencies", ...evidence.checks] }));
