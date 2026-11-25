import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

test("HUD click opens setup when disabled, starts without a registered shortcut, and exposes the microphone menu", async () => {
  const file = new URL("./audio/dictation-hud.mjs", import.meta.url);
  const source = (await readFile(file, "utf8")).replace(/^import .*;\n/gm, "")
    .replace("export class DictationHud", "class DictationHud").replaceAll("import.meta.url", JSON.stringify(file.href));
  const sandbox = { process, path, app: { getPath: () => "/tmp/test-hud" }, ipcMain: { on() {} }, nativeTheme: { on() {} } };
  const Hud = runInNewContext(source + "\nDictationHud", sandbox);
  const actions = [];
  const hud = new Hud({ onStart: () => actions.push("start"), onSetup: () => actions.push("setup"), onMicrophoneMenu: () => actions.push("microphone"), onAssistant: () => actions.push("assistant") });
  hud.window = { webContents: {} };
  const sender = { sender: hud.window.webContents };
  hud.status.miniBarEnabled = true;
  hud.onAction(sender, "start");
  assert.deepEqual(actions, ["setup"]);
  hud.status.enabled = true;
  hud.status.registered = false;
  hud.onAction(sender, "start");
  hud.onAction(sender, "microphone-menu");
  assert.deepEqual(actions, ["setup", "start", "microphone"]);
  hud.onAction({ sender: {} }, "start");
  hud.meeting = { state: "recording" };
  hud.onAction(sender, "start");
  hud.meeting = null;
  hud.state = "listening";
  hud.onAction(sender, "start");
  hud.onAction(sender, "microphone-menu");
  assert.equal(actions.length, 3, "foreign windows and active recordings cannot trigger idle controls");
  hud.onAction(sender, "assistant-open");
  assert.equal(actions.at(-1), "assistant", "the launcher remains independent of dictation setup and recording state");
  hud.onAction({ sender: {} }, "assistant-open");
  hud.status.miniBarEnabled = false;
  hud.onAction(sender, "assistant-open");
  assert.equal(actions.length, 4);

  const states = [];
  hud.window = { isDestroyed: () => false, webContents: { send: (_channel, state) => states.push(state) } };
  hud.locale = "en";
  hud.companion = { badge: true, attention: 2, recording: true };
  hud.stopwatchState = { startedAt: "2026-11-25T10:00:00Z", version: 3 };
  hud.sendState();
  assert.deepEqual(states[0].companion, hud.companion);
  assert.deepEqual(states[0].stopwatch, hud.stopwatchState, "timer updates and launcher attention survive the same HUD state broadcast");
});
