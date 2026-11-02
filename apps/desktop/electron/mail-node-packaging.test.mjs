import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMailNodeRuntime } from "../../../scripts/mail/verify-node-runtime.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const server = resolve(desktop, "../server"), require = createRequire(join(server, "package.json"));
const desktopRequire = createRequire(join(desktop, "package.json"));
const config = desktopRequire("yaml").parse(await readFile(join(desktop, "electron-builder.yml"), "utf8"));
const { minimatch } = desktopRequire("minimatch");
const external = ["better-sqlite3-multiple-ciphers", "tesseract.js", "@tesseract.js-data/eng", "@tesseract.js-data/deu", "pdfjs-dist", "@napi-rs/canvas"];

async function manifestPath(name, resolver) {
  try { return resolver.resolve(`${name}/package.json`); }
  catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let directory = dirname(resolver.resolve(name));
    while (true) {
      const path = join(directory, "package.json");
      try { if (JSON.parse(await readFile(path, "utf8")).name === name) return path; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const parent = dirname(directory); if (parent === directory) throw Error("missing_package_manifest"); directory = parent;
    }
  }
}
async function copyPackage(name, resolver, destination) {
  const manifest = await manifestPath(name, resolver), source = dirname(manifest);
  const target = join(destination, "node_modules", name), value = JSON.parse(await readFile(manifest, "utf8"));
  // Each resolved closure must remain physical outside ASAR for standalone Node.
  for (const prefix of [`node_modules/${name}`, `node_modules/.pnpm/${name.replaceAll("/", "+")}@${value.version}/node_modules/${name}`]) {
    assert.ok(config.asarUnpack.some(pattern => minimatch(`${prefix}/package.json`, pattern)), `Unpacked dependency: ${name}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, filter: path => !path.startsWith(join(source, "node_modules")) });
  const local = createRequire(manifest), dependencies = value.dependencies ?? {};
  for (const dependency of Object.keys(dependencies)) {
    // The cipher's prebuild loader uses no node-addon-api headers at runtime.
    if (name === "better-sqlite3-multiple-ciphers" && dependency === "node-addon-api") continue;
    await copyPackage(dependency, local, target);
  }
  for (const dependency of Object.keys(value.optionalDependencies ?? {})) {
    try { await manifestPath(dependency, local); }
    catch (error) { if (error.code === "MODULE_NOT_FOUND") continue; throw error; }
    if (!Object.hasOwn(dependencies, dependency)) await copyPackage(dependency, local, target);
  }
}

test("standalone Node executes unpacked mail, PDF and OCR with the fixture source removed", { timeout: 180_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mail-node-asar-")));
  try {
    const source = join(root, "source"), dist = join(source, "server/dist"), output = join(dist, "mail-node-runtime");
    await mkdir(source);
    execFileSync(process.env.LEGALWORK_MAIL_TEST_BUN ?? "bun", [join(server, "scripts/build-mail-node-runtime.ts"), output], { cwd: server, timeout: 30_000, stdio: "pipe" });
    for (const name of external) await copyPackage(name, require, source);
    const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
    const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
    const archive = join(root, "app.asar");
    await asar.createPackageWithOptions(source, archive, { unpack: `{${config.asarUnpack.map(pattern => `**/${pattern}`).join(",")}}` });
    assert.notEqual(asar.statFile(archive, "server/dist/mail-node-runtime.json").unpacked, true);
    const manifest = JSON.parse(asar.extractFile(archive, "server/dist/mail-node-runtime.json"));
    for (const expected of manifest.files) {
      const relative = `server/dist/mail-node-runtime/${expected.name}`;
      assert.equal(asar.statFile(archive, relative).unpacked, true);
      const bytes = await readFile(join(`${archive}.unpacked`, relative));
      assert.equal(bytes.length, expected.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
    }
    await rm(source, { recursive: true });
    const evidence = await verifyMailNodeRuntime({ executable: process.env.LEGALWORK_MAIL_TEST_NODE ?? process.execPath,
      directory: join(`${archive}.unpacked`, "server/dist/mail-node-runtime"),
      nativeDirectory: join(`${archive}.unpacked`, "node_modules/better-sqlite3-multiple-ciphers"), expectedArch: process.arch });
    assert.equal(evidence.passed, true);
    assert.ok(evidence.checks.includes("attachment-subprocess-indexing"));
    assert.ok(evidence.checks.includes("offline-OCR"));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
