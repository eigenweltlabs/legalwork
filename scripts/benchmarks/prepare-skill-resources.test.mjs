import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSkillResources, RESOURCE_SKILL_NAME, RESOURCE_SKILL_PATH } from "./prepare-skill-resources.mjs";
import { evaluateAssertions, privateWrite, readJson, sha256 } from "./evidence.mjs";

test("portable source-only skill package is frozen, reproducible and keeps decisive tail facts off the prompt/instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-portable-skill-"));
  try {
    const prepared = await prepareSkillResources(join(root, "controller"));
    const task = prepared.suite.tasks[0];
    const expected = task.assertions.find(item => item.type === "artifact.json").equals;
    const skill = await readFile(join(prepared.skillRoot, "SKILL.md"), "utf8");
    const resource = await readFile(join(prepared.skillRoot, RESOURCE_SKILL_PATH), "utf8");
    const invocation = task.assertions.find(item => item.type === "capability.skill_resource");
    assert.equal(invocation.tail.sha256, sha256(resource.slice(invocation.tail.start, invocation.tail.end)));
    assert.equal(task.prompt.includes(invocation.tail.sha256), false);
    for (const fact of [expected.general_source_quote, expected.exception_source_quote, expected.archive_verification_record, expected.future_document]) {
      assert.ok(resource.indexOf(fact) > 24000);
      assert.equal(task.prompt.includes(fact), false);
      assert.equal(skill.includes(fact), false);
    }
    for (const answer of ["60", "90", "120"]) { assert.equal(task.prompt.includes(answer), false); assert.equal(skill.includes(answer), false); }
    assert.equal(task.files, undefined); assert.equal(task.copyFiles, undefined);
    assert.deepEqual(task.assertions.filter(item => item.scope === "subtree").map(item => item.type), ["agent.no_error", "capability.skill_resource"]);
    const installation = await readJson(prepared.installPayloadPath);
    assert.equal(installation.method, "installSkillFiles");
    assert.equal(installation.args[0], ""); assert.equal(installation.args[1], RESOURCE_SKILL_NAME);
    assert.deepEqual(installation.args[3], { overwrite: false });
    assert.deepEqual(installation.args[2].map(file => file.path), ["SKILL.md", RESOURCE_SKILL_PATH]);
    for (const file of installation.args[2]) {
      assert.equal(file.executable, false);
      const actual = await readFile(join(prepared.skillRoot, file.path));
      assert.deepEqual(Buffer.from(file.contentBase64, "base64"), actual);
      assert.deepEqual(prepared.files.find(item => item.path === file.path), { path: file.path, bytes: actual.length, sha256: sha256(actual) });
      assert.equal((await stat(join(prepared.skillRoot, file.path))).mode & 0o777, 0o400);
    }
    assert.equal((await readJson(join(prepared.root, "fixture-receipt.json"))).status, "prepared-not-installed-not-real-agent-executed");
    assert.equal((await stat(prepared.root)).mode & 0o777, 0o700);
    await assert.rejects(() => prepareSkillResources(prepared.root), { code: "EEXIST" });
    const repeat = await prepareSkillResources(join(root, "other-controller"));
    assert.deepEqual(prepared.files, repeat.files);
    assert.deepEqual(prepared.suite, repeat.suite);
    assert.deepEqual(await readFile(prepared.installPayloadPath), await readFile(repeat.installPayloadPath));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill artifact criteria reject missing tail, fabricated chronology and an overbroad category exception", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-skill-verdict-"));
  try {
    const prepared = await prepareSkillResources(join(root, "controller"));
    const assertions = prepared.suite.tasks[0].assertions.filter(item => item.type === "artifact.json");
    const expected = assertions[0].equals;
    const mirror = join(root, "guest-mirror");
    const verdict = async value => { await privateWrite(join(mirror, "skill-renewal-review.json"), value); return (await evaluateAssertions(assertions, mirror, [], {}))[0].passed; };
    assert.equal(await verdict(expected), true);
    for (const changed of [
      { general_equipment_notice_days: 45 }, { general_equipment_notice_days: 120 },
      { public_hospital_cold_chain_notice_days: 60 }, { private_clinic_cold_chain_notice_days: 90 },
      { general_source_quote: "The operative period seems to be 60 days." }, { exception_source_quote: "Cold-chain contracts require 90 days." },
      { superseded_notice_days: [45, 30] }, { controlling_document: "AMENDMENT-SR-2025" },
      { future_effective_date: "2026-10-20" }, { archive_verification_record: "invented" }, { source_resource: "resources/other.md" },
    ]) assert.equal(await verdict({ ...expected, ...changed }), false);
    assert.equal(await verdict({}), false);
    assert.deepEqual(await readdir(mirror), ["skill-renewal-review.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("implicit relevance task relies on the normal skill catalog without naming the skill or tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-skill-implicit-"));
  try {
    const explicit = await prepareSkillResources(join(root, "explicit"));
    const implicit = await prepareSkillResources(join(root, "implicit"), { invocation: "implicit" });
    const task = implicit.suite.tasks[0];
    assert.notEqual(implicit.suite.id, explicit.suite.id);
    assert.notEqual(task.id, explicit.suite.tasks[0].id);
    assert.match(task.prompt, /firm's supplied synthetic renewal archive/);
    for (const hidden of [RESOURCE_SKILL_NAME, "legalwork_skill_load", "legalwork_skill_read", RESOURCE_SKILL_PATH]) assert.equal(task.prompt.includes(hidden), false);
    assert.deepEqual(implicit.files, explicit.files);
    assert.deepEqual(await readFile(implicit.installPayloadPath), await readFile(explicit.installPayloadPath));
    assert.deepEqual(task.assertions, explicit.suite.tasks[0].assertions);
    const source = await readFile(join(implicit.skillRoot, "SKILL.md"), "utf8");
    assert.match(source, /description: Use when reviewing a supplied synthetic renewal archive/);
    const expected = task.assertions.find(item => item.type === "artifact.json").equals;
    for (const hidden of [expected.general_source_quote, expected.exception_source_quote, expected.future_document, expected.archive_verification_record]) assert.equal(task.prompt.includes(hidden), false);
    const receipt = await readJson(join(implicit.root, "fixture-receipt.json"));
    assert.equal(receipt.invocation, "implicit");
    assert.ok(receipt.caveats.some(item => item.includes("previous answers")));
    await assert.rejects(() => prepareSkillResources(join(root, "invalid"), { invocation: "unknown" }), /invocation must/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
