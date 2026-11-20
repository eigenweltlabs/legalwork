import { test } from "node:test";
import assert from "node:assert/strict";
import { windowCaptureSource } from "./capture-source.mjs";

test("a closed, renamed or ambiguous origin never captures an unrelated window", () => {
  const other = { id: "other", name: "Another matter" };
  const wanted = { id: "wanted", name: "Lease.docx" };
  const origin = { app: "Word", window: "Lease.docx" };
  assert.equal(windowCaptureSource([other], origin), null);
  assert.equal(windowCaptureSource([other, wanted], origin), wanted);
  assert.equal(windowCaptureSource([other, wanted, { id: "duplicate", name: wanted.name }], origin), null);
  assert.equal(windowCaptureSource([other], { app: "Word", window: null }), null);
});
