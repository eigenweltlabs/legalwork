import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDelegationExecution, refreshDelegationTree } from "./delegation-evidence.mjs";
import { summarizeMessages, evaluateAssertions } from "./evidence.mjs";

const criterion = { id: "two-real-reviewers", type: "capability.delegation", scope: "subtree", minimumDirectChildren: 2 };
function fixture(protocol = "legacy-v1", background = false) {
  const root = "root", children = ["notice", "liability"], tool = protocol === "native-v2" ? "subagent" : "task";
  const sessionTree = [{ requestedParentID: null, session: { id: root } },
    ...children.map(id => ({ requestedParentID: root, session: { id, parentID: root, outcome: "succeeded" } }))];
  const messages = [], records = [];
  for (const [index, child] of children.entries()) {
    const call = `call-${index}`, input = protocol === "native-v2"
      ? { agent: "general", description: child, prompt: `Review ${child}`, ...(background ? { background: true } : {}) }
      : { subagent_type: "general", description: child, prompt: `Review ${child}`, ...(background ? { background: true } : {}) };
    const status = background ? "running" : "completed";
    const result = protocol === "native-v2"
      ? { output: { sessionID: child, status, output: `Review ${child} returned` }, metadata: { sessionID: child, status } }
      : { title: child, output: `<task id="${child}" state="${status}">\n<task_result>Review ${child} returned</task_result>\n</task>`, metadata: { parentSessionId: root, sessionId: child, model: { providerID: "fixture", modelID: "normal-child" } } };
    const part = protocol === "native-v2"
      ? { type: "tool", id: call, name: tool, state: { status: "completed", input } }
      : { type: "tool", id: `part-${index}`, callID: call, tool, state: { status: "completed", input } };
    messages.push(protocol === "native-v2"
      ? { id: `root-${index}`, type: "assistant", benchmarkRequestedSessionID: root, time: { completed: 3 }, content: [part] }
      : { info: { id: `root-${index}`, role: "assistant", sessionID: root, time: { completed: 3 } }, parts: [part] });
    // Equal message IDs across independent sessions are legitimate.
    messages.push(protocol === "native-v2"
      ? { id: "same-child-message-id", type: "assistant", benchmarkRequestedSessionID: child, time: { completed: 2 },
        model: { providerID: "ordinary", id: child === "notice" ? "child-a" : "child-b", variant: "default" },
        content: [{ type: "text", text: `A substantive source-cited ${child} review.` }] }
      : { info: { id: "same-child-message-id", role: "assistant", sessionID: child, time: { completed: 2 }, providerID: "ordinary", modelID: child === "notice" ? "child-a" : "child-b" },
        parts: [{ type: "text", text: `A substantive source-cited ${child} review.` }] });
    records.push({ observerInstance: "root-owned-observer", sequence: index + 2, phase: "after", status: "completed",
      sessionID: root, ...(protocol === "native-v2" ? { messageID: `root-${index}` } : {}), id: call, tool, input, result });
  }
  const context = { engineProtocol: protocol, rootSessionID: root, ownedSessionIDs: [root, ...children], sessionTree,
    subtreeMessages: messages, subtreeActivity: { active: {}, inboxBySessionID: { root: [], notice: [], liability: [] }, unsettledSessionIDs: [] },
    toolTraceCompleteness: { captureIntegrityVerified: true, completeAsExposed: true }, toolExecutions: records };
  return { context, messages, summary: summarizeMessages(messages) };
}
const verdict = f => evaluateDelegationExecution(criterion, f.summary, f.context);
const passes = f => { try { return verdict(f).passed; } catch { return false; } };

test("source-shaped V1 and native two-child returns prove distinct reviews without forcing child models", () => {
  for (const protocol of ["legacy-v1", "native-v2"]) for (const background of [false, true]) {
    const f = fixture(protocol, background), result = verdict(f);
    assert.equal(result.passed, true);
    assert.deepEqual(result.evidence.distinctProvenDirectChildren.map(child => child.childID), ["notice", "liability"]);
    assert.equal(new Set(result.evidence.distinctProvenDirectChildren.flatMap(child => child.actualModels.map(model => model.modelID))).size, 2);
    assert.equal(result.evidence.distinctProvenDirectChildren[0].actualAfter.elapsedMs, null);
  }
});

test("claimed metadata, wrong AFTER values/identities and missing success never establish delegation", () => {
  for (const protocol of ["legacy-v1", "native-v2"]) for (const change of [
    f => { f.context.toolExecutions.length = 1; },
    f => { delete f.context.toolExecutions[1].result; },
    f => { f.context.toolExecutions[1].status = "error"; },
    f => { f.context.toolExecutions[1].error = "failed"; },
    f => { f.context.toolExecutions[1].sessionID = "notice"; },
    f => { f.context.toolExecutions[1].messageID = "another-message"; },
    f => { f.context.toolExecutions[1].id = "another-call"; },
    f => { f.context.toolExecutions[1].input = { prompt: "different" }; },
    f => { f.context.toolExecutions[1].sequence = 0; },
    f => { f.context.toolExecutions[1].observerInstance = ""; },
    f => { f.context.toolExecutions.push(structuredClone(f.context.toolExecutions[1])); },
    f => { f.context.toolExecutions[1].result.metadata = {}; },
    f => { const result = f.context.toolExecutions[1].result; if (protocol === "native-v2") result.output.sessionID = "notice"; else result.output = result.output.replace('id="liability"', 'id="notice"'); },
    f => { f.context.toolTraceCompleteness.captureIntegrityVerified = false; },
    f => { f.context.toolTraceCompleteness.completeAsExposed = false; },
    f => { delete f.summary.tools[1].messageID; },
  ]) { const f = fixture(protocol); change(f); assert.equal(passes(f), false); }
});

test("public ownership, actual completion and exact per-session histories fail closed", () => {
  for (const protocol of ["legacy-v1", "native-v2"]) for (const change of [
    f => { f.context.sessionTree[2].session.parentID = "foreign"; },
    f => { f.context.sessionTree[2].requestedParentID = "notice"; },
    f => { f.context.sessionTree.push(structuredClone(f.context.sessionTree[2])); },
    f => { f.context.sessionTree.pop(); },
    f => { f.context.ownedSessionIDs.push("foreign"); },
    f => { f.context.subtreeMessages = f.context.subtreeMessages.filter(entry => (entry.benchmarkRequestedSessionID ?? entry.info?.sessionID) !== "liability"); },
    f => { const entry = f.context.subtreeMessages.at(-1); (entry.info ?? entry).time = {}; },
    f => { const entry = f.context.subtreeMessages.at(-1); delete (entry.info ?? entry).id; },
    f => { const entry = f.context.subtreeMessages.at(-1); (entry.info ?? entry).time = { completed: "not-a-time" }; },
    f => { const entry = f.context.subtreeMessages.at(-1); (entry.info ?? entry).error = { message: "cancelled" }; },
    f => { const entry = f.context.subtreeMessages.at(-1); (entry.content ?? entry.parts)[0].text = ""; },
    f => { f.context.sessionTree[2].session.outcome = "interrupted"; },
    f => { f.context.subtreeActivity.unsettledSessionIDs = ["liability"]; },
    f => { f.context.subtreeActivity.active.liability = { type: protocol === "native-v2" ? "running" : "busy" }; },
    f => { f.context.subtreeActivity.inboxBySessionID.liability = [{ id: "accepted" }]; },
    f => { delete f.context.subtreeActivity.inboxBySessionID.liability; },
    f => { const entry = f.context.subtreeMessages.at(-1); entry.benchmarkRequestedSessionID = "notice"; (entry.info ?? entry).sessionID = "liability"; },
  ]) { const f = fixture(protocol); change(f); assert.equal(passes(f), false); }
});

test("finish between history and activity reads requires a fresh settled history and rechecked activity", async () => {
  const f = fixture("native-v2"); let finished = false, queued = false;
  const protocol = {
    session: async () => f.context.sessionTree[0].session,
    sessions: async parentID => f.context.sessionTree.filter(row => row.requestedParentID === parentID).map(row => row.session),
    messages: async id => {
      const entries = structuredClone(f.context.subtreeMessages.filter(entry => entry.benchmarkRequestedSessionID === id));
      if (id === "liability" && !finished) { delete entries[0].time.completed; entries[0].content = []; finished = true; }
      return entries;
    },
    active: async () => ({}),
    inbox: async id => queued && id === "liability" ? [{ id: "newly-admitted" }] : [],
    isBusy: (active, id) => active[id]?.type === "running",
  };
  const bind = snapshot => ({ ...f.context, sessionTree: snapshot.sessionTree, subtreeMessages: snapshot.messages,
    ownedSessionIDs: snapshot.ownedSessionIDs, subtreeActivity: snapshot.activity });
  const before = await refreshDelegationTree(protocol, "root");
  assert.deepEqual(before.activity.unsettledSessionIDs, []);
  assert.equal(evaluateDelegationExecution(criterion, f.summary, bind(before)).passed, false);
  const after = await refreshDelegationTree(protocol, "root");
  assert.equal(evaluateDelegationExecution(criterion, f.summary, bind(after)).passed, true);
  assert.equal(before.messages.at(-1).time.completed, undefined, "Earlier snapshot must remain unchanged");
  queued = true;
  const pending = await refreshDelegationTree(protocol, "root");
  assert.deepEqual(pending.activity.unsettledSessionIDs, ["liability"]);
  assert.throws(() => evaluateDelegationExecution(criterion, f.summary, bind(pending)), /settled/);
});

test("resume calls count a child once; V1 command-subtask identity is source-backed and task-only", () => {
  const f = fixture();
  f.context.toolExecutions[1].result = structuredClone(f.context.toolExecutions[0].result);
  assert.equal(verdict(f).passed, false);
  assert.equal(verdict(f).evidence.distinctProvenDirectChildren.length, 1);
  const command = fixture();
  command.context.toolExecutions.forEach((event, index) => { event.id = `part-${index}`; });
  assert.equal(verdict(command).passed, true);
  command.context.toolExecutions[1].id = "unrelated-part";
  assert.equal(verdict(command).passed, false);
});

test("additive dispatch requires explicit subtree and leaves historical root tool semantics unchanged", async () => {
  const f = fixture(), root = f.messages.filter(entry => entry.info?.sessionID === "root");
  const [delegated, historical] = await evaluateAssertions([criterion,
    { id: "root-task", type: "capability.tool", names: ["task"] }], "/unused", root, {}, f.context);
  assert.equal(delegated.passed, true); assert.equal(historical.passed, true);
  const rootOnly = { ...f.context, subtreeMessages: root };
  assert.equal((await evaluateAssertions([criterion], "/unused", root, {}, rootOnly))[0].passed, false);
  const noScope = { ...criterion }; delete noScope.scope;
  assert.equal((await evaluateAssertions([noScope], "/unused", root, {}, f.context))[0].passed, false);
  assert.equal((await evaluateAssertions([noScope], "/unused", root, {}, { ...f.context, subtreeMessages: undefined }))[0].passed, false);
});
