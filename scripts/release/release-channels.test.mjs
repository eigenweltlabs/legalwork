import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pinManifest } from "./refresh-alpha-feeds.mjs";

const { parse } = createRequire(new URL("../../apps/desktop/package.json", import.meta.url))("yaml");
const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("dev merges cancel obsolete alpha runs while manual diagnostics stay isolated", () => {
  const config = workflow("alpha-macos-aarch64");
  const concurrency = (event, { signing_test = false, ref = "refs/heads/dev", sha = "old-merge" } = {}) => {
    const evaluate = (expression) => Function("github", "inputs", "format", `return ${expression};`)(
      { event_name: event, ref, sha }, { signing_test }, (pattern, value) => pattern.replace("{0}", value));
    const cancel = config.concurrency["cancel-in-progress"];
    return {
      group: config.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => evaluate(expression)),
      cancel: typeof cancel === "string" ? evaluate(cancel.slice(3, -2)) : cancel,
    };
  };
  const previous = concurrency("push");
  const latest = concurrency("push", { sha: "new-merge" });
  assert.equal(latest.group, previous.group);
  assert.equal(latest.cancel, true);

  const manual = concurrency("workflow_dispatch");
  assert.equal(manual.group, latest.group);
  assert.equal(manual.cancel, false);
  const diagnostic = concurrency("workflow_dispatch", { signing_test: true });
  assert.notEqual(diagnostic.group, latest.group);
  assert.equal(diagnostic.cancel, false);
  assert.notEqual(concurrency("workflow_dispatch", { signing_test: true, ref: "refs/heads/benchmark" }).group, diagnostic.group);
  const windows = workflow("alpha-windows-x64");
  assert.notEqual(windows.concurrency.group, latest.group);
  assert.equal(windows.concurrency["cancel-in-progress"], false);
});

test("dev merges share one signed producer and publish complete immutable alpha releases", () => {
  for (const name of ["alpha-macos-aarch64", "alpha-windows-x64"]) {
    const config = workflow(name);
    if (name === "alpha-macos-aarch64") assert.deepEqual(config.on.push.branches, ["dev"]);
    else assert.equal(config.on.push, undefined);
    assert.doesNotMatch(config.concurrency.group, /github.sha/);
    assert.equal(config.on.workflow_dispatch.inputs.sandbox_tests.default, false);
    assert.match(config.jobs["sandbox-runtime"].with.run_tests, /github.event_name == 'workflow_dispatch'/);
    const job = Object.values(config.jobs).find((job) => job.steps?.some(step => step.name === "Verify packaged startup"));
    assert.equal(config.jobs["opencode-engine"].if, "needs.changes.outputs.alpha == 'true'");
    const selected = (alpha, event, warm) => Function("needs", "github", "inputs", `return ${config.jobs["sandbox-runtime"].if};`)(
      { changes: { outputs: { alpha } } }, { event_name: event }, { warm_engine_cache: warm });
    for (const event of ["push", "workflow_dispatch"]) for (const warm of [false, true]) {
      assert.equal(selected("false", event, warm), false);
      assert.equal(selected("true", event, warm), !(name === "alpha-macos-aarch64" && event === "workflow_dispatch" && warm));
    }
    assert.ok(job.steps.some((step) => step.name === "Verify packaged startup"));
    const create = job.steps.find((step) => step.name === "Create immutable alpha prerelease").run;
    assert.match(create, /--draft/);
    const upload = job.steps.find((step) => step.name === "Upload Electron alpha updater assets").run;
    assert.match(upload, /preserve its immutable artifacts/);
    const publish = job.steps.find((step) => step.name === "Publish complete alpha").run;
    assert.match(publish, /--prerelease --latest=false/);
    assert.ok(!job.steps.some((step) => step.name === "Update alpha updater pointer"));
  }
  const combined = workflow("alpha-macos-aarch64");
  assert.ok(combined.jobs["publish-alpha-windows"].needs.includes("opencode-engine"));
  assert.ok(combined.jobs["publish-alpha-macos-aarch64"].needs.includes("opencode-engine"));
  assert.equal(Object.keys(combined.jobs).filter(name => name === "opencode-engine").length, 1);
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
