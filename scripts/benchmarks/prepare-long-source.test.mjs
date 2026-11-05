import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareLongSource } from "./prepare-long-source.mjs";
import { evaluateAssertions, privateWrite, sha256 } from "./evidence.mjs";

test("long-source fixture keeps controlling evidence beyond a one-MiB preview and exposes only source bytes to the agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-long-source-"));
  try {
    const prepared = await prepareLongSource(join(root, "controller"));
    const bytes = await readFile(prepared.source);
    const task = prepared.suite.tasks[0];
    assert.deepEqual(prepared.suite.interactionPolicy, { mode: "autonomous", expectedPermissions: [], expectedForms: [] });
    const expected = task.assertions.find(assertion => assertion.type === "artifact.json").equals;
    assert.ok(bytes.length > 1024 * 1024);
    assert.ok(bytes.indexOf(Buffer.from(expected.source_quote)) > 1024 * 1024);
    assert.equal(bytes.subarray(0, 1024 * 1024).includes(Buffer.from(expected.source_quote)), false);
    assert.equal(bytes.subarray(0, 1024 * 1024).includes(Buffer.from(expected.archive_verification_record)), false);
    assert.ok(bytes.includes(Buffer.from("30 calendar days")));
    assert.ok(bytes.includes(Buffer.from("45 calendar days")));
    assert.equal(task.source.sha256, sha256(bytes));
    assert.deepEqual(await readdir(join(root, "controller/source-only")), ["agreement-archive.txt"]);
    assert.deepEqual(task.copyFiles, [{ from: prepared.source, to: "agreement-archive.txt" }]);
    assert.equal(task.prompt.includes(expected.source_quote), false);
    assert.equal(task.prompt.includes(expected.archive_verification_record), false);
    assert.equal(task.prompt.includes("75"), false);
    await assert.rejects(() => prepareLongSource(join(root, "controller")), { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("long-source legal assertions reject the earlier amendment and fabricated source quotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-long-source-verdict-"));
  try {
    const { suite, source } = await prepareLongSource(join(root, "controller"));
    const assertions = suite.tasks[0].assertions.filter(assertion => assertion.type === "artifact.json");
    const expected = assertions[0].equals;
    const workspace = join(root, "agent");
    const sourceAssertions = suite.tasks[0].assertions.filter(assertion => assertion.type === "artifact.sha256");
    await privateWrite(join(workspace, "agreement-archive.txt"), await readFile(source));
    assert.equal((await evaluateAssertions(sourceAssertions, workspace, [], {}))[0].passed, true);
    await privateWrite(join(workspace, "notice-review.json"), expected);
    assert.equal((await evaluateAssertions(assertions, workspace, [], {}))[0].passed, true);
    await privateWrite(join(workspace, "notice-review.json"), { ...expected, notice_days: 45, controlling_document: "AMENDMENT-2025-A" });
    assert.equal((await evaluateAssertions(assertions, workspace, [], {}))[0].passed, false);
    await privateWrite(join(workspace, "notice-review.json"), { ...expected, source_quote: "The period is probably 75 days." });
    assert.equal((await evaluateAssertions(assertions, workspace, [], {}))[0].passed, false);
    await privateWrite(join(workspace, "agreement-archive.txt"), "Agent replaced the source to match its answer.");
    assert.equal((await evaluateAssertions(sourceAssertions, workspace, [], {}))[0].passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
