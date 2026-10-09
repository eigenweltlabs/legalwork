import { expect, test } from "bun:test";
import { bootWithFallback, canUseMacHypervisor, type Accelerator } from "./acceleration.js";

test("physical Apple Silicon uses HVF for ARM, but not for a Rosetta x64 process", () => {
  const flags = "kern.hv_support: 1\nkern.hv_vmm_present: 0\nhw.optional.arm64: 1\n";
  expect(canUseMacHypervisor("aarch64", flags)).toBe(true);
  expect(canUseMacHypervisor("x86_64", flags)).toBe(false);
});

test("physical Intel keeps HVF even when the ARM feature key is absent", () => {
  const flags = "kern.hv_support: 1\nkern.hv_vmm_present: 0\n";
  expect(canUseMacHypervisor("x86_64", flags)).toBe(true);
  expect(canUseMacHypervisor("x86_64", flags + "hw.optional.arm64: 0\n")).toBe(true);
  expect(canUseMacHypervisor("aarch64", flags)).toBe(false);
});

test("virtual Intel uses software emulation despite reported HVF support", () => {
  expect(canUseMacHypervisor("x86_64", "kern.hv_support: 1\nkern.hv_vmm_present: 1\n")).toBe(false);
});

test("missing hardware support or unknown Intel host status falls back to software", () => {
  expect(canUseMacHypervisor("aarch64", "kern.hv_support: 0\nhw.optional.arm64: 1\n")).toBe(false);
  expect(canUseMacHypervisor("x86_64", "kern.hv_support: 1\n")).toBe(false);
  expect(canUseMacHypervisor("x86_64", "kern.hv_support: 1\nkern.hv_vmm_present: 0\nhw.optional.arm64: unknown\n")).toBe(false);
  expect(canUseMacHypervisor("aarch64", "")).toBe(false);
});

test("unavailable hardware is completely closed before software boot, with no command dispatched", async () => {
  const events: string[] = [];
  const result = await bootWithFallback("whpx", async (accelerator) => ({
    waitUntilReady: async () => { events.push(`boot:${accelerator}`); if (accelerator === "whpx") throw new Error("Hypervisor unavailable"); },
    close: async () => { events.push(`close:${accelerator}`); },
  }));
  expect(events).toEqual(["boot:whpx", "close:whpx", "boot:tcg"]);
  expect(result.accelerator).toBe("tcg");
});

test("healthy hardware remains selected; a later failure is not replayed in software", async () => {
  const launches: Accelerator[] = [];
  const result = await bootWithFallback("whpx", async (accelerator) => {
    launches.push(accelerator);
    return { waitUntilReady: async () => {}, close: async () => {}, command: async () => { throw new Error("Command already sent data"); } };
  });
  await expect(result.runtime.command()).rejects.toThrow("already sent data");
  expect(launches).toEqual(["whpx"]);
});

test("a failed software boot fails closed without another attempt", async () => {
  let attempts = 0, closed = 0;
  await expect(bootWithFallback("tcg", async () => {
    attempts++;
    return { waitUntilReady: async () => { throw new Error("Invalid guest"); }, close: async () => { closed++; } };
  })).rejects.toThrow("Invalid guest");
  expect(attempts).toBe(1);
  expect(closed).toBe(1);
});
