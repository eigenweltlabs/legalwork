import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createHostApprovalHandler } from "./host-approvals.mjs";

const request = {
  workspaceId: "workspace",
  action: "skills.delete",
  summary: "Delete skill demo",
  paths: ["/workspace/.opencode/skills/demo"],
  actor: { type: "remote", clientId: "client-1", scope: "collaborator" },
};

function hostWindow() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false });
}

test("shows the requester and affected paths with deny as default and cancel", async () => {
  const window = hostWindow();
  const handler = createHostApprovalHandler({
    getWindow: () => window,
    showMessageBox: async (parent, options) => {
      assert.equal(parent, window);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.deepEqual(options.buttons, ["Deny", "Allow"]);
      assert.match(options.detail, /client-1/);
      assert.match(options.detail, /skills\.delete/);
      assert.match(options.detail, /\/workspace\/\.opencode\/skills\/demo/);
      return { response: 1 };
    },
  });
  assert.equal(await handler(request, new AbortController().signal), "allow");
  assert.equal(window.listenerCount("closed"), 0);
});

test("a missing or destroyed host window never opens a dialog", async () => {
  for (const window of [null, { isDestroyed: () => true }]) {
    const handler = createHostApprovalHandler({
      getWindow: () => window,
      showMessageBox: async () => assert.fail("dialog must not open"),
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
      showMessageBox: async (_parent, options) => {
        if (closeWindow) window.emit("closed");
        else controller.abort();
        assert.equal(options.signal.aborted, true);
        return { response: 1 };
      },
    });
    assert.equal(await handler(request, controller.signal), "deny");
  }
});

test("a dismissed or failed dialog denies the request", async () => {
  for (const showMessageBox of [async () => ({ response: 0 }), async () => { throw new Error("unavailable"); }]) {
    const handler = createHostApprovalHandler({ getWindow: hostWindow, showMessageBox });
    assert.equal(await handler(request, new AbortController().signal), "deny");
  }
});

test("serializes dialogs and skips a cancelled request waiting in the queue", async () => {
  /** @type {(result: { response: number }) => void} */
  let finish = () => assert.fail("dialog must open first");
  let opened = 0;
  const handler = createHostApprovalHandler({
    getWindow: hostWindow,
    showMessageBox: () => {
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
  finish({ response: 1 });
  assert.equal(await first, "allow");
  assert.equal(await second, "deny");
  assert.equal(opened, 1);
});
