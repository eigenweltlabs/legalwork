import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocumentExport } from "../src/react-app/domains/session/artifacts/document-export";

test("save and recovery share an export and its unchanged revision", async () => {
  let exports = 0;
  const exporter = createDocumentExport(() => 1, async () => { exports++; return new Uint8Array([1]).buffer; });
  const values = await Promise.all(Array.from({ length: 20 }, () => exporter.read()));
  assert.equal(exports, 1);
  assert.ok(values.every(value => value === values[0]));
  assert.equal(await exporter.read(), values[0]);
});
test("waiting checkpoints collapse intervening revisions into one latest export", async () => {
  let revision = 1, exports = 0;
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const exporter = createDocumentExport(() => revision, async () => {
    const captured = revision;
    if (++exports === 1) { started.resolve(); await finish.promise; }
    return captured;
  });
  const first = exporter.read(); await started.promise;
  revision = 2; const second = exporter.read();
  revision = 3; const third = exporter.read();
  revision = 4; const fourth = exporter.read();
  finish.resolve();
  assert.deepEqual(await Promise.all([first, second, third, fourth]), [1, 4, 4, 4]);
  assert.equal(exports, 2);
});
test("failure and an unavailable editor permit a later retry", async () => {
  let calls = 0;
  const exporter = createDocumentExport(() => 1, async () => {
    if (++calls === 1) throw new Error("fixture save failure");
    return calls === 2 ? null : "saved";
  }, value => value !== null);
  await assert.rejects(exporter.read(), /fixture/);
  assert.equal(await exporter.read(), null);
  assert.equal(await exporter.read(), "saved");
});
