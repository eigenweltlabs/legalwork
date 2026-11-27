import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSupportTicketConfirmations } from "./support-ticket.mjs";

const report = { email: "tester@example.test", description: "The PDF tool failed.", logDays: 2 };
const channel = "legalwork:support-ticket:confirmation";

function renderer() {
  const events = new EventEmitter();
  return Object.assign(events, {
    isDestroyed: () => false,
    send(event, value) { events.emit("message", event, value); },
  });
}

test("the app asks for a one-time choice and accepts all three outcomes", async () => {
  const broker = createSupportTicketConfirmations();
  const contents = renderer();
  const messages = [];
  contents.on("message", (event, value) => { assert.equal(event, channel); messages.push(value); });
  for (const expected of ["cancel", "without_logs", "with_logs"]) {
    const choice = broker.request(contents, report, new AbortController().signal);
    const view = broker.read(contents);
    assert.ok(view);
    assert.deepEqual(view, { ...report, id: view.id });
    assert.equal(messages.at(-1), view);
    assert.equal(broker.reply(contents, view.id, expected, 10), true);
    assert.equal(broker.reply(contents, view.id, "with_logs"), false);
    assert.deepEqual(await choice, expected === "with_logs" ? { choice: expected, logDays: 10 } : { choice: expected });
    assert.equal(messages.at(-1), null);
  }
  assert.equal(contents.listenerCount("destroyed"), 0);
  assert.equal(contents.listenerCount("did-start-navigation"), 0);
});

test("an interrupted chat and a different window cannot approve a report", async () => {
  const broker = createSupportTicketConfirmations();
  const contents = renderer();
  const other = renderer();
  const controller = new AbortController();
  const choice = broker.request(contents, report, controller.signal);
  const original = broker.read(contents);
  assert.ok(original);
  assert.equal(broker.read(other), null);
  assert.equal(broker.reply(other, original.id, "with_logs"), false);
  assert.equal(broker.reply(contents, original.id, "approve"), false);
  assert.equal(broker.reply(contents, original.id, "with_logs", 0), false);
  assert.deepEqual(await broker.request(contents, report, controller.signal), { choice: "cancel" });
  controller.abort();
  assert.deepEqual(await choice, { choice: "cancel" });

  const replacement = broker.request(contents, report, new AbortController().signal);
  assert.equal(broker.reply(contents, original.id, "with_logs"), false);
  contents.emit("did-start-navigation", {}, "https://example.test", false, true);
  assert.deepEqual(await replacement, { choice: "cancel" });
});
