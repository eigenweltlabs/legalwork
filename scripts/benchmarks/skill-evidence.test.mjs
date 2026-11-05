import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSkillResourceExecution } from "./skill-evidence.mjs";
import { evaluateAssertions, sha256, summarizeMessages } from "./evidence.mjs";

const name = "benchmark-portable-renewal-review";
const resourcePath = "resources/renewal-archive.md";
const files = [{ path: "SKILL.md", bytes: 700, sha256: "a".repeat(64) }, { path: resourcePath, bytes: 100000, sha256: "b".repeat(64) }];
const assertion = { type: "capability.skill_resource", name, resourcePath, files, requireContinuation: true, resourceCharacters: 100000, tail: { start: 98000, end: 100000, sha256: sha256("s".repeat(2000)) } };
const context = { skillInstallations: [{ name, scope: "global", directory: "/home/legalwork/library/skills/benchmark-portable-renewal-review", verifiedAt: "2026-10-25T01:00:00Z", method: "actual-installed-file-bytes", files }] };
const input = (tool, offset) => tool === "legalwork_skill_load" ? { name } : { name, path: resourcePath, ...(offset === undefined ? {} : { offset }) };
const payload = tool => tool === "legalwork_skill_load" ? { chain: [{ name, directory: context.skillInstallations[0].directory, files }] } : { path: resourcePath, content: "s".repeat(4000), totalCharacters: 100000, complete: true };
const direct = (tool, protocol, offset) => ({ tool, messageID: "msg_actual", callID: `${tool}_${offset ?? 0}`, protocol,
  state: { status: "completed", input: input(tool, offset), ...(protocol === "legacy-v1" ? { output: JSON.stringify({ ok: true, payload: payload(tool) }) } : { content: [{ type: "text", text: JSON.stringify({ ok: true, payload: payload(tool) }) }] }) } });
const child = (tool, offset) => ({ tool, input: input(tool, offset), status: "completed" });
const execute = children => ({ tool: "execute", sessionID: "ses_owned", messageID: "msg_actual", callID: "call_actual", protocol: "native-v2", state: { status: "completed", input: { code: "arbitrary text is never invocation evidence" }, content: [{ type: "text", text: "computed result" }], metadata: { toolCalls: children } } });
const observation = (tool, offset, result = { output: { ok: true, payload: payload(tool) } }) => ({ observerInstance: "actual-observer", sequence: tool === "legalwork_skill_load" ? 2 : 4, phase: "after", sessionID: "ses_owned", messageID: "msg_actual", id: "call_actual", tool, input: input(tool, offset), status: "completed", result });
context.ownedSessionIDs = ["ses_owned"];
context.toolExecutions = [observation("legalwork_skill_load"), observation("legalwork_skill_read", 96000)];
const check = (tools, override = context) => evaluateSkillResourceExecution(assertion, { tools }, override).passed;

test("completed native metadata cannot turn a service failure or an absent child result into a successful resource read", () => {
  const tools = [execute([child("legalwork_skill_load"), child("legalwork_skill_read", 96000)])];
  const failed = { ...context, ownedSessionIDs: ["ses_owned"], toolExecutions: [observation("legalwork_skill_load"), observation("legalwork_skill_read", 96000, { output: { ok: false, error: "Synthetic service unavailable" } })] };
  assert.equal(check(tools, failed), false);
  assert.equal(check(tools, { ...context, ownedSessionIDs: ["ses_owned"], toolExecutions: [] }), false);
  for (const changed of [
    { ...observation("legalwork_skill_read", 96000), status: "error" },
    { ...observation("legalwork_skill_read", 96000), messageID: "other-message" },
    { ...observation("legalwork_skill_read", 96000), id: "other-call" },
    { ...observation("legalwork_skill_read", 96000), sessionID: "unowned-session" },
    { ...observation("legalwork_skill_read", 96000), input: { name, path: "resources/other.md", offset: 96000 } },
    observation("legalwork_skill_read", 96000, { output: { ok: true, payload: { ...payload("legalwork_skill_read"), content: "fabrication".repeat(400) } } }),
  ]) assert.equal(check(tools, { ...context, toolExecutions: [observation("legalwork_skill_load"), changed] }), false);
});

test("skill evidence accepts exact completed legacy/native direct and authoritative first-party Code Mode child calls", () => {
  for (const protocol of ["legacy-v1", "native-v2"]) assert.equal(check([direct("legalwork_skill_load", protocol), direct("legalwork_skill_read", protocol, 96000)]), true);
  assert.equal(check([execute([child("legalwork_skill_load"), child("legalwork_skill_read", 96000)])]), true);
  const native = [{ id: "msg_real", benchmarkRequestedSessionID: "ses_owned", type: "assistant", content: [{ id: "part_real", type: "tool", name: "execute", state: execute([child("legalwork_skill_load"), child("legalwork_skill_read", 96000)]).state }] }];
  assert.equal(evaluateSkillResourceExecution(assertion, summarizeMessages(native), { ...context, toolExecutions: context.toolExecutions.map(event => ({ ...event, messageID: "msg_real", id: "part_real" })) }).passed, true);
  const legacy = [{ info: { id: "msg_real", role: "assistant" }, parts: [direct("legalwork_skill_load", "legacy-v1"), direct("legalwork_skill_read", "legacy-v1", 96000)].map(call => ({ ...call, type: "tool" })) }];
  assert.equal(evaluateSkillResourceExecution(assertion, summarizeMessages(legacy), context).passed, true);
});

test("skill evidence rejects wrong skills/resources, errors, running, forged code strings and missing continuation", () => {
  const load = direct("legalwork_skill_load", "legacy-v1");
  const read = direct("legalwork_skill_read", "legacy-v1", 96000);
  const badReads = [
    { ...read, tool: "legalwork_skill_read_spoof" },
    { ...read, state: { ...read.state, status: "running" } },
    { ...read, state: { ...read.state, status: "error" } },
    { ...read, state: { ...read.state, metadata: { error: true } } },
    { ...read, state: { ...read.state, input: { ...read.state.input, name: `${name}-other` } } },
    { ...read, state: { ...read.state, input: { ...read.state.input, path: "resources/other.md" } } },
    { ...read, state: { ...read.state, output: JSON.stringify({ ok: false, error: "Denied" }) } },
    { ...read, state: { ...read.state, output: JSON.stringify({ ok: true, payload: { path: "resources/other.md", content: "source" } }) } },
    { ...read, state: { ...read.state, output: JSON.stringify({ ok: true, payload: { ...payload("legalwork_skill_read"), content: "t".repeat(4000) } }) } },
    { ...read, messageID: "" }, { ...read, callID: "" },
    direct("legalwork_skill_read", "legacy-v1"),
    direct("legalwork_skill_read", "legacy-v1", 24000),
  ];
  for (const bad of badReads) assert.equal(check([load, bad]), false);
  assert.equal(check([read]), false);
  assert.equal(check([{ ...load, state: { ...load.state, input: { name: "other" } } }, read]), false);
  assert.equal(check([{ ...load, state: { ...load.state, output: JSON.stringify({ ok: true, payload: { chain: [{ name: "other" }] } }) } }, read]), false);
  assert.equal(check([execute([])]), false);
  assert.equal(check([execute([child("legalwork_skill_load"), child("legalwork_skill_read", 24000)])]), false);
  for (const changed of [
    { ...child("legalwork_skill_read", 96000), tool: "legalwork.legalwork_skill_read" },
    { ...child("legalwork_skill_read", 96000), tool: "legalwork_skill_read_spoof" },
    { ...child("legalwork_skill_read", 96000), input: { name: "other", path: resourcePath, offset: 96000 } },
    { ...child("legalwork_skill_read", 96000), status: "error" },
    { ...child("legalwork_skill_read", 96000), status: "running" },
  ]) assert.equal(check([execute([child("legalwork_skill_load"), changed])]), false);
  const parent = execute([child("legalwork_skill_load"), child("legalwork_skill_read", 96000)]);
  for (const state of [{ ...parent.state, status: "error" }, { ...parent.state, status: "running" }, { ...parent.state, content: [] }, { ...parent.state, metadata: { ...parent.state.metadata, error: true } }]) assert.equal(check([{ ...parent, state }]), false);
  assert.equal(check([{ ...parent, state: { ...parent.state, metadata: {}, input: { code: 'await tools.legalwork_skill_load({name:"benchmark-portable-renewal-review"}); await tools.legalwork_skill_read({name:"benchmark-portable-renewal-review",path:"resources/renewal-archive.md",offset:96000})' } } }]), false);
});

test("skill evidence requires actual installed-byte provenance and rejects replaced/truncated resources", () => {
  const tools = [execute([child("legalwork_skill_load"), child("legalwork_skill_read", 96000)])];
  assert.equal(check(tools, {}), false);
  for (const changed of [
    { ...context.skillInstallations[0], name: "other" },
    { ...context.skillInstallations[0], scope: "project" },
    { ...context.skillInstallations[0], method: "declared-install-payload" },
    { ...context.skillInstallations[0], files: [files[0], { ...files[1], sha256: "c".repeat(64) }] },
    { ...context.skillInstallations[0], files: [files[0], { ...files[1], bytes: 96000 }] },
    { ...context.skillInstallations[0], files: [files[0]] },
    { ...context.skillInstallations[0], files: [...files, { path: "unexpected.txt", bytes: 1, sha256: "d".repeat(64) }] },
  ]) assert.equal(check(tools, { ...context, skillInstallations: [changed] }), false);
  assert.equal(check(tools, { ...context, skillInstallations: [...context.skillInstallations, ...context.skillInstallations] }), false);
  assert.throws(() => evaluateSkillResourceExecution({ ...assertion, files: [] }, { tools }, context), /hashes/);
});

test("new skill criterion receives the exact opt-in owned subtree and host installation receipt without changing ordinary tool criteria", async () => {
  const root = [{ id: "msg_root", type: "assistant", content: [] }];
  const childMessage = { id: "msg_child", benchmarkRequestedSessionID: "ses_owned", type: "assistant", content: [{ id: "part_child", type: "tool", name: "execute", state: execute([child("legalwork_skill_load"), child("legalwork_skill_read", 96000)]).state }] };
  const subtree = [...root, childMessage];
  const criteria = [{ ...assertion, id: "default-root" }, { ...assertion, id: "owned-child", scope: "subtree" }, { id: "ordinary-direct", type: "capability.tool", scope: "subtree", names: ["legalwork_skill_load"] }];
  const results = await evaluateAssertions(criteria, "/tmp", root, {}, { ...context, subtreeMessages: subtree, toolExecutions: context.toolExecutions.map(event => ({ ...event, messageID: "msg_child", id: "part_child" })) });
  assert.deepEqual(results.map(result => result.passed), [false, true, false]);
  assert.equal((await evaluateAssertions([criteria[1]], "/tmp", root, {}, { subtreeMessages: subtree }))[0].passed, false);
});

// Equal native message/call IDs and inputs can exist in different owned sessions.
test("Code Mode skill results must belong to the exact calling session, not another owned chat", () => {
  const tools = [execute([child("legalwork_skill_load"), child("legalwork_skill_read", 96000)])];
  const otherOwned = { ...context, ownedSessionIDs: ["ses_owned", "ses_other_owned"],
    toolExecutions: context.toolExecutions.map(event => ({ ...event, sessionID: "ses_other_owned" })) };
  assert.equal(check(tools, otherOwned), false);
  assert.equal(check(tools, { ...otherOwned, toolExecutions: context.toolExecutions }), true);
});
