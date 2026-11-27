import assert from "node:assert/strict";
import { test } from "node:test";
import { quickActionContext } from "../src/quick-action-context.ts";

test("quick actions keep whitespace in captured text", () => {
  const selection = "\n  Synthetic text\t\n", clipboard = "  \t";
  assert.deepEqual(quickActionContext(selection, clipboard).map(item => "text" in item ? item.text : null), [selection, clipboard]);
  assert.deepEqual(quickActionContext("", ""), []);
});

test("quick actions reject oversized input instead of shortening it", () => {
  const limit = " ".repeat(200_000);
  assert.equal(quickActionContext(limit, limit).length, 2);
  assert.throws(() => quickActionContext(limit + "\n", "Fixture"), /selection exceeds 200,000/);
  assert.throws(() => quickActionContext("Fixture", limit + "\n"), /clipboard text exceeds 200,000/);
});
