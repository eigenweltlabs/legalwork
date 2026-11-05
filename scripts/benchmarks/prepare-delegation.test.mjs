import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDelegation } from "./prepare-delegation.mjs";
import { evaluateAssertions, sha256 } from "./evidence.mjs";

test("only original contract sources enter the guest; no rubric, agent/tool or recovery hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-delegation-"));
  try {
    const prepared = await prepareDelegation(join(root, "controller")), task = prepared.suite.tasks[0];
    assert.equal(task.copyFiles.length, 5);
    assert.deepEqual((await readdir(join(prepared.root, "source-only"))).sort(), prepared.files.map(file => file.name).sort());
    for (const file of prepared.files) assert.equal(sha256(await readFile(file.path)), file.sha256);
    assert.ok(task.prompt.includes("two independent delegated reviewers"));
    for (const hint of ["subagent_type", "general agent", "subagent", "task_id", "tool", "/home/", "480000", "2026-11-16", "17:00"])
      assert.equal(task.prompt.includes(hint), false, hint);
    assert.deepEqual(task.assertions.filter(item => item.scope === "subtree").map(item => item.type), ["agent.no_error", "capability.delegation"]);
    assert.equal(prepared.suite.model.variant, "medium");
    assert.deepEqual(prepared.suite.interactionPolicy, { mode: "scripted-external-directory-decline", expectedPermissions: [], expectedForms: [], outsideTaskFolder: "reject", otherRequests: "hold" });
    assert.equal(prepared.suite.catalogPolicy, "record-and-lock-observed");
    assert.equal(JSON.stringify(prepared.suite).includes("taskTimeoutMs"), false);
    await assert.rejects(() => prepareDelegation(prepared.root), { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("untouched and substantively incorrect artifacts fail; chronology/cap arithmetic are independently checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-delegation-grade-"));
  try {
    const prepared = await prepareDelegation(join(root, "controller")), task = prepared.suite.tasks[0];
    const assertions = task.assertions.filter(item => ["artifact.json", "artifact.text", "artifact.sha256"].includes(item.type));
    const source = join(prepared.root, "source-only");
    assert.equal((await evaluateAssertions(assertions, source, [], {})).filter(item => item.passed).length, 5);
    const exact = task.assertions.find(item => item.type === "artifact.json").equals;
    const check = async value => { await writeFile(join(source, "decision.json"), JSON.stringify(value)); return (await evaluateAssertions(assertions, source, [], {}))[0].passed; };
    assert.equal(await check(exact), true);
    for (const change of [{ notice_days: 60 }, { notice_deadline: "2026-11-17" }, { proposed_notice_is_timely: true },
      { ordinary_cap_eur: 100000 }, { data_incident_cap_eur: 240000 }, { planning_loss_above_data_cap_eur: 0 },
      { incident_notification_hours: 72 }, { uncapped_exception: "all data incidents" }, { data_cap_quote: "Liability is probably unlimited." },
      { controlling_notice: "AMENDMENT-2025-A section 2" }]) assert.equal(await check({ ...exact, ...change }), false);
    // Date subtraction and arithmetic are checked independently of model output.
    assert.equal(new Date(Date.parse("2026-12-31T00:00:00Z") - 45 * 86400000).toISOString().slice(0, 10), exact.notice_deadline);
    assert.equal(exact.data_incident_cap_eur, 2 * exact.ordinary_cap_eur);
    assert.equal(exact.planning_loss_above_data_cap_eur, 500000 - exact.data_incident_cap_eur);
    await check(exact);
    await writeFile(join(source, "board-note.md"), "AMENDMENT-2026-B section 2; AMENDMENT-2025-A section 3; DPA-2025 section 9; wilful misconduct");
    assert.ok((await evaluateAssertions(assertions, source, [], {})).every(item => item.passed));
    await writeFile(prepared.files[0].path, "changed source");
    assert.equal((await evaluateAssertions(assertions, source, [], {})).at(2).passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
