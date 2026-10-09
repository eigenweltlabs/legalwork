import { expect, test } from "bun:test";
import { canUseMacHypervisor } from "./acceleration.js";

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
