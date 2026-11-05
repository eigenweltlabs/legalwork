import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRuns, evaluateAssertions, inside, privateWrite, summarizeMessages } from "./evidence.mjs";
import { extractFullArtifact, makeWordFixture } from "./artifacts.mjs";
import { responseUsage } from "./protocol.mjs";

test("all model turns and exact tool arguments/results contribute to traces, cache remains distinct", () => {
  const text = "full tool result ".repeat(10000) + "TAIL-EVIDENCE";
  const entries = [1, 2, 3].map(index => ({ info: { id: `msg-${index}`, role: "assistant", modelID: "fixture", providerID: "fixture", cost: index / 100, tokens: { input: index * 100, output: index * 10, reasoning: index, cache: { read: index * 50, write: index * 5 } } }, parts: [{ id: `part-${index}`, type: "tool", tool: "read", state: { status: "completed", input: { path: "source.txt" }, output: text } }] }));
  const summary = summarizeMessages(entries);
  assert.deepEqual(summary.totals, { input: 600, output: 60, reasoning: 6, cacheRead: 300, cacheWrite: 30 });
  assert.equal(summary.reportedEngineCost, 0.06);
  assert.equal(summary.tools[2].state.output, text);
  assert.equal(summary.assistantMessages.length, 3);
  assert.throws(() => summarizeMessages([entries[0], entries[0]]), /Duplicate/);
});

test("a gained criterion cannot hide a lost or missing baseline pass", () => {
  const metadata = { kind: "real-electron-real-engine-regression", finishedAt: "fixture", evidenceComplete: true, identity: { suiteSha256: "same-suite", model: { modelID: "fixture" } }, preflight: { build: { serverTreeSha256: "fixture-build" }, git: { head: "fixture-source" } }, settings: {} };
  const baseline = { ...metadata, items: [{ id: "nda", identity: "same-task", status: "completed", assertions: [{ id: "supported-risk", passed: true }, { id: "other-risk", passed: false }] }] };
  const candidate = { ...metadata, items: [{ id: "nda", identity: "same-task", status: "completed", assertions: [{ id: "supported-risk", passed: false }, { id: "other-risk", passed: true }] }] };
  assert.equal(compareRuns(baseline, candidate).passed, false);
  assert.equal(compareRuns(baseline, candidate).regressions[0].assertion, "supported-risk");
  assert.equal(compareRuns(baseline, { ...candidate, items: [] }).state, "incomparable");
  assert.equal(compareRuns(baseline, { ...candidate, identity: { ...metadata.identity, suiteSha256: "different-suite" } }).state, "incomparable");
  const failed = { ...baseline, items: [{ ...baseline.items[0], assertions: [{ id: "supported-risk", passed: false }] }] };
  assert.equal(compareRuns(failed, failed).state, "inconclusive");
  const partial = { ...baseline, coverage: { pending: ["Word"] } };
  assert.equal(compareRuns(partial, partial).state, "partial-coverage");
  assert.equal(compareRuns(partial, partial).passed, false);
  const nonBlind = { ...baseline, items: [{ ...baseline.items[0], evaluation: { blinding: "non-blind", reason: "grading guide ships in product" } }] };
  assert.deepEqual(compareRuns(nonBlind, nonBlind).nonBlindTasks, ["nda"]);
  assert.deepEqual(compareRuns(baseline, nonBlind).nonBlindTasks, ["nda"]);
  assert.equal(compareRuns(nonBlind, { ...candidate, items: [{ ...candidate.items[0], evaluation: nonBlind.items[0].evaluation }] }).regressions[0].assertion, "supported-risk");
});

test("private evidence and artifact evaluation retain full tails beyond existing 80k preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-benchmark-evidence-"));
  try {
    const source = "opening ".repeat(14000) + "TAIL-EVIDENCE";
    await privateWrite(join(root, "source.txt"), source);
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), source);
    if (process.platform !== "win32") assert.equal((await stat(join(root, "source.txt"))).mode & 0o777, 0o600);
    const result = await evaluateAssertions([{ id: "tail", type: "artifact.text", path: "source.txt", includes: ["TAIL-EVIDENCE"] }], root, [], {});
    assert.equal(result[0].passed, true);
    await privateWrite(join(root, "source.docx"), makeWordFixture([source]));
    const extracted = await extractFullArtifact(join(root, "source.docx"));
    assert.ok(extracted.text.length > 80000);
    assert.ok(extracted.text.endsWith("TAIL-EVIDENCE\n"));
    assert.ok(extracted.xml["word/document.xml"].includes("TAIL-EVIDENCE"));
    assert.throws(() => inside(root, "../private"), /escapes/);
    assert.throws(() => inside(root, "/absolute"), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native SSE handles CRLF, cumulative output, cache usage and signed-state opaque frames", () => {
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 } } },
    { type: "content_block_start", content_block: { type: "thinking", signature: "fixture-opaque" } },
    { type: "message_delta", usage: { output_tokens: 10 } },
    { type: "message_delta", usage: { output_tokens: 19 } },
    { type: "message_stop" },
  ].map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("");
  const usage = responseUsage(frames, "anthropic");
  assert.equal(usage.input, 7);
  assert.equal(usage.cacheRead, 1000);
  assert.equal(usage.cacheWrite, 20);
  assert.equal(usage.output, 19);
  assert.equal(usage.complete, true);
  assert.equal(responseUsage(frames.replace('data: {"type":"message_stop"}\r\n\r\n', ""), "anthropic").complete, false);
});

test("explicit Ltd suffix punctuation normalization preserves party identity and substantive legal terms", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-semantic-assertion-"));
  try {
    const assertion = { id: "semantic-counterparty", type: "artifact.json", path: "result.json", normalizers: { counterparty: "ltd-suffix-period" }, equals: { counterparty: "Northstar Test Distribution Ltd.", governing_law: "England and Wales" } };
    await privateWrite(join(root, "result.json"), { counterparty: "Northstar Test Distribution Ltd", governing_law: "England and Wales" });
    assert.equal((await evaluateAssertions([assertion], root, [], {}))[0].passed, true);
    await privateWrite(join(root, "result.json"), { counterparty: "Different Distribution Ltd", governing_law: "England and Wales" });
    assert.equal((await evaluateAssertions([assertion], root, [], {}))[0].passed, false);
    await privateWrite(join(root, "result.json"), { counterparty: "Northstar Test Distribution Ltd", governing_law: "Scotland" });
    assert.equal((await evaluateAssertions([assertion], root, [], {}))[0].passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("open-document evidence requires the exact task artifact and actual workspace, not a matching basename",async()=> {
  const workspace=join(tmpdir(),"legalwork-fixture-project");
  const directory=join(workspace,"run/task");
  const assertion={id:"exact-document",type:"ui.document_open",path:"agreement.docx"};
  const context={workspace,workspaceID:"workspace"};
  const evaluate=openFiles=>evaluateAssertions([assertion],directory,[],{openFiles},context).then(results=>results[0]);
  assert.equal((await evaluate([{path:"old-task/agreement.docx",workspaceId:"workspace"}])).passed,false);
  assert.equal((await evaluate([{path:"run/task/agreement.docx",workspaceId:"other-workspace"}])).passed,false);
  assert.equal((await evaluate([{path:"run/task/agreement.docx",workspaceId:"workspace"}])).passed,true);
  assert.equal((await evaluate([{path:join(directory,"agreement.docx"),workspaceId:"workspace"}])).passed,true);
  assert.equal((await evaluateAssertions([assertion],directory,[],{openFiles:[]}))[0].passed,false);
});


test("subtree assertions opt into only the explicitly collected owned child messages",async()=>{
 const root=[{info:{id:"root",role:"assistant"},parts:[]}];
 const child={info:{id:"child",role:"assistant",error:{name:"fixture-failure"}},parts:[{type:"tool",id:"call",tool:"fixture_read",state:{status:"completed",input:{},output:"complete"}}]};
 const results=await evaluateAssertions([{id:"root-tool",type:"capability.tool",names:["fixture_read"]},{id:"child-tool",type:"capability.tool",scope:"subtree",names:["fixture_read"]},{id:"root-error",type:"agent.no_error"},{id:"child-error",type:"agent.no_error",scope:"subtree"}],"/tmp",root,{}, {subtreeMessages:[...root,child]});
 assert.deepEqual(results.map(result=>result.passed),[false,true,true,false]);
 assert.equal((await evaluateAssertions([{id:"absent",type:"capability.tool",scope:"subtree",names:["fixture_read"]}],"/tmp",root,{}))[0].passed,false);
});
