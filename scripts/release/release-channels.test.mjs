import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pinManifest } from "./refresh-alpha-feeds.mjs";

const { parse } = createRequire(new URL("../../apps/desktop/package.json", import.meta.url))("yaml");
const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("app-affecting dev merges build both alpha workflows without canceling older builds or retesting the sandbox", () => {
  for (const name of ["alpha-macos-aarch64", "alpha-windows-x64"]) {
    const config = workflow(name);
    assert.deepEqual(config.on.push.branches, ["dev"]);
    assert.equal(config.concurrency["cancel-in-progress"], false);
    assert.match(config.concurrency.group, /github.sha/);
    assert.equal(config.on.workflow_dispatch.inputs.sandbox_tests.default, false);
    assert.match(config.jobs["sandbox-runtime"].with.run_tests, /github.event_name == 'workflow_dispatch'/);
    const job = Object.values(config.jobs).find((job) => job.steps?.some(step => step.name === "Verify packaged startup"));
    assert.equal(config.jobs["opencode-engine"].if, "needs.changes.outputs.alpha == 'true'");
    assert.equal(config.jobs["sandbox-runtime"].if, "needs.changes.outputs.alpha == 'true'");
    assert.ok(job.steps.some((step) => step.name === "Verify packaged startup"));
    const create = job.steps.find((step) => step.name === "Create immutable alpha prerelease").run;
    assert.match(create, /--draft/);
    const upload = job.steps.find((step) => step.name === "Upload Electron alpha updater assets").run;
    assert.match(upload, /preserve its immutable artifacts/);
    const publish = job.steps.find((step) => step.name === "Publish complete alpha").run;
    assert.match(publish, /--prerelease --latest=false/);
    assert.ok(!job.steps.some((step) => step.name === "Update alpha updater pointer"));
  }
  assert.equal(workflow("ci-tests").on.push, undefined);
  assert.ok(workflow("ci-tests").on.pull_request);
});

test("regular releases still build as drafts; label changes only refresh existing alpha pointers", () => {
  const release = workflow("release-macos-aarch64");
  assert.deepEqual(release.on.push.tags, ["v*"]);
  assert.equal(release.on.push.branches, undefined);
  assert.equal(release.on.workflow_dispatch.inputs.draft.default, true);
  const refresh = workflow("refresh-alpha-feeds");
  assert.ok(refresh.on.release.types.includes("edited"));
  assert.ok(refresh.on.release.types.includes("published"));
  assert.equal(refresh.concurrency["cancel-in-progress"], false);
  assert.equal(refresh.jobs.refresh.steps[0].with.ref, "dev");
  const script = readFileSync(new URL("./refresh-alpha-feeds.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /"release", "(?:create|edit)"/);
});

test("rolling manifests pin installer URLs to the selected version and preserve hashes", () => {
  const selected = { version: "4.0.0", feedUrl: "https://github.com/eigenweltlabs/legalwork/releases/download/v4.0.0", assetNames: ["legalwork-win-x64-4.0.0.exe"] };
  const text = "version: 4.0.0\nfiles:\n  - url: legalwork-win-x64-4.0.0.exe\n    sha512: expected\npath: legalwork-win-x64-4.0.0.exe\nsha512: expected\n";
  const pinned = parse(pinManifest(text, selected));
  assert.equal(pinned.files[0].url, `${selected.feedUrl}/${selected.assetNames[0]}`);
  assert.equal(pinned.path, pinned.files[0].url);
  assert.equal(pinned.files[0].sha512, "expected");
  assert.throws(() => pinManifest(text.replace("version: 4.0.0", "version: 3.0.0"), selected), /version mismatch/);
  assert.throws(() => pinManifest(text.replaceAll("legalwork-win-x64-4.0.0.exe", "https://other.invalid/installer"), selected), /unknown release asset/);
});
