import test from "node:test";
import assert from "node:assert/strict";
import { boundedShutdown } from "./bounded-shutdown.mjs";

test("normal cleanup cancels the force-exit watchdog", async () => {
  let forced = false;
  await boundedShutdown(async () => {}, () => { forced = true; }, 10);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(forced, false);
});
test("a stuck cleanup cannot prevent the force-exit deadline", async () => {
  let finishCleanup = () => {}, force = () => {};
  const cleanup = new Promise(resolve => { finishCleanup = () => resolve(undefined); });
  const forced = new Promise(resolve => { force = () => resolve("forced"); });
  const operation = boundedShutdown(() => cleanup, force, 10);
  assert.equal(await forced, "forced");
  finishCleanup(); await operation;
});
