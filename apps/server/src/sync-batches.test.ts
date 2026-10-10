import { expect, test } from "bun:test";
import { syncBatches } from "./sync-batches.js";

test("batches bound concurrency, retain order, and drain failures before returning", async () => {
  let active = 0, peak = 0;
  const values = await syncBatches([1, 2, 3, 4, 5], 2, async value => {
    peak = Math.max(peak, ++active); await Bun.sleep(5); active--; return value * 2;
  });
  expect(values).toEqual([2, 4, 6, 8, 10]); expect(peak).toBe(2);
  let drained = false;
  await expect(syncBatches([1, 2, 3], 2, async value => {
    if (value === 1) throw new Error("offline");
    await Bun.sleep(10); drained = true;
  })).rejects.toThrow("offline");
  expect(drained).toBe(true);
});
