import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256, validateRecipe, verifyInputs, verifyUpstreamSource, verifyCompiler, assertBuildReady, localizeDependencyLinks, withBuildStagingLock, applyReviewedPatch, cloneReviewedSource } from "./candidate.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(directory, "../../..");
const recipe = JSON.parse(await readFile(path.join(directory, "recipe.json"), "utf8"));

test("patched identity is distinct and retains the entire official target matrix", () => {
  validateRecipe(recipe);
  assert.throws(() => validateRecipe({ ...recipe, version: recipe.baseVersion }), /distinct LegalWork identity/);
  assert.throws(() => validateRecipe({ ...recipe, targets: recipe.targets.slice(1) }), /complete official target matrix/);
  assert.throws(() => validateRecipe({ ...recipe, upstream: { ...recipe.upstream, commit: "latest" } }), /exact upstream source identity/);
});

test("local patch and receipt are digest-verified without downloading upstream source", async () => {
  const inputs = await verifyInputs(recipe);
  assert.deepEqual(Object.keys(inputs).sort(), ["patch", "testReceipt"]);
  for (const [name, bytes] of Object.entries(inputs)) assert.equal(sha256(bytes), recipe.inputs[name].sha256);
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-candidate-inputs-"));
  try {
    for (const name of Object.keys(inputs)) {
      const pin = recipe.inputs[name];
      const target = path.join(root, pin.path);
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, inputs[name]);
    }
    await verifyInputs(recipe, root);
    for (const name of Object.keys(inputs)) {
      const pin = recipe.inputs[name]; await writeFile(path.join(root, pin.path), Buffer.concat([inputs[name], Buffer.from("tampered")]));
      await assert.rejects(verifyInputs(recipe, root), new RegExp(`Pinned build input changed: ${name}`));
      await writeFile(path.join(root, pin.path), inputs[name]);
    }
    const escaped = { ...recipe, inputs: { ...recipe.inputs, patch: { ...recipe.inputs.patch, path: "../outside.patch" } } };
    await assert.rejects(verifyInputs(escaped, root), /escapes the reviewed repository/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("upstream commit and both frozen dependency files must match before use", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-upstream-inputs-"));
  const git = (...args) => promisify(execFile)("git", args, { cwd: root });
  const files = { lockfile: Buffer.from("frozen dependency fixture\n"), rootPackage: Buffer.from('{"name":"upstream-fixture"}\n') };
  try {
    await git("init");
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(root, recipe.inputs[name].upstreamPath), bytes);
    await git("add", ".");
    await git("-c", "user.name=LegalWork fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    const pinned = { ...recipe, upstream: { ...recipe.upstream, commit: (await git("rev-parse", "HEAD")).stdout.trim() },
      inputs: { ...recipe.inputs, ...Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { ...recipe.inputs[name], sha256: sha256(bytes) }])) } };
    await verifyUpstreamSource(pinned, root);
    await assert.rejects(verifyUpstreamSource({ ...pinned, upstream: { ...pinned.upstream, commit: "0".repeat(40) } }, root), /reviewed upstream commit/);
    for (const [name, bytes] of Object.entries(files)) {
      const filename = path.join(root, pinned.inputs[name].upstreamPath);
      await writeFile(filename, Buffer.concat([bytes, Buffer.from("tampered")]));
      await assert.rejects(verifyUpstreamSource(pinned, root), /Frozen upstream dependency input changed/);
      await rm(filename);
      await assert.rejects(verifyUpstreamSource(pinned, root), { code: "ENOENT" });
      await writeFile(filename, bytes);
      const escaped = { ...pinned, inputs: { ...pinned.inputs, [name]: { ...pinned.inputs[name], upstreamPath: "../outside" } } };
      assert.throws(() => validateRecipe(escaped), /invalid pinned build input/);
    }
    await verifyUpstreamSource(pinned, root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared workspace links resolve inside the independent build instead of its tested source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-build-links-"));
  const prepared = path.join(root, "tested"), source = path.join(root, "build"), modules = path.join(source, "node_modules");
  await mkdir(modules, { recursive: true });
  try {
    await symlink(path.join(prepared, "packages", "core"), path.join(modules, "core"));
    await localizeDependencyLinks(modules, prepared, source);
    assert.equal(path.resolve(modules, await readlink(path.join(modules, "core"))), path.join(source, "packages", "core"));
    await symlink(path.join(root, "unreviewed"), path.join(modules, "external"));
    await assert.rejects(localizeDependencyLinks(modules, prepared, source), /escapes the reviewed source checkout/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reviewed source comparison includes added patch files and rejects a dirty base", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-build-patch-"));
  const git = (...args) => promisify(execFile)("git", args, { cwd: root });
  try {
    await git("init");
    await writeFile(path.join(root, "existing.txt"), "before\n");
    await git("add", "existing.txt");
    await git("-c", "user.name=LegalWork fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    const patch = path.join(root, "reviewed.patch");
    await writeFile(patch, "diff --git a/existing.txt b/existing.txt\n--- a/existing.txt\n+++ b/existing.txt\n@@ -1 +1 @@\n-before\n+after\ndiff --git a/added.txt b/added.txt\nnew file mode 100644\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+new source\n");
    await writeFile(path.join(root, "existing.txt"), "unreviewed\n");
    await assert.rejects(applyReviewedPatch(root, patch), /failed/);
    await assert.rejects(readFile(path.join(root, "added.txt")), { code: "ENOENT" });
    await writeFile(path.join(root, "existing.txt"), "before\n");
    await git("add", "existing.txt");
    await applyReviewedPatch(root, patch);
    const changed = (await git("diff", "--name-only", "HEAD")).stdout.trim().split("\n").sort();
    assert.deepEqual(changed, ["added.txt", "existing.txt"]);
    assert.equal(await readFile(path.join(root, "added.txt"), "utf8"), "new source\n");
    assert.equal((await git("show", ":added.txt")).stdout, "new source\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("independent cloning retains the shallow boundary of a linked source worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-build-shallow-"));
  const origin = path.join(root, "origin"), shallow = path.join(root, "shallow"), linked = path.join(root, "linked"), copied = path.join(root, "copy");
  const git = (...args) => promisify(execFile)("git", args, { cwd: root });
  try {
    await mkdir(origin);
    await git("-C", origin, "init");
    for (const value of ["parent", "release"]) {
      await writeFile(path.join(origin, "source.txt"), value);
      await git("-C", origin, "add", "source.txt");
      await git("-C", origin, "-c", "user.name=LegalWork fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-m", value);
    }
    await git("clone", "--no-local", "--depth=1", origin, shallow);
    await git("-C", shallow, "worktree", "add", "--detach", linked, "HEAD");
    await cloneReviewedSource(linked, copied);
    assert.equal((await git("-C", copied, "rev-parse", "--is-shallow-repository")).stdout.trim(), "true");
    assert.equal((await git("-C", copied, "rev-parse", "HEAD")).stdout, (await git("-C", linked, "rev-parse", "HEAD")).stdout);
    assert.equal((await git("-C", copied, "show", "-s", "--format=%ct", "HEAD")).stdout, (await git("-C", linked, "show", "-s", "--format=%ct", "HEAD")).stdout);
    await assert.rejects(readFile(path.join(copied, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate preparation never rewrites the official binary provenance pins", async () => {
  const source = path.join(repository, "packages/opencode-release/release.json"), before = await readFile(source);
  await verifyInputs(recipe);
  assert.equal(sha256(await readFile(source)), sha256(before));
  assert.equal(JSON.parse(before).version, recipe.baseVersion);
});

test("unreviewed compiler bytes and builder hosts fail before executable probing", () => {
  assert.throws(() => verifyCompiler(recipe, Buffer.from("unreviewed compiler"), "darwin-arm64"), /does not match/);
  assert.throws(() => verifyCompiler(recipe, Buffer.from("unreviewed compiler"), "unreviewed-host"), /reviewed Bun compiler package\/hash is required/);
});

test("source test evidence must match this exact patch, lock and compiler version", () => {
  const tested = { ...recipe, buildStatus: "tested-source-lock", testEvidence: { receiptSha256: recipe.inputs.testReceipt.sha256, lockfileSha256: recipe.inputs.lockfile.sha256, patchSha256: recipe.inputs.patch.sha256, bun: recipe.toolchain.bun } };
  assertBuildReady(tested);
  assert.throws(() => assertBuildReady({ ...tested, buildStatus: "dependency-audit-pending" }), /Candidate compilation is held/);
  assert.throws(() => assertBuildReady({ ...tested, testEvidence: { ...tested.testEvidence, lockfileSha256: "stale" } }), /Candidate compilation is held/);
  assert.throws(() => assertBuildReady({ ...tested, testEvidence: { ...tested.testEvidence, patchSha256: "stale" } }), /Candidate compilation is held/);
  assert.throws(() => assertBuildReady({ ...tested, testEvidence: { ...tested.testEvidence, receiptSha256: "stale" } }), /Candidate compilation is held/);
});

test("native staging reuse is serial and releases only its own lock after failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-staging-lock-"));
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  try {
    const first = withBuildStagingLock(root, async () => { entered(); await held; });
    await ready;
    await assert.rejects(withBuildStagingLock(root, async () => { throw new Error("must not enter"); }), { code: "EEXIST" });
    release(); await first;
    await assert.rejects(withBuildStagingLock(root, async () => { throw new Error("build failed"); }), /build failed/);
    assert.equal(await withBuildStagingLock(root, async () => "next target"), "next target");
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});


test("reviewed cloning persists LF checkout policy despite a global autocrlf=true setting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-build-lf-"));
  const home = path.join(root, "home"), origin = path.join(root, "origin"), unsafe = path.join(root, "unsafe"), copied = path.join(root, "reviewed");
  const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
  try {
    await mkdir(home); await mkdir(origin);
    await writeFile(path.join(home, ".gitconfig"), "[core]\n autocrlf = true\n eol = crlf\n");
    process.env.HOME = home; process.env.USERPROFILE = home;
    const git = (...args) => promisify(execFile)("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } });
    await git("-C", origin, "init");
    const bytes = Buffer.from("exact upstream source\nsecond line\n");
    for (const name of ["source.ts", "bun.lock", "package.json"]) await writeFile(path.join(origin, name), bytes);
    await git("-C", origin, "add", ".");
    await git("-C", origin, "-c", "user.name=LegalWork fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-m", "LF blobs");
    await git("clone", "--no-local", "--no-checkout", origin, unsafe);
    await git("-C", unsafe, "checkout", "HEAD");
    assert.equal((await readFile(path.join(unsafe, "source.ts"), "utf8")).includes("\r\n"), true, "negative control must exercise real global CRLF checkout conversion");
    await cloneReviewedSource(origin, copied);
    assert.equal((await git("-C", copied, "config", "--local", "core.autocrlf")).stdout.trim(), "false");
    assert.equal((await git("-C", copied, "config", "--local", "core.eol")).stdout.trim(), "lf");
    await git("-C", copied, "checkout", "HEAD");
    for (const name of ["source.ts", "bun.lock", "package.json"]) assert.deepEqual(await readFile(path.join(copied, name)), bytes);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    await rm(root, { recursive: true, force: true });
  }
});
