import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createHostApprovalHandler, presentHostApproval } from "./host-approvals.mjs";

const request = {
  id: "request-1",
  workspaceId: "workspace",
  action: "skills.delete",
  summary: "Delete skill demo",
  paths: ["/workspace/.opencode/skills/demo"],
  actor: { type: "remote", clientId: "client-1", scope: "collaborator" },
};

function hostWindow() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false });
}

test("passes the complete request to the host approval dialog", async () => {
  const window = hostWindow();
  const handler = createHostApprovalHandler({
    getWindow: () => window,
    showDialog: async (parent, shown) => {
      assert.equal(parent, window);
      assert.equal(shown, request);
      return "allow";
    },
  });
  assert.equal(await handler(request, new AbortController().signal), "allow");
  assert.equal(window.listenerCount("closed"), 0);
});

test("a missing or destroyed host window never opens a dialog", async () => {
  for (const window of [null, { isDestroyed: () => true }]) {
    const handler = createHostApprovalHandler({
      getWindow: () => window,
      showDialog: async () => assert.fail("dialog must not open"),
    });
    assert.equal(await handler(request, new AbortController().signal), "deny");
  }
});

test("closing the host window or cancelling the request aborts the dialog", async () => {
  for (const closeWindow of [true, false]) {
    const window = hostWindow();
    const controller = new AbortController();
    const handler = createHostApprovalHandler({
      getWindow: () => window,
      showDialog: async (_parent, _request, signal) => {
        if (closeWindow) window.emit("closed");
        else controller.abort();
        assert.equal(signal.aborted, true);
        return "allow";
      },
    });
    assert.equal(await handler(request, controller.signal), "deny");
  }
});

test("a dismissed or failed dialog denies the request", async () => {
  for (const showDialog of [async () => "deny", async () => { throw new Error("unavailable"); }]) {
    const handler = createHostApprovalHandler({ getWindow: hostWindow, showDialog });
    assert.equal(await handler(request, new AbortController().signal), "deny");
  }
});

test("serializes dialogs and skips a cancelled request waiting in the queue", async () => {
  /** @type {(result: string) => void} */
  let finish = () => assert.fail("dialog must open first");
  let opened = 0;
  const handler = createHostApprovalHandler({
    getWindow: hostWindow,
    showDialog: () => {
      opened += 1;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  const first = handler(request, new AbortController().signal);
  const controller = new AbortController();
  const second = handler(request, controller.signal);
  await Promise.resolve();
  assert.equal(opened, 1);
  controller.abort();
  finish("allow");
  assert.equal(await first, "allow");
  assert.equal(await second, "deny");
  assert.equal(opened, 1);
});

function approvalWindow() {
  const sent = [];
  const contents = Object.assign(new EventEmitter(), { ipc: new EventEmitter(), mainFrame: {},
    isDestroyed: () => false, send: (...args) => sent.push(args) });
  const window = Object.assign(hostWindow(), { webContents: contents });
  return { window, contents, sent };
}

test("only the host main frame can answer its current request", async () => {
  const { window, contents, sent } = approvalWindow();
  const pending = presentHostApproval(window, request, new AbortController().signal);
  assert.deepEqual(sent, [["legalwork:approval:show", request]]);
  contents.ipc.emit("legalwork:approval:reply", { senderFrame: {} }, request.id, "allow");
  contents.ipc.emit("legalwork:approval:reply", { senderFrame: contents.mainFrame }, "stale-id", "allow");
  contents.ipc.emit("legalwork:approval:reply", { senderFrame: contents.mainFrame }, request.id, "always");
  assert.equal(sent.length, 1);
  contents.ipc.emit("legalwork:approval:reply", { senderFrame: contents.mainFrame }, request.id, "allow");
  assert.equal(await pending, "allow");
  assert.deepEqual(sent[1], ["legalwork:approval:dismiss", request.id]);
  assert.equal(contents.ipc.listenerCount("legalwork:approval:reply"), 0);
});

test("renderer failure, destruction, navigation and cancellation all deny and dismiss", async () => {
  for (const reason of ["destroyed", "render-process-gone", "navigate", "abort"]) {
    const { window, contents, sent } = approvalWindow();
    const controller = new AbortController();
    const pending = presentHostApproval(window, request, controller.signal);
    if (reason === "abort") controller.abort();
    else if (reason === "navigate") contents.emit("did-start-navigation", {}, "url", false, true);
    else contents.emit(reason);
    assert.equal(await pending, "deny");
    assert.deepEqual(sent[1], ["legalwork:approval:dismiss", request.id]);
    assert.equal(contents.ipc.listenerCount("legalwork:approval:reply"), 0);
  }
});
