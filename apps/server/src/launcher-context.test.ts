import { expect, test } from "bun:test";
import { LauncherContextStore } from "./launcher-context.js";

test("staged context expires, is consumed once, and invocation IDs deduplicate repeated delivery", () => {
  let now = 1_000_000;
  const store = new LauncherContextStore(() => now);
  const selection = { id: "sel_1", type: "selection" as const, text: "Clause 4", sourceApp: "Word", sourceWindow: "Lease.docx", capturedAt: now };
  const staged = store.stage([selection], "raycast", 2_000);
  expect(staged.id).toMatch(/^ctx_[0-9a-f]{32}$/);
  expect(store.peek(staged.id)).toMatchObject({ items: 1, source: "raycast" });
  expect(store.consume(staged.id)?.items).toEqual([selection]);
  expect(store.consume(staged.id)).toBeNull();
  const expiring = store.stage([selection], "deep-link", 1_000);
  now += 1_500;
  expect(store.peek(expiring.id)).toBeNull();
  expect(store.consume(expiring.id)).toBeNull();
  expect(store.rememberInvocation("inv_1")).toBe(true);
  expect(store.rememberInvocation("inv_1")).toBe(false);
  now += 11 * 60_000;
  expect(store.rememberInvocation("inv_1")).toBe(true);
});
