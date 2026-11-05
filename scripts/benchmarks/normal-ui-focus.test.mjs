import assert from "node:assert/strict";
import test from "node:test";
import { assertEmptyCreatedTaskHistory, focusNormalUiSession, normalUiFocusBinding } from "./normal-ui-focus.mjs";

function fixture(change = {}) {
  const workspace = { id: "matter", path: "/home/legalwork/fresh/workspace" };
  const connection = { base: "http://127.0.0.1:39500", ui: { baseUrl: "http://127.0.0.1:39501" }, workspace,
    focus: { kind: "normal-ui-control", instanceID: "owned-vm-id", profile: "/home/legalwork/fresh/electron", workspace: workspace.path,
      uiBaseURL: "http://127.0.0.1:39501", serverBaseURL: "http://127.0.0.1:39500", guestUiBaseURL: "http://127.0.0.1:41001",
      guestServerBaseURL: "http://127.0.0.1:41000", discoverySha256: "a".repeat(64) } };
  const session = { id: "ses_owned", location: { directory: workspace.path }, model: { id: "actual-model", providerID: "actual-provider", variant: "default" }, ...change.session };
  const calls = []; let route = "/workspace/matter/session/ses_owned", time = 0;
  const request = async (surface, path, body) => {
    calls.push({ surface, path, body });
    if (surface === "engine") return { data: structuredClone(session) };
    if (path === "/execute") {
      const actionId = body.actionId;
      route = actionId === "route.session" ? "/home" : "/workspace/matter/session/ses_owned";
      return { ok: true, actionId, ...(actionId === "session.open" ? { result: { ok: true, navigatedTo: "ses_owned", ...change.opened } } : {}), ...change.action };
    }
    return { ok: true, route, actions: [{ id: "composer.set_text" }, { id: "composer.send", disabled: true }], ...change.snapshot };
  };
  return { connection, request, calls, sessionID: "ses_owned", now: () => time, pause: async ms => { time += ms; }, uiReadyTimeoutMs: 100 };
}

test("normal focus selects the owned chat using only its public action, retaining exact native settings and disabled Send", async () => {
  const input = fixture(); const result = await focusNormalUiSession(input);
  assert.equal(result.focused, true); assert.equal(result.inferenceCalls, 0);
  assert.deepEqual(input.calls.filter(call => call.body).map(call => call.body), [
    { actionId: "session.open", args: { sessionId: "ses_owned" } },
  ]);
  assert.equal(result.ui.route, "/workspace/matter/session/ses_owned");
  assert.equal(result.ui.actions.find(action => action.id === "composer.send").disabled, true);
  assert.deepEqual(result.nativeAfter, result.nativeBefore);
  assert.deepEqual(result.nativeAfter.model, { id: "actual-model", providerID: "actual-provider", variant: "default" });
  assert.equal(input.calls.some(call => call.body?.actionId === "composer.send" || call.body?.callerSessionId), false);
});

test("normal focus rejects wrong native ownership before navigation and a changed identity afterwards", async () => {
  for (const session of [{ id: "ses_other" }, { location: { directory: "/home/legalwork/other" } }, { parentID: "other-parent" }]) {
    const input = fixture({ session });
    await assert.rejects(focusNormalUiSession(input), /owned root task/);
    assert.equal(input.calls.length, 1);
  }
  const input = fixture(); const request = input.request; let reads = 0;
  input.request = async (...args) => { const result = await request(...args); return args[0] === "engine" && ++reads === 2 ? { data: { ...result.data, id: "swapped" } } : result; };
  await assert.rejects(focusNormalUiSession(input), /owned root task/);
  const changed = fixture(); const original = changed.request; let nativeReads = 0;
  changed.request = async (...args) => { const result = await original(...args); return args[0] === "engine" && ++nativeReads === 2 ? { data: { ...result.data, model: { ...result.data.model, variant: "low" } } } : result; };
  await assert.rejects(focusNormalUiSession(changed), /model.settings changed/);
});

test("normal focus fails closed on false navigation, background-only open, malformed or wrong routes and missing composer", async () => {
  for (const change of [{ action: { ok: false } }, { opened: { navigatedTo: "other" } }, { opened: { background: true } },
    { snapshot: { route: "/workspace/other/session/ses_owned" } }, { snapshot: { actions: [] } }, { snapshot: { ok: false } }]) {
    const input = fixture(change);
    await assert.rejects(focusNormalUiSession(input), /navigation failed|session.open|readiness watchdog|Malformed/);
    assert.equal(input.calls.some(call => call.body?.actionId === "composer.send"), false);
  }
});

test("normal focus retains all asynchronous route observations and proceeds only when the composer mounts", async () => {
  const input = fixture(); const request = input.request; let pending = true;
  input.request = async (...args) => {
    const result = await request(...args);
    if (args[1] === "/snapshot" && result.route !== "/home" && pending) { pending = false; return { ...result, actions: [] }; }
    return result;
  };
  const result = await focusNormalUiSession({ ...input, uiReadyTimeoutMs: 500 });
  assert.equal(result.focused, true);
  assert.equal(input.calls.filter(call => call.path === "/snapshot").length, 2);
});

test("normal focus requires explicit isolated discovery bindings and never accepts an arbitrary service or profile", () => {
  const { connection } = fixture(); assert.equal(normalUiFocusBinding(connection), connection.focus);
  for (const changed of [{ kind: "unknown" }, { instanceID: "" }, { profile: "/root/private" }, { workspace: "/home/legalwork/other" },
    { profile: "/home/legalwork/../root" }, { discoverySha256: "unverified" }, { uiBaseURL: "http://localhost:39501" },
    { uiBaseURL: "http://127.0.0.1:39502" }, { serverBaseURL: "http://127.0.0.1:39500/path" }, { guestServerBaseURL: connection.focus.guestUiBaseURL }])
    assert.throws(() => normalUiFocusBinding({ ...connection, focus: { ...connection.focus, ...changed } }), /binding differs|loopback/);
});

test("a newly created task must have genuinely empty complete history", () => {
  assert.deepEqual(assertEmptyCreatedTaskHistory([], "ses_owned"), { sessionID: "ses_owned", messages: 0, empty: true });
  for (const messages of [undefined, {}, [{ type: "user", content: [] }], [{ type: "assistant", content: [{ type: "text", text: "old answer" }] }]])
    assert.throws(() => assertEmptyCreatedTaskHistory(messages, "ses_owned"), /completely empty/);
  assert.throws(() => assertEmptyCreatedTaskHistory([], ""), /completely empty/);
});
