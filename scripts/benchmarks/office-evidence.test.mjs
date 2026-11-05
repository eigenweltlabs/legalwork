import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareOffice } from "./prepare-office.mjs";
import { evaluateOfficeExecution, evaluateSavedOfficeArtifact, inspectOfficePresentation } from "./office-evidence.mjs";
import { makeOfficePresentationParts, zipOfficeParts } from "./office-fixtures.mjs";
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { unzipSync, strToU8 } = require("fflate");

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-office-criteria-"));
  try { const prepared = await prepareOffice(path.join(root, "controller")); await run({ root, ...prepared }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function setCell(parts, part, address, value, formula) {
  let xml = Buffer.from(parts[part]).toString();
  const cell = `<c r="${address}" t="n">${formula ? `<f>${formula}</f>` : ""}<v>${value}</v></c>`;
  const existing = new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>[\\s\\S]*?<\\/c>`);
  if (existing.test(xml)) xml = xml.replace(existing, match => {
    const style = /\bs="([^"]+)"/.exec(match)?.[1];
    return style ? cell.replace(' t="n"', ` s="${style}" t="n"`) : cell;
  });
  else { const row = /\d+$/.exec(address)[0]; xml = xml.replace(new RegExp(`(<row\\b[^>]*\\br="${row}"[^>]*>)([\\s\\S]*?)(<\\/row>)`), `$1$2${cell}$3`); }
  parts[part] = strToU8(xml);
}
async function completedWorkbook(assertion) {
  const parts = unzipSync(await readFile(assertion.sourcePath));
  for (const [name, expected] of Object.entries(assertion.cells)) {
    const [sheet, address] = name.split("!"); setCell(parts, sheet === "Settlement" ? "xl/worksheets/sheet1.xml" : "xl/worksheets/sheet2.xml", address, expected.value, expected.formula);
  }
  return parts;
}

test("prepared Office inputs have two sheets/slides and keep criteria outside guest copyFiles", () => fixture(async ({ suite }) => {
  assert.equal(suite.tasks.length, 2);
  for (const task of suite.tasks) {
    assert.equal(task.copyFiles.length, 1);
    assert.match(task.copyFiles[0].to, /\.(xlsx|pptx)$/);
    assert.equal(task.beforePrompt[0].actionId, "documents.open");
  }
  const slides = inspectOfficePresentation(await readFile(suite.tasks[1].copyFiles[0].from)).slides;
  assert.equal(slides.length, 2); assert.ok(slides.every(slide => slide.notes.startsWith("Speaker note:")));
}));

test("XLSX saved-file criteria require formulas, recalculated caches and preservation", () => fixture(async ({ root, suite }) => {
  const assertion = suite.tasks[0].assertions.find(item => item.type === "artifact.office_xlsx");
  const parts = await completedWorkbook(assertion); await writeFile(path.join(root, assertion.path), zipOfficeParts(parts));
  assert.equal((await evaluateSavedOfficeArtifact(assertion, root)).passed, true);
  setCell(parts, "xl/worksheets/sheet1.xml", "B8", 1849.32, assertion.cells["Settlement!B8"].formula);
  await writeFile(path.join(root, assertion.path), zipOfficeParts(parts));
  assert.equal((await evaluateSavedOfficeArtifact(assertion, root)).passed, false, "Stale numeric caches cannot pass formula strings alone.");
  const constants = await completedWorkbook(assertion); setCell(constants, "xl/worksheets/sheet1.xml", "B8", 1893.7);
  await writeFile(path.join(root, assertion.path), zipOfficeParts(constants));
  assert.equal((await evaluateSavedOfficeArtifact(assertion, root)).passed, false, "Correct constants cannot replace requested formulas.");
  const corrupted = await completedWorkbook(assertion); setCell(corrupted, "xl/worksheets/sheet2.xml", "B3", 0);
  await writeFile(path.join(root, assertion.path), zipOfficeParts(corrupted));
  assert.equal((await evaluateSavedOfficeArtifact(assertion, root)).passed, false, "Unrelated source cells must survive.");
}));

function completedPresentation() {
  const parts = makeOfficePresentationParts();
  const edit = (name, transform) => { parts[name] = strToU8(transform(Buffer.from(parts[name]).toString())); };
  edit("ppt/slides/slide1.xml", xml => xml.replace("Renewal risk — draft", "Renewal risk — approved").replace("Current notice: 30 calendar days.", "Current notice: 45 calendar days.").replace('sz="2400"', 'sz="2700"'));
  parts["ppt/slides/slide3.xml"] = strToU8(Buffer.from(parts["ppt/slides/slide2.xml"]).toString().replace("Action checklist", "Next steps").replace("Verify signed amendment.", "Send renewal notice.").replace("Preserve source records.", "Retain the signed amendment."));
  parts["ppt/slides/_rels/slide3.xml.rels"] = parts["ppt/slides/_rels/slide2.xml.rels"];
  edit("ppt/presentation.xml", xml => xml.replace("</p:sldIdLst>", '<p:sldId id="258" r:id="rId5"/></p:sldIdLst>'));
  edit("ppt/_rels/presentation.xml.rels", xml => xml.replace("</Relationships>", '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/></Relationships>'));
  return parts;
}
test("PPTX saved criteria check ordered slide addition, title size and original notes/media", () => fixture(async ({ root, suite }) => {
  const assertion = suite.tasks[1].assertions.find(item => item.type === "artifact.office_pptx");
  const parts = completedPresentation(); await writeFile(path.join(root, assertion.path), zipOfficeParts(parts));
  assert.equal((await evaluateSavedOfficeArtifact(assertion, root)).passed, true);
  parts["ppt/notesSlides/notesSlide1.xml"] = strToU8('<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
  await writeFile(path.join(root, assertion.path), zipOfficeParts(parts));
  assert.equal((await evaluateSavedOfficeArtifact(assertion, root)).passed, false, "Changed original speaker notes must fail.");
  const wrongSize = completedPresentation(); wrongSize["ppt/slides/slide1.xml"] = strToU8(Buffer.from(wrongSize["ppt/slides/slide1.xml"]).toString().replace('sz="2700"', 'sz="2400"'));
  await writeFile(path.join(root, assertion.path), zipOfficeParts(wrongSize));
  assert.equal((await evaluateSavedOfficeArtifact(assertion, root)).passed, false, "Text-only edits cannot establish requested layout.");
}));

const context = { workspace: "/matter", executionDirectory: "/matter/task", ownedSessionIDs: ["session"] };
const criterion = { format: "xlsx", path: "settlement.xlsx", operations: [{ tool: "inapp_xlsx_read", input: { sheet: "Settlement", range: "B8:B10" }, result: { success: true, data: { values: [[1893.7], [129893.7], [132393.7]] } } }] };
const payload = { ok: true, result: { success: true, data: { values: [[1893.7], [129893.7], [132393.7]] } } };
const input = { path: "/matter/task/settlement.xlsx", sheet: "Settlement", range: "B8:B10" };
test("Office live criteria reject generated code, CodeMode status alone and domain failure", () => {
  const summary = { tools: [{ tool: "execute", messageID: "msg", callID: "code", state: { status: "completed", input: { code: "inapp_xlsx_read()" }, metadata: { toolCalls: [{ tool: "inapp_xlsx_read", input, status: "completed" }] } } }] };
  assert.equal(evaluateOfficeExecution(criterion, summary, context).passed, false);
  const direct = { tools: [{ tool: "inapp_xlsx_read", messageID: "msg", callID: "read", state: { status: "completed", input, output: JSON.stringify({ ok: true, result: { success: false, error: "Editor unavailable" } }) } }] };
  assert.equal(evaluateOfficeExecution(criterion, direct, context).passed, false);
  direct.tools[0].state.output = JSON.stringify(payload);
  assert.equal(evaluateOfficeExecution(criterion, direct, context).passed, true);
  direct.tools[0].state.input = { ...input, path: "/other/settlement.xlsx" };
  assert.equal(evaluateOfficeExecution(criterion, direct, context).passed, false);
});
test("Office native observer requires actual complete successful result and correct saved values", () => {
  const event = { phase: "after", status: "completed", sessionID: "session", callID: "actual-child", toolID: "inapp_xlsx_read", input, result: { output: JSON.stringify(payload) }, startedAt: "2026-10-25T00:00:00.000Z", completedAt: "2026-10-25T00:00:00.010Z", elapsedMs: 10 };
  assert.equal(evaluateOfficeExecution(criterion, { tools: [] }, { ...context, toolExecutions: [event] }).passed, true);
  assert.equal(evaluateOfficeExecution(criterion, { tools: [] }, { ...context, toolExecutions: [{ ...event, result: { output: "claimed success" } }] }).passed, false);
  assert.equal(evaluateOfficeExecution(criterion, { tools: [] }, { ...context, toolExecutions: [{ ...event, sessionID: "unrelated-session" }] }).passed, false);
  assert.equal(evaluateOfficeExecution(criterion, { tools: [] }, { ...context, toolExecutions: [{ ...event, result: { output: JSON.stringify({ ok: true, result: { success: true, data: { values: [[0], [0], [0]] } } }) } }] }).passed, false);
});
test("a final live read must actually occur after the successful edit", () => {
  const assertion = { ...criterion, operations: [{ ...criterion.operations[0], afterEdits: true }] };
  const read = { phase: "after", status: "completed", sessionID: "session", callID: "read", toolID: "inapp_xlsx_read", input, result: { output: JSON.stringify(payload) }, startedAt: 100, completedAt: 110 };
  const write = { ...read, callID: "write", toolID: "inapp_xlsx_write", result: { output: JSON.stringify({ ok: true, result: { success: true, saved: true } }) }, startedAt: 120, completedAt: 130 };
  assert.equal(evaluateOfficeExecution(assertion, { tools: [] }, { ...context, toolExecutions: [read, write] }).passed, false);
  assert.equal(evaluateOfficeExecution(assertion, { tools: [] }, { ...context, toolExecutions: [write, { ...read, startedAt: 140, completedAt: 150 }] }).passed, true);
});

test("actual V1 domain ok wrapper establishes success without manufacturing a raw success field", () => {
  const actual = { ok: true, result: { ok: true, document: { name: "settlement.xlsx" }, data: payload.result.data, saved: false } };
  const direct = { tools: [{ tool: "inapp_xlsx_read", messageID: "msg", callID: "read", state: { status: "completed", input, output: JSON.stringify(actual) } }] };
  const result = evaluateOfficeExecution(criterion, direct, context);
  assert.equal(result.passed, true);
  const match = result.evidence.operations[0].successfulMatches[0];
  assert.equal(match.serviceSuccessField, "ok");
  assert.deepEqual(match.result, actual.result);
  assert.equal("success" in match.result, false);
});

test("explicit false, malformed success flags and errors dominate any positive Office marker", () => {
  const variants = [
    { ok: true, result: { ok: true, success: false, data: payload.result.data } },
    { ok: true, result: { ok: false, success: true, data: payload.result.data } },
    { ok: false, result: { ok: true, data: payload.result.data } },
    { ok: true, success: false, result: { ok: true, data: payload.result.data } },
    { ok: true, success: "true", result: { ok: true, data: payload.result.data } },
    { ok: true, error: "Bridge failed", result: { ok: true, data: payload.result.data } },
    { ok: true, result: { ok: true, error: "Editor failed", data: payload.result.data } },
    { ok: true, result: { ok: true, error: "", data: payload.result.data } },
    { ok: true, result: { ok: true, success: "true", data: payload.result.data } },
    { ok: true, result: { data: payload.result.data } },
  ];
  for (const value of variants) {
    const event = { phase: "after", status: "completed", sessionID: "session", callID: "read", toolID: "inapp_xlsx_read", input, result: { output: JSON.stringify(value) }, startedAt: 100, completedAt: 110 };
    assert.equal(evaluateOfficeExecution(criterion, { tools: [] }, { ...context, toolExecutions: [event] }).passed, false);
  }
});

test("V1 ok writes still require saved true and calculated readback after the edit", () => {
  const assertion = { ...criterion, operations: [{ tool: "inapp_xlsx_write", input: { sheet: "Settlement" }, result: { success: true, saved: true } }, { ...criterion.operations[0], afterEdits: true }] };
  const write = { phase: "after", status: "completed", sessionID: "session", callID: "write", toolID: "inapp_xlsx_write", input, result: { output: JSON.stringify({ ok: true, result: { ok: true, saved: true } }) }, startedAt: 100, completedAt: 110 };
  const read = { ...write, callID: "read", toolID: "inapp_xlsx_read", result: { output: JSON.stringify({ ok: true, result: { ok: true, data: payload.result.data } }) }, startedAt: 120, completedAt: 130 };
  const evaluate = events => evaluateOfficeExecution(assertion, { tools: [] }, { ...context, toolExecutions: events });
  assert.equal(evaluate([write, read]).passed, true);
  assert.equal(evaluate([{ ...write, result: { output: JSON.stringify({ ok: true, result: { ok: true, saved: false } }) } }, read]).passed, false);
  assert.equal(evaluate([write, { ...read, startedAt: 90, completedAt: 95 }]).passed, false);
  assert.equal(evaluate([write, { ...read, result: { output: JSON.stringify({ ok: true, result: { ok: true, data: { values: [[0], [0], [0]] } } }) } }]).passed, false);
});
