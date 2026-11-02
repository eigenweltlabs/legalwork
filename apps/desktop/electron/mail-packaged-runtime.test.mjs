import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPackagedMailRuntime } from "./mail-packaged-runtime.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "mail-runtime-integrity-"));
  const runtime = createPackagedMailRuntime(root);
  const directory = dirname(runtime.entryPoint), manifestPath = join(root, "app.asar/server/dist/mail-node-runtime.json");
  try {
    await mkdir(directory, { recursive: true });
    await mkdir(dirname(manifestPath), { recursive: true });
    await mkdir(dirname(runtime.executable.path));
    await writeFile(runtime.executable.path, "synthetic binary");
    const files = [];
    for (const name of ["worker.mjs", "maintenance-worker.mjs", "process.js", "package.json"]) {
      const bytes = Buffer.from(name === "package.json" ? '{"type":"module"}' : "// synthetic worker\n");
      await writeFile(join(directory, name), bytes);
      files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const manifest = { version: 1, files };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await run({ root, runtime, directory, manifestPath, manifest });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("packaged mail selects installation Node without touching disk before unlock", async () => {
  const runtime = createPackagedMailRuntime(join(tmpdir(), "absent-mail-runtime"));
  assert.equal(runtime.executable.kind, "node");
  assert.match(runtime.entryPoint, /app\.asar\.unpacked/);
  await assert.rejects(runtime.verify(), /mail_packaged_runtime_invalid/);
  assert.throws(() => createPackagedMailRuntime("relative"), /mail_packaged_runtime_invalid/);
  assert.throws(() => createPackagedMailRuntime(undefined), /mail_packaged_runtime_invalid/);
});
test("all worker entries and ESM marker match the protected manifest", () => fixture(async ({ runtime }) => {
  await runtime.verify();
}));
test("a changed extraction worker fails verification even with the same byte count", () => fixture(async ({ runtime, directory }) => {
  const path = join(directory, "process.js"), bytes = await readFile(path);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(path, bytes);
  await assert.rejects(runtime.verify(), /mail_packaged_runtime_invalid/);
}));
test("missing worker and missing installation Node cannot use a workspace fallback", () => fixture(async ({ runtime, directory }) => {
  await rm(join(directory, "maintenance-worker.mjs"));
  await assert.rejects(runtime.verify(), /mail_packaged_runtime_invalid/);
  await rm(runtime.executable.path);
  await assert.rejects(runtime.verify(), /mail_packaged_runtime_invalid/);
}));
test("manifest traversal, extra fields, invalid hashes and oversized input are rejected", () => fixture(async ({ runtime, manifestPath, manifest }) => {
  for (const value of [
    { ...manifest, extra: true },
    { ...manifest, files: [{ ...manifest.files[0], name: "../worker.mjs" }, ...manifest.files.slice(1)] },
    { ...manifest, files: [{ ...manifest.files[0], sha256: "invalid" }, ...manifest.files.slice(1)] },
    { ...manifest, files: manifest.files.slice(1) },
    " ".repeat(4097),
  ]) {
    await writeFile(manifestPath, typeof value === "string" ? value : JSON.stringify(value));
    await assert.rejects(runtime.verify(), /mail_packaged_runtime_invalid/);
  }
}));
test("a worker directory junction outside the installation is rejected", () => fixture(async ({ root, runtime, directory }) => {
  const outside = join(root, "outside");
  const { rename } = await import("node:fs/promises");
  await rename(directory, outside);
  await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runtime.verify(), /mail_packaged_runtime_invalid/);
}));
