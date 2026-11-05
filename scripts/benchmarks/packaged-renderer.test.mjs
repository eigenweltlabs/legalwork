import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, lstat, readdir, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { verifyPackagedRendererIdentity, physicalRendererVerificationPython } from "./packaged-renderer.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
function identity() {
  const asar = "1e78251815b069e075e9a3eeeccf519adfe3e2912f983bf4827ef71d04e8f360";
  const tree = "9af995c3425a8afc47d43b7978bb65ee46eb2bb0cebd4dfb53a62b3653ecf278";
  return { runtime: { renderer: { kind: "packaged-linux-renderer-and-asar", asarSha256: asar,
    physicalDirectory: "resources/app-dist", files: 958, treeSha256: tree,
    physicalVerification: { method: "actual-complete-sealed-physical-renderer", asarRelativePath: "resources/app.asar",
      asarSha256: asar, physicalDirectory: "resources/app-dist", entries: 958, treeSha256: tree } } },
  build: { asar: { sha256: asar }, appTreeSha256: tree } };
}
test("accepts actual reviewed final2 hybrid facts only with matching full physical proof", () => {
  assert.equal(verifyPackagedRendererIdentity(identity()), true);
});
test("preserves the historical ASAR renderer branch", () => {
  assert.equal(verifyPackagedRendererIdentity({ runtime: { renderer: { kind: "packaged-linux-asar" } } }), true);
});
for (const [name, change] of [
  ["unknown kind", x => { x.runtime.renderer.kind = "unknown"; }],
  ["missing ASAR hash", x => { delete x.runtime.renderer.asarSha256; }],
  ["wrong ASAR hash", x => { x.runtime.renderer.asarSha256 = "a".repeat(64); }],
  ["wrong actual ASAR path", x => { x.runtime.renderer.physicalVerification.asarRelativePath = "resources/fake.asar"; }],
  ["wrong physical path", x => { x.runtime.renderer.physicalDirectory = "resources/other"; }],
  ["missing tree hash", x => { delete x.runtime.renderer.treeSha256; }],
  ["stale build tree hash", x => { x.build.appTreeSha256 = "b".repeat(64); }],
  ["zero count", x => { x.runtime.renderer.files = 0; }],
  ["fractional count", x => { x.runtime.renderer.files = 958.5; }],
  ["missing actual proof", x => { delete x.runtime.renderer.physicalVerification; }],
  ["declared-only proof", x => { x.runtime.renderer.physicalVerification.method = "copied-manifest"; }],
  ["wrong actual count", x => { x.runtime.renderer.physicalVerification.entries--; }],
  ["wrong actual digest", x => { x.runtime.renderer.physicalVerification.treeSha256 = "c".repeat(64); }],
]) test(`hybrid refuses ${name}`, () => { const value = identity(); change(value); assert.throws(() => verifyPackagedRendererIdentity(value)); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-renderer-"));
  const directory = join(root, "resources/app-dist");
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(join(root, "resources/app.asar"), "actual ASAR fixture bytes", { mode: 0o644 });
  await writeFile(join(directory, "index.html"), "<html>real renderer fixture</html>", { mode: 0o644 });
  await writeFile(join(directory, "assets/main.js"), "window.fixture = true;", { mode: 0o644 });
  for (const path of [join(root, "resources"), directory, join(directory, "assets")]) await chmod(path, 0o755);
  const paths = [];
  async function walk(path) { for (const name of await readdir(path)) { const entry = join(path, name); paths.push(entry); if ((await lstat(entry)).isDirectory()) await walk(entry); } }
  await walk(directory);
  const files = [];
  for (const path of paths.sort()) {
    const info = await lstat(path); const row = { path: relative(root, path), type: info.isFile() ? "file" : "directory",
      mode: "0o" + (info.mode & 0o7777).toString(8), size: info.size, uid: info.uid, gid: info.gid, nlink: info.nlink };
    if (info.isFile()) row.sha256 = sha(await (await import("node:fs/promises")).readFile(path));
    files.push(row);
  }
  const asar = sha("actual ASAR fixture bytes"), tree = sha(JSON.stringify(stable(files)));
  const data = { runtime: { renderer: { kind: "packaged-linux-renderer-and-asar", physicalDirectory: "resources/app-dist", files: files.length, treeSha256: tree, asarSha256: asar } }, build: { asar: { sha256: asar }, appTreeSha256: tree } };
  return { root, directory, files, asar, data, owner: await lstat(root) };
}
function verifyActual(value) {
  const script = physicalRendererVerificationPython + "\nimport pathlib,json,sys\nx=json.loads(sys.argv[1]);print(json.dumps(verify_physical_renderer(pathlib.Path(x['root']),x['data'],{'files':x['files']},x['asar'],x['uid'],x['gid'])))\n";
  return spawnSync("python3", ["-c", script, JSON.stringify({ ...value, uid: value.owner.uid, gid: value.owner.gid })], { encoding: "utf8" });
}
for (const [name, mutation] of [
  ["unchanged complete tree", async () => {}],
  ["same-length changed file", async x => { await writeFile(join(x.directory, "assets/main.js"), "window.fixture = falSe"); }],
  ["extra member", async x => { await writeFile(join(x.directory, "extra"), "not in receipt"); }],
  ["missing member", async x => { await rm(join(x.directory, "index.html")); }],
  ["symlink replacement", async x => { await rm(join(x.directory, "index.html")); await symlink("assets/main.js", join(x.directory, "index.html")); }],
  ["writable member", async x => { await chmod(join(x.directory, "index.html"), 0o666); }],
  ["wrong owner declaration", async x => { x.files[0].uid++; }],
  ["duplicate receipt member", async x => { x.files.push(x.files[0]); }],
  ["declared path escape", async x => { x.files[0].path = "resources/app-dist/../escape"; }],
  ["wrong full-tree digest", async x => { x.data.runtime.renderer.treeSha256 = "0".repeat(64); }],
]) test(`actual filesystem ${name}`, async () => {
  const value = await fixture();
  try {
    await mutation(value); const result = verifyActual(value);
    if (name === "unchanged complete tree") { assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).entries, value.files.length); }
    else assert.notEqual(result.status, 0, `${name} must fail actual sealed renderer verification`);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
