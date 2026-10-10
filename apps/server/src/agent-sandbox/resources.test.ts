import { expect, test } from "bun:test";
import { cpus } from "node:os";
import { vmResources, WARM_IDLE_MS } from "./resources.js";

test("VM capacity leaves host headroom and does not depend on the number of chats", () => {
  expect(Number.isInteger(vmResources().cpus)).toBe(true);
  expect(vmResources().cpus).toBeGreaterThan(0);
  expect(vmResources(1, 4 * 1024 ** 3)).toEqual({ cpus: 1, memoryMiB: 2048 });
  expect(vmResources(2, 4 * 1024 ** 3)).toEqual({ cpus: 2, memoryMiB: 2048 });
  expect(vmResources(4, 8 * 1024 ** 3)).toEqual({ cpus: 2, memoryMiB: 2048 });
  expect(vmResources(14, 24 * 1024 ** 3)).toEqual({ cpus: 7, memoryMiB: 6144 });
  expect(vmResources(64, 128 * 1024 ** 3)).toEqual({ cpus: 8, memoryMiB: 8192 });
  expect(WARM_IDLE_MS).toBeGreaterThanOrEqual(5 * 60_000);
});

test("an invalid parallelism report falls back to the OS core count", () => {
  const expected = vmResources(Math.max(1, cpus().length), 8 * 1024 ** 3);
  for (const count of [NaN, Infinity, -Infinity, 0, -1, 1.5]) {
    expect(vmResources(count, 8 * 1024 ** 3)).toEqual(expected);
  }
});
