import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("../", import.meta.url));
const server = resolve(desktop, "../server");
const packageName = "better-sqlite3-multiple-ciphers";
const { parse } = require("yaml");
const { minimatch } = require("minimatch");
const config = parse(await readFile(join(desktop, "electron-builder.yml"), "utf8"));
const patterns = config.asarUnpack.filter((pattern) => pattern.includes(packageName));

// Preserve each package's resolved dependency versions inside the isolated ASAR fixture.
// Loading the actual worker below detects missing transitive MIME dependencies too.
async function copyRuntimePackage(name, resolver, destination) {
  const manifestPath = name === "entities" ? resolve(dirname(resolver.resolve(name)), "../../package.json") : resolver.resolve(`${name}/package.json`);
  const source = dirname(manifestPath);
  const target = join(destination, "node_modules", name);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, filter: path => !path.startsWith(join(source, "node_modules")) });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packageRequire = createRequire(manifestPath);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyRuntimePackage(dependency, packageRequire, target);
  }
}

// Run with the installed toolchain; no downloads or whole-app build/publish.
test("mail native package and loader siblings stay unpacked in both dependency layouts", async () => {
  assert.equal(config.asar, true);
  const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  assert.equal(manifest.dependencies[packageName], "13.0.3");
  for (const prefix of [`node_modules/${packageName}`, `node_modules/.pnpm/${packageName}@13.0.3/node_modules/${packageName}`]) {
    for (const sibling of ["package.json", "lib/index.js", "lib/binding.js", "lib/methods/wrappers.js", "prebuilds/darwin-arm64.node", "prebuilds/darwin-x64.node", "prebuilds/win32-x64.node", "prebuilds/linux-x64.node"]) {
      assert.ok(patterns.some((pattern) => minimatch(`${prefix}/${sibling}`, pattern)), `${prefix}/${sibling} must be unpacked`);
    }
  }
});

function child(executable, entry, initialization, worker = false) {
  return new Promise((resolveResult, reject) => {
    const env = { ELECTRON_RUN_AS_NODE: "1" };
    for (const name of ["SystemRoot", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
    const processChild = spawn(executable, [entry], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", requested = false;
    const timer = setTimeout(() => { processChild.kill("SIGKILL"); reject(new Error("mail_packaging_probe_timeout")); }, 10_000);
    processChild.on("error", (error) => { clearTimeout(timer); reject(error); });
    processChild.stdin.on("error", () => {});
    processChild.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 65536) { processChild.kill("SIGKILL"); return; }
      if (worker && !requested && stdout.includes('"kind":"ready"')) {
        requested = true;
        processChild.stdin.end(JSON.stringify({ kind: "request", id: "1:1", command: { operation: "mail.storage.status" } }) + "\n" + JSON.stringify({kind:"request",id:"1:2",command:{operation:"mail.search",input:{}}}) + "\n" + JSON.stringify({ kind: "shutdown" }) + "\n");
      }
    });
    processChild.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 65536) processChild.kill("SIGKILL"); });
    processChild.on("close", (code) => {
      clearTimeout(timer);
      const secrets = [initialization.encryptionKey, initialization.sourceKey, initialization.destinationKey].filter(value => typeof value === "string");
      if (secrets.some(value => stdout.includes(value) || stderr.includes(value))) { reject(new Error("mail_packaging_probe_secret_leak")); return; }
      resolveResult({ code, stdout, stderr });
    });
    if (worker) processChild.stdin.write(JSON.stringify({ kind: "initialize", protocol: 1, initialization }) + "\n");
    else processChild.stdin.end(JSON.stringify(initialization));
  });
}

const inspection = `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { openEncryptedMailDatabase } from '../storage/database.js';
const require=createRequire(import.meta.url);
const input=JSON.parse(readFileSync(0,'utf8'));
const key=Buffer.from(input.encryptionKey,'base64');
const db=await openEncryptedMailDatabase({path:input.databasePath,key}); key.fill(0);
try {
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS packaging_fts USING fts5(text)');
  if (!db.get('SELECT rowid FROM packaging_fts')) db.run('INSERT INTO packaging_fts(text) VALUES (?)',['synthetic_packaging_private_marker']);
  const binding=require.resolve('${packageName}').replace(/index\\.js$/, 'binding.js');
  console.log(JSON.stringify({node:process.versions.node, electron:process.versions.electron,
    module:require.resolve('${packageName}'), native:require(binding).getPrebuildPath(),
    engine:db.get('SELECT sqlite3mc_version() AS value').value,
    cipher:Object.values(db.get('PRAGMA cipher'))[0], temp:Object.values(db.get('PRAGMA temp_store'))[0],
    count:db.get("SELECT count(*) AS count FROM packaging_fts WHERE packaging_fts MATCH 'synthetic_packaging_private_marker'").count}));
} finally { db.close(); }
`;

test("actual Electron starts built encrypted worker inside ASAR and resolves unpacked native prebuild", { timeout: 60_000 }, async () => {
  const executable = process.env.LEGALWORK_MAIL_TEST_ELECTRON ?? require("electron");
  // Resolve the ASAR API from the already-installed builder dependency graph.
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const asar = appBuilderRequire("@electron/asar");
  const root = await mkdtemp(join(tmpdir(), "legalwork-mail-asar-"));
  try {
    const built = join(root, "built");
    execFileSync(process.execPath, [createRequire(join(server, "package.json")).resolve("typescript/bin/tsc"), "--outDir", built, "--rootDir", "src", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "--types", "node,bun-types", "src/mail/runtime/worker.ts", "src/mail/runtime/maintenance-worker.ts"], { cwd: server, stdio: "pipe", timeout: 30_000 });
    const layout = "app";
    const source = join(root, layout);
    const nativeRelative = `node_modules/${packageName}`;
    await mkdir(join(source, "server"), { recursive: true });
    await writeFile(join(source, "package.json"), '{"type":"module"}');
    await writeFile(join(source, "server/package.json"), '{"type":"module"}');
    await cp(built, join(source, "server/dist"), { recursive: true });
    await writeFile(join(source, "server/dist/mail/runtime/inspection.mjs"), inspection);
    const nativeSource = dirname(require.resolve(`${packageName}/package.json`));
    assert.equal(JSON.parse(await readFile(join(nativeSource, "package.json"), "utf8")).version, "13.0.3");
    await cp(nativeSource, join(source, nativeRelative), { recursive: true, filter: (path) => !path.startsWith(join(nativeSource, "node_modules")) });
    await cp(dirname(require.resolve("zod/package.json")), join(source, "node_modules/zod"), { recursive: true });
    for (const dependency of ["@zone-eu/mailsplit", "iconv-lite", "libmime", "entities"]) {
      await copyRuntimePackage(dependency, require, source);
    }
    const archive = join(root, `${layout}.asar`);
    await asar.createPackageWithOptions(source, archive, { unpack: `{${patterns.map((pattern) => `**/${pattern}`).join(",")}}` });
    const relativePrebuild = `${nativeRelative}/prebuilds/${process.platform}-${process.arch}.node`;
    // Linux musl selection remains the native loader's responsibility; this fixture targets glibc Linux.
    assert.equal(asar.statFile(archive, relativePrebuild).unpacked, true);
    assert.equal(asar.statFile(archive, `${nativeRelative}/lib/binding.js`).unpacked, true);
    await rm(source, { recursive: true }); // No fixture source or workspace module fallback.
    const data = join(root, `${layout}-data`);
    await mkdir(data, { mode: 0o700 });
    const initialization = { ownerId: "synthetic-packaging-owner", databasePath: join(data, "mail.sqlite"), encryptionKey: randomBytes(32).toString("base64") };
    const entry = join(archive, "server/dist/mail/runtime/worker.js");
    const inspectionEntry = join(archive, "server/dist/mail/runtime/inspection.mjs");
    for (let reopen = 0; reopen < 2; reopen++) {
      const inspected = await child(executable, inspectionEntry, initialization);
      assert.equal(inspected.code, 0, inspected.stderr);
      assert.equal(inspected.stderr, "");
      const evidence = JSON.parse(inspected.stdout);
      assert.equal(evidence.engine, "SQLite3 Multiple Ciphers 2.4.0");
      assert.equal(evidence.cipher, "sqlcipher");
      assert.equal(evidence.temp, 2);
      assert.equal(evidence.count, 1);
      assert.ok(evidence.electron);
      assert.ok(evidence.module.startsWith(await realpath(root)) && evidence.module.includes(`${layout}.asar${sep}`));
      assert.ok(evidence.native.endsWith(relativePrebuild.replaceAll("/", sep)));
      const ran = await child(executable, entry, initialization, true);
      assert.equal(ran.code, 0, ran.stderr);
      assert.equal(ran.stderr, "");
      const frames = ran.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(frames[0].kind, "ready");
      assert.equal(frames[1].result.encrypted, true);
      assert.equal(frames[1].result.syncSupported, true);
      assert.deepEqual(frames[2].result.search,{items:[],total:0,pending:0,incomplete:0,nextOffset:null});
    }
    // Maintenance is a separate packaged entry point; prove it can rekey and reopen
    // the same encrypted schema/FTS using only dependencies in this ASAR.
    const rotatedDirectory = join(root, "rotated-data");
    await mkdir(rotatedDirectory, { mode: 0o700 });
    const rotated = { ...initialization, databasePath: join(rotatedDirectory, "mail.sqlite"), encryptionKey: randomBytes(32).toString("base64") };
    const maintained = await child(executable, join(archive, "server/dist/mail/runtime/maintenance-worker.js"), {
      sourcePath: initialization.databasePath, destinationPath: rotated.databasePath,
      sourceKey: initialization.encryptionKey, destinationKey: rotated.encryptionKey,
      ownerId: initialization.ownerId, restore: false, expectedSha256: null,
    });
    assert.equal(maintained.code, 0, maintained.stderr);
    assert.equal(maintained.stderr, "");
    assert.equal(JSON.parse(maintained.stdout).ok, true);
    const rotatedInspection = await child(executable, inspectionEntry, rotated);
    assert.equal(rotatedInspection.code, 0, rotatedInspection.stderr);
    assert.equal(JSON.parse(rotatedInspection.stdout).count, 1);
    const wrongKey = await child(executable, entry, { ...rotated, encryptionKey: initialization.encryptionKey }, true);
    assert.equal(wrongKey.code, 1);
    assert.deepEqual(JSON.parse(wrongKey.stdout), { kind: "fatal", code: "initialization_failed" });
    const original = await child(executable, inspectionEntry, initialization);
    assert.equal(original.code, 0, original.stderr);
    assert.equal(JSON.parse(original.stdout).count, 1);
    const bytes = await readFile(initialization.databasePath);
    assert.notEqual(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
    assert.equal(bytes.includes(Buffer.from("synthetic_packaging_private_marker")), false);
    await rm(join(`${archive}.unpacked`, relativePrebuild));
    const missing = await child(executable, entry, initialization, true);
    assert.equal(missing.code, 1);
    assert.deepEqual(JSON.parse(missing.stdout), { kind: "fatal", code: "initialization_failed" });
    assert.equal(missing.stderr, "");
    assert.deepEqual(await readFile(initialization.databasePath), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
