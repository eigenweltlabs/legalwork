import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommunicationNotifications } from './communication-notifications.mjs';

const logger = { ...console, warn() {} };
test('native delivery and later clicks retain the chat identifier', async () => {
  let callback = (_event) => { throw new Error('Bridge not initialized'); };
  const clicks = [];
  const binding = { initialize(fn) { callback = fn; }, send(input) { queueMicrotask(() => callback({ type: 'show', id: input.id })); } };
  const notifications = new CommunicationNotifications({ load: () => binding, onClick: id => clicks.push(id), logger });
  assert.equal(await notifications.show({ id: 'assistant-chat-1' }), true);
  callback({ type: 'click', id: 'assistant-chat-1' });
  assert.deepEqual(clicks, ['assistant-chat-1']);
  assert.equal(notifications.pending.size, 0);
});
test('unavailable native bridge and explicit failures allow ordinary notifications', async () => {
  let callback = (_event) => { throw new Error('Bridge not initialized'); };
  const broken = new CommunicationNotifications({ load() { throw new Error('No native module'); }, onClick() {}, logger });
  assert.equal(await broken.show({ id: 'one' }), null);
  const binding = { initialize(fn) { callback = fn; }, send(input) { queueMicrotask(() => callback({ type: 'failed', id: input.id, error: 'Not supported' })); } };
  const notifications = new CommunicationNotifications({ load: () => binding, onClick() {}, logger });
  assert.equal(await notifications.show({ id: 'two' }), null);
});
test('unconfirmed delivery does not trigger duplicate fallback notifications', async () => {
  const binding = { initialize() {}, send() {} };
  const notifications = new CommunicationNotifications({ load: () => binding, onClick() {}, logger, timeoutMs: 5 });
  assert.equal(await notifications.show({ id: 'three' }), false);
  assert.equal(notifications.pending.size, 0);
});
