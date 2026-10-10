import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SharedVmRuntime } from "./runtime.js";

const fixture = `
const { encodeFrame, FrameDecoder } = require(${JSON.stringify(fileURLToPath(new URL("./protocol.ts", import.meta.url)))});
process.stdout.write(encodeFrame({protocol: 5}));
const decoder = new FrameDecoder();
process.stdin.on('data', chunk => decoder.push(chunk, message => {
  if (message.op === 'run') setTimeout(() => {
    process.stdout.write(encodeFrame({run: message.run, payload: {event: 'exit'}}));
  }, message.config.delay || 0);
  if (message.op === 'cancel') process.stdout.write(encodeFrame({run: message.run, payload: {event: 'exit'}}));
}));`;

async function runtime(needsMemory: () => Promise<boolean>, idleMs = 1000) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-lifecycle-"));
  let closed = false;
  const vm = new SharedVmRuntime(process.execPath, ["-e", fixture], directory, join(directory, "console.log"),
    () => { closed = true; }, undefined, { idleMs, pressurePollMs: 10, needsMemory });
  await vm.waitUntilReady();
  const run = (milliseconds = 0, signal = new AbortController().signal) => vm.execute({ delay: milliseconds }, signal,
    (_event, _reply, finish) => finish());
  return { vm, run, isClosed: () => closed };
}

test("reusing an idle runtime resets its shutdown deadline", async () => {
  const f = await runtime(async () => false, 200);
  try {
    await f.run();
    await delay(120);
    await f.run();
    await delay(120);
    expect(f.isClosed()).toBe(false);
    await delay(130);
    expect(f.isClosed()).toBe(true);
  } finally { await f.vm.close(); }
});

test("memory pressure releases an idle VM without waiting for the warm timeout", async () => {
  const f = await runtime(async () => true);
  try {
    await f.run();
    await delay(100);
    expect(f.isClosed()).toBe(true);
  } finally { await f.vm.close(); }
});

test("an unused boot also expires when all callers cancelled before it became ready", async () => {
  const f = await runtime(async () => false, 100);
  try {
    await delay(200);
    expect(f.isClosed()).toBe(true);
  } finally { await f.vm.close(); }
});

test("a delayed memory-pressure sample cannot kill a newly active command", async () => {
  let sampled: () => void = () => {}, resolvePressure: (value: boolean) => void = () => {};
  const sample = new Promise<void>((resolve) => { sampled = resolve; });
  const pressure = new Promise<boolean>((resolve) => { resolvePressure = resolve; });
  const f = await runtime(() => { sampled(); return pressure; });
  try {
    await f.run();
    await sample;
    const active = f.run(200);
    resolvePressure(true);
    await delay(80);
    expect(f.isClosed()).toBe(false);
    await active;
    await delay(80);
    expect(f.isClosed()).toBe(true);
  } finally { resolvePressure(false); await f.vm.close(); }
});

test("cancellation completes without discarding the healthy shared runtime", async () => {
  const f = await runtime(async () => false);
  try {
    const controller = new AbortController();
    const active = f.run(200, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(active).rejects.toThrow("cancelled");
    await f.run();
    expect(f.isClosed()).toBe(false);
  } finally { await f.vm.close(); }
});
