import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSupportTicketConfirmations } from "./support-ticket.mjs";

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
    const choice = broker.request(contents, new AbortController().signal);
    const view = broker.read(contents);
    assert.ok(view);
    assert.deepEqual(view, { id: view.id });
    assert.equal(messages.at(-1), view);
    assert.equal(broker.reply(contents, view.id, expected), true);
    assert.equal(broker.reply(contents, view.id, "with_logs"), false);
    assert.equal(await choice, expected);
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
  const choice = broker.request(contents, controller.signal);
  const original = broker.read(contents);
  assert.ok(original);
  assert.equal(broker.read(other), null);
  assert.equal(broker.reply(other, original.id, "with_logs"), false);
  assert.equal(broker.reply(contents, original.id, "approve"), false);
  assert.equal(await broker.request(contents, controller.signal), "cancel");
  controller.abort();
  assert.equal(await choice, "cancel");

  const replacement = broker.request(contents, new AbortController().signal);
  assert.equal(broker.reply(contents, original.id, "with_logs"), false);
  contents.emit("did-start-navigation", {}, "https://example.test", false, true);
  assert.equal(await replacement, "cancel");
});
