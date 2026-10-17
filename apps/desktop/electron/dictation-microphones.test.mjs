import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DictationMicrophones } from "./audio/dictation-microphones.mjs";

const inputs = [{ id: "mac", name: "Mac microphone" }, { id: "airpods", name: "AirPods" }, { id: "usb", name: "USB microphone" }];
const native = {
  inputs: inputs.map(input => ({ name: input.name, builtIn: input.id === "mac", bluetooth: input.id === "airpods" })),
  defaultInputName: "AirPods", lidClosed: false,
};
async function fixture(t, info = native) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legalwork-microphones-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const changes = [];
  const options = { userDataDir: directory, nativeInputs: async () => info, onChange: state => changes.push(state) };
  const microphones = new DictationMicrophones(options);
  await microphones.update(inputs, "airpods");
  return { microphones, options, changes };
}

test("Automatic prefers the Mac mic over the Bluetooth default", async t => {
  const { microphones } = await fixture(t);
  assert.equal(microphones.state().resolvedDeviceId, "mac");
  assert.equal(microphones.state().selection, "auto");
});
test("Automatic follows a non-Bluetooth system input", async t => {
  const { microphones } = await fixture(t, { ...native, defaultInputName: "USB microphone" });
  assert.equal(microphones.state().resolvedDeviceId, "usb");
});
test("Chromium's transport suffixes still match Core Audio metadata and the default input", async t => {
  const { microphones } = await fixture(t);
  const decorated = inputs.map(input => ({ ...input, name: input.name + (input.id === "mac" ? " (Built-in)" : input.id === "airpods" ? " (Bluetooth)" : " (USB)") }));
  const state = await microphones.update(decorated, "airpods");
  assert.equal(state.resolvedDeviceId, "mac");
  assert.equal(state.devices[0].builtIn, true);
  assert.equal(state.devices[1].bluetooth, true);
  assert.ok(state.devices.every(device => device.available));
  assert.equal((await microphones.select("default")).resolvedDeviceId, "airpods");
});
test("System default and explicit Bluetooth selections are respected and remembered", async t => {
  const { microphones, options } = await fixture(t);
  assert.equal((await microphones.select("default")).resolvedDeviceId, "airpods");
  await microphones.select("airpods");
  const restarted = new DictationMicrophones(options);
  const state = await restarted.update(inputs, "mac");
  assert.equal(state.selection, "airpods");
  assert.equal(state.selectedName, "AirPods");
  assert.equal(state.resolvedDeviceId, "airpods");
});
test("Changing the next input preserves the active input", async t => {
  const { microphones } = await fixture(t);
  microphones.setActive("Mac microphone");
  const state = await microphones.select("airpods");
  assert.equal(state.activeName, "Mac microphone");
  assert.equal(state.resolvedDeviceId, "airpods");
});
test("A closed Mac lid makes its built-in mic unavailable and Automatic prefers USB", async t => {
  const { microphones } = await fixture(t, { ...native, lidClosed: true });
  assert.equal(microphones.state().devices.find(device => device.id === "mac").available, false);
  assert.equal(microphones.state().resolvedDeviceId, "usb");
  await assert.rejects(microphones.select("mac"), /unavailable/);
});
test("A disconnected explicit input remains selected and is never silently replaced", async t => {
  const { microphones } = await fixture(t);
  await microphones.select("airpods");
  await microphones.update(inputs.filter(input => input.id !== "airpods"), "mac");
  assert.equal(microphones.state().selection, "airpods");
  assert.equal(microphones.state().selectedName, "AirPods");
  assert.equal(microphones.state().resolvedDeviceId, null);
});
test("Without native metadata Automatic follows the browser's system input", async t => {
  const { microphones } = await fixture(t, null);
  assert.equal(microphones.state().resolvedDeviceId, "airpods");
  assert.ok(microphones.state().devices.every(device => device.available));
});
test("Older device probes cannot overwrite a newer hardware update", async t => {
  const { microphones } = await fixture(t);
  let resolveOld = (_value) => {};
  microphones.nativeInputs = () => new Promise(resolve => { resolveOld = resolve; });
  const old = microphones.update(inputs, "airpods");
  await new Promise(resolve => setImmediate(resolve));
  microphones.nativeInputs = async () => ({ ...native, defaultInputName: "USB microphone" });
  await microphones.update(inputs, "usb");
  resolveOld(native);
  await old;
  assert.equal(microphones.state().resolvedDeviceId, "usb");
});
