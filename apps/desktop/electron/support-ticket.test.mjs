import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { confirmSupportTicket } from "./support-ticket.mjs";

const report = { email: "tester@example.test", description: "The PDF tool failed." };
const window = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });

test("the desktop support dialog distinguishes cancellation and both send choices", async () => {
  const parent = window();
  for (const [response, expected] of [[0, "cancel"], [1, "without_logs"], [2, "with_logs"]]) {
    const choice = await confirmSupportTicket({
      window: parent, locale: "en", report, signal: new AbortController().signal,
      async showMessageBox(target, options) {
        assert.equal(target, parent);
        assert.deepEqual(options.buttons, ["Cancel", "Send without logs", "Send with logs"]);
        assert.equal(options.defaultId, options.cancelId);
        assert.match(options.detail, /tester@example\.test/);
        assert.match(options.detail, /The PDF tool failed/);
        return { response };
      },
    });
    assert.equal(choice, expected);
  }
  assert.equal(parent.listenerCount("closed"), 0);
});

test("an interrupted chat cannot approve a late dialog response", async () => {
  const controller = new AbortController();
  const choice = await confirmSupportTicket({
    window: window(), locale: "en", report, signal: controller.signal,
    async showMessageBox(_target, options) {
      controller.abort();
      assert.equal(options.signal.aborted, true);
      return { response: 2 };
    },
  });
  assert.equal(choice, "cancel");
});
