import assert from "node:assert/strict";
import test from "node:test";
import { configureRemoteDebugging } from "./remote-debugging.mjs";

function switches(isPackaged, port) {
  const values = new Map([["remote-debugging-port", "9999"], ["remote-debugging-pipe", ""], ["disable-gpu", ""]]);
  configureRemoteDebugging({
    isPackaged,
    commandLine: {
      removeSwitch: (name) => values.delete(name),
      appendSwitch: (name, value) => values.set(name, value),
    },
  }, { LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT: port });
  return values;
}

test("release builds remove debugging switches even when explicitly requested", () => {
  assert.deepEqual([...switches(true, "9823")], [["disable-gpu", ""]]);
});

test("development debugging requires an explicit valid port and zero disables it", () => {
  for (const value of [undefined, "", "0", "-1", "9223oops", "65536", "9223.5"]) {
    assert.deepEqual([...switches(false, value)], [["disable-gpu", ""]]);
  }
  const enabled = switches(false, "9823");
  assert.equal(enabled.get("remote-debugging-port"), "9823");
  assert.equal(enabled.get("remote-debugging-address"), "127.0.0.1");
  assert.equal(enabled.has("remote-debugging-pipe"), false);
});
