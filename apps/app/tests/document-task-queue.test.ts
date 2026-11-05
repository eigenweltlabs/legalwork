import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocumentTaskQueue } from "../src/react-app/domains/session/artifacts/document-task-queue";

test("cancelled queued edits reject promptly and never execute later", async () => {
  const queue = createDocumentTaskQueue(), gate = Promise.withResolvers<void>();
  const active = queue("doc", () => gate.promise);
  const controller = new AbortController(); let applied = false;
  const queued = queue("doc", async () => { applied = true; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  gate.resolve(); await active;
  await queue("doc", async () => {});
  assert.equal(applied, false);
});
test("expired work cannot apply even if the event loop delayed its timeout", async () => {
  const queue = createDocumentTaskQueue(); let applied = false;
  await assert.rejects(queue("doc", async () => { applied = true; }, { deadline: Date.now() - 1 }), { name: "TimeoutError" });
  assert.equal(applied, false);
});
test("cancelling a running caller never allows another writer to overtake its cleanup", async () => {
  const queue = createDocumentTaskQueue(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const controller = new AbortController(); const events: string[] = [];
  const first = queue("doc", async () => { started.resolve(); await finish.promise; events.push("cleanup"); }, { signal: controller.signal });
  await started.promise; controller.abort(); await assert.rejects(first);
  const second = queue("doc", async () => { events.push("next"); });
  await Promise.resolve(); assert.deepEqual(events, []);
  finish.resolve(); await second; assert.deepEqual(events, ["cleanup", "next"]);
});
