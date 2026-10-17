import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SystemDictationService } from "./audio/system-dictation.mjs";

class FakeShortcuts {
  constructor(blocked = []) {
    this.blocked = new Set(blocked);
    this.callbacks = new Map();
    this.registerCount = 0;
  }

  register(accelerator, callback) {
    if (this.blocked.has(accelerator)) return false;
    this.registerCount += 1;
    this.callbacks.set(accelerator, callback);
    return true;
  }

  unregister(accelerator) {
    this.callbacks.delete(accelerator);
  }

  isRegistered(accelerator) {
    return this.callbacks.has(accelerator);
  }
}

class FakeKeyMonitor {
  constructor() {
    this.restarts = 0;
  }

  isSupported() {
    return true;
  }

  async start(callback) {
    this.callback = callback;
    return true;
  }

  async restart() {
    this.restarts += 1;
    await this.callback?.({ type: "reset" });
    return true;
  }

  async emit(type, key) {
    await this.callback?.({ type, key });
  }

  stop() {
    this.callback = null;
  }
}

class FakeClipboard {
  constructor() {
    this.formats = new Map([
      ["text/plain", Buffer.from("before")],
      ["text/html", Buffer.from("<b>before</b>")],
    ]);
  }

  availableFormats() {
    return [...this.formats.keys()];
  }

  readBuffer(format) {
    return this.formats.get(format) ?? Buffer.alloc(0);
  }

  clear() {
    this.formats.clear();
  }

  writeBuffer(format, data) {
    this.formats.set(format, Buffer.from(data));
  }

  readText() {
    return this.formats.get("text/plain")?.toString("utf8") ?? "";
  }

  writeText(text) {
    this.formats.clear();
    this.formats.set("text/plain", Buffer.from(text));
  }
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "lw-dictation-"));
}

test("system dictation persists, registers fallback shortcut, and handles cancel", async () => {
  const userDataDir = await tempDir();
  const shortcuts = new FakeShortcuts(["Control+Super+D", "Control+Alt+Q"]);
  let toggles = 0;
  let cancels = 0;
  const service = new SystemDictationService({
    userDataDir,
    platform: "win32",
    globalShortcut: shortcuts,
    clipboard: new FakeClipboard(),
    shell: { openExternal: async () => {} },
    runPasteCommand: async () => {},
    onToggle: () => { toggles += 1; },
    onCancel: () => { cancels += 1; },
  });

  await service.initialize();
  assert.equal(service.status().enabled, false);
  const status = await service.setEnabled(true);
  assert.equal(status.registered, true);
  assert.equal(status.accelerator, "CommandOrControl+Shift+D");
  shortcuts.callbacks.get(status.accelerator)?.();
  assert.equal(toggles, 1);

  const suspended = await service.setShortcutCapture(true);
  assert.equal(suspended.registered, false);
  assert.equal(shortcuts.callbacks.has(status.accelerator), false);
  const captured = await service.setShortcut("Control+Alt+W");
  assert.equal(captured.registered, false);
  const resumed = await service.setShortcutCapture(false);
  assert.equal(resumed.registered, true);
  assert.equal(resumed.accelerator, "Control+Alt+W");

  const rejected = await service.setShortcut("Control+Alt+Q");
  assert.match(rejected.error, /Could not register/);
  assert.equal(rejected.accelerator, "Control+Alt+W");
  const customized = await service.setShortcut("Control+Alt+W");
  assert.equal(customized.error, null);
  assert.equal(customized.customAccelerator, true);
  shortcuts.callbacks.get("Control+Alt+W")?.();
  assert.equal(toggles, 2);

  service.setRuntimeState("listening");
  shortcuts.callbacks.get("Escape")?.();
  assert.equal(cancels, 1);
  service.setRuntimeState("starting");
  shortcuts.callbacks.get("Escape")?.();
  service.setRuntimeState("transcribing");
  shortcuts.callbacks.get("Escape")?.();
  assert.equal(cancels, 3);
  service.setRuntimeState("inserting");
  assert.equal(shortcuts.callbacks.has("Escape"), false);
  service.setRuntimeState("idle");
  assert.equal(shortcuts.callbacks.has("Escape"), false);

  const stored = JSON.parse(await readFile(path.join(userDataDir, "system-dictation.json"), "utf8"));
  assert.equal(stored.enabled, true);
  assert.equal(stored.accelerator, "Control+Alt+W");
  service.dispose();

  const restoredShortcuts = new FakeShortcuts();
  const restored = new SystemDictationService({
    userDataDir,
    platform: "win32",
    globalShortcut: restoredShortcuts,
    clipboard: new FakeClipboard(),
    shell: { openExternal: async () => {} },
    runPasteCommand: async () => {},
    onToggle: () => {},
    onCancel: () => {},
  });
  const restoredStatus = await restored.initialize();
  assert.equal(restoredStatus.accelerator, "Control+Alt+W");
  assert.equal(restoredStatus.customAccelerator, true);
  assert.equal(restoredStatus.registered, true);
  restored.dispose();
  await rm(userDataDir, { recursive: true, force: true });
});

test("macOS dictation requires Accessibility and preserves the clipboard after paste", async () => {
  const userDataDir = await tempDir();
  const clipboard = new FakeClipboard();
  let accessibility = false;
  let pasteCount = 0;
  let openedUrl = "";
  const service = new SystemDictationService({
    userDataDir,
    platform: "darwin",
    globalShortcut: new FakeShortcuts(),
    clipboard,
    systemPreferences: {
      isTrustedAccessibilityClient(prompt) {
        if (prompt) accessibility = true;
        return accessibility;
      },
    },
    shell: { openExternal: async (url) => { openedUrl = url; } },
    runPasteCommand: async () => { pasteCount += 1; },
    onToggle: () => {},
    onCancel: () => {},
  });

  const copied = await service.pasteText("first dictation");
  assert.equal(copied.pasted, false);
  assert.equal(copied.copied, true);
  assert.match(copied.error, /Accessibility/);
  assert.equal(clipboard.readText(), "first dictation");
  assert.equal(pasteCount, 0);

  clipboard.writeText("before");
  clipboard.writeBuffer("text/html", Buffer.from("<b>before</b>"));
  await service.openSettings();
  assert.match(openedUrl, /Privacy_Accessibility/);
  const pasted = await service.pasteText("second dictation");
  assert.equal(pasted.pasted, true);
  assert.equal(pasteCount, 1);
  assert.equal(clipboard.readText(), "before");
  assert.equal(clipboard.readBuffer("text/html").toString("utf8"), "<b>before</b>");

  service.dispose();
  await rm(userDataDir, { recursive: true, force: true });
});

test("native shortcut monitoring supports modifier-only capture and both dictation gestures", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const userDataDir = await tempDir();
  const keyMonitor = new FakeKeyMonitor();
  let presses = 0;
  let releases = 0;
  let toggles = 0;
  const service = new SystemDictationService({
    userDataDir,
    platform: "darwin",
    globalShortcut: new FakeShortcuts(),
    keyMonitor,
    clipboard: new FakeClipboard(),
    systemPreferences: { isTrustedAccessibilityClient: () => true },
    shell: { openExternal: async () => {} },
    runPasteCommand: async () => {},
    onToggle: () => { toggles += 1; },
    onPress: () => { presses += 1; },
    onRelease: () => { releases += 1; },
    onCancel: () => {},
  });

  const initialized = await service.initialize();
  assert.equal(initialized.supportsHold, true);
  await service.setEnabled(true);
  await service.setShortcutCapture(true);
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("down", "Control");
  await keyMonitor.emit("up", "Control");
  assert.equal(service.status().shortcutCaptureActive, true);
  await keyMonitor.emit("up", "Fn");
  assert.equal(service.status().accelerator, "Fn+Control");
  assert.equal(service.status().shortcutCaptureActive, false);

  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("down", "Control");
  assert.equal(presses, 1);
  assert.equal(service.status().mode, "hold");
  t.mock.timers.tick(500);
  await keyMonitor.emit("up", "Control");
  assert.equal(releases, 1);
  await keyMonitor.emit("up", "Fn");

  await service.setShortcutCapture(true);
  await keyMonitor.emit("down", "Control");
  await keyMonitor.emit("up", "Control");
  assert.equal(service.status().accelerator, "Control");
  await keyMonitor.emit("down", "Control");
  t.mock.timers.tick(50);
  await keyMonitor.emit("up", "Control");
  t.mock.timers.tick(100);
  await keyMonitor.emit("down", "Control");
  assert.equal(service.status().mode, "tap");
  await keyMonitor.emit("up", "Control");
  t.mock.timers.tick(500);
  assert.equal(presses, 2, "double-tap keeps the first capture");
  assert.equal(releases, 1, "neither tap releases hands-free capture");
  assert.equal(toggles, 0);
  await keyMonitor.emit("down", "Control");
  await keyMonitor.emit("up", "Control");
  assert.equal(releases, 2, "one press finishes hands-free dictation");

  const stored = JSON.parse(await readFile(path.join(userDataDir, "system-dictation.json"), "utf8"));
  assert.equal(stored.accelerator, "Control");
  assert.equal(stored.mode, undefined, "gesture choice is no longer a preference");
  service.dispose();
  await rm(userDataDir, { recursive: true, force: true });
});

test("a monitor reset releases a latched hold and clears chord state", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const userDataDir = await tempDir();
  const keyMonitor = new FakeKeyMonitor();
  let presses = 0;
  let releases = 0;
  const service = new SystemDictationService({
    userDataDir,
    platform: "darwin",
    globalShortcut: new FakeShortcuts(),
    keyMonitor,
    clipboard: new FakeClipboard(),
    systemPreferences: { isTrustedAccessibilityClient: () => true },
    shell: { openExternal: async () => {} },
    runPasteCommand: async () => {},
    onToggle: () => {},
    onPress: () => { presses += 1; },
    onRelease: () => { releases += 1; },
    onCancel: () => {},
  });

  await service.initialize();
  await service.setEnabled(true);
  await service.setShortcutCapture(true);
  await keyMonitor.emit("down", "Control");
  await keyMonitor.emit("up", "Control");

  // Hold engaged, then the tap/hook is rebuilt (wake, session switch) and
  // the key-up is lost: the reset must finalize the dictation, not leave it
  // latched "recording" forever.
  await keyMonitor.emit("down", "Control");
  assert.equal(presses, 1);
  await keyMonitor.emit("reset", "*");
  assert.equal(releases, 1);

  // Chord state was cleared, so the next press starts cleanly.
  await keyMonitor.emit("down", "Control");
  assert.equal(presses, 2);
  t.mock.timers.tick(500);
  await keyMonitor.emit("up", "Control");
  assert.equal(releases, 2);

  service.dispose();
  await rm(userDataDir, { recursive: true, force: true });
});

async function gestureService(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const userDataDir = await tempDir();
  const keyMonitor = new FakeKeyMonitor();
  const shortcuts = new FakeShortcuts();
  const events = [];
  const cancelReasons = [];
  const service = new SystemDictationService({
    userDataDir, platform: "darwin", globalShortcut: shortcuts, keyMonitor,
    clipboard: new FakeClipboard(), systemPreferences: { isTrustedAccessibilityClient: () => true },
    shell: { openExternal: async () => {} }, runPasteCommand: async () => {},
    onPress: () => { events.push("start"); service.setRuntimeState("starting"); },
    onRelease: () => { events.push("finish"); service.setRuntimeState("transcribing"); },
    onToggle: () => { events.push("toggle"); service.setRuntimeState("starting"); },
    onCancel: (reason) => { cancelReasons.push(reason); events.push("cancel"); service.setRuntimeState("cancelled"); },
  });
  t.after(async () => { service.dispose(); await rm(userDataDir, { recursive: true, force: true }); });
  await service.initialize();
  await service.setEnabled(true);
  await service.setShortcut("Fn");
  return { service, keyMonitor, shortcuts, events, cancelReasons };
}

test("double-tap during microphone startup starts once and finishes with one press", async (t) => {
  const { service, keyMonitor, events } = await gestureService(t);
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("down", "Fn"); // OS auto-repeat is ignored.
  t.mock.timers.tick(60);
  await keyMonitor.emit("up", "Fn");
  t.mock.timers.tick(150);
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("up", "Fn");
  t.mock.timers.tick(500);
  assert.deepEqual(events, ["start"]);
  assert.equal(service.status().mode, "tap");
  service.setRuntimeState("listening");
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("up", "Fn");
  await keyMonitor.emit("down", "Fn"); // No extra start or stop during transcription.
  await keyMonitor.emit("up", "Fn");
  t.mock.timers.tick(500);
  assert.deepEqual(events, ["start", "finish"]);
});

test("one quick tap requests guidance and a late second tap does not lock recording", async (t) => {
  const { keyMonitor, events, cancelReasons } = await gestureService(t);
  await keyMonitor.emit("down", "Fn");
  t.mock.timers.tick(60);
  await keyMonitor.emit("up", "Fn");
  t.mock.timers.tick(299);
  assert.deepEqual(events, ["start"]);
  t.mock.timers.tick(1);
  assert.deepEqual(events, ["start", "cancel"]);
  assert.deepEqual(cancelReasons, ["short-press"]);
  t.mock.timers.tick(250);
  await keyMonitor.emit("down", "Fn");
  t.mock.timers.tick(500);
  await keyMonitor.emit("up", "Fn");
  assert.deepEqual(events, ["start", "cancel", "start", "finish"]);
});

test("brief holds up to 499 ms show guidance instead of transcribing", async (t) => {
  const { keyMonitor, events, cancelReasons } = await gestureService(t);
  for (const duration of [200, 350, 499]) {
    await keyMonitor.emit("down", "Fn");
    t.mock.timers.tick(duration);
    await keyMonitor.emit("up", "Fn");
    assert.equal(events.at(-1), "cancel", `${duration} ms is too short to dictate`);
    assert.equal(cancelReasons.at(-1), "short-press");
    t.mock.timers.tick(300);
  }
  assert.deepEqual(events, ["start", "cancel", "start", "cancel", "start", "cancel"]);
  await keyMonitor.emit("down", "Fn");
  t.mock.timers.tick(500);
  await keyMonitor.emit("up", "Fn");
  assert.equal(events.at(-1), "finish", "500 ms is a valid hold");
});

test("a press during completion debounce cannot latch or restart dictation", async (t) => {
  const { service, keyMonitor, events } = await gestureService(t);
  await keyMonitor.emit("down", "Fn");
  t.mock.timers.tick(500);
  await keyMonitor.emit("up", "Fn");
  service.setRuntimeState("success");
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("up", "Fn");
  assert.deepEqual(events, ["start", "finish"]);
  t.mock.timers.tick(250);
  await keyMonitor.emit("down", "Fn");
  t.mock.timers.tick(500);
  await keyMonitor.emit("up", "Fn");
  assert.deepEqual(events, ["start", "finish", "start", "finish"]);
});

test("Escape, monitor reset, and disposal clear a pending double-tap", async (t) => {
  const { service, keyMonitor, shortcuts, events } = await gestureService(t);
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("up", "Fn");
  shortcuts.callbacks.get("Escape")();
  t.mock.timers.tick(500);
  assert.deepEqual(events, ["start", "cancel"]);
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("up", "Fn");
  await keyMonitor.emit("reset");
  t.mock.timers.tick(500);
  assert.deepEqual(events, ["start", "cancel", "start", "cancel"]);
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("up", "Fn");
  service.dispose();
  t.mock.timers.tick(500);
  assert.deepEqual(events, ["start", "cancel", "start", "cancel", "start"]);
});

test("old saved Tap or Hold choices no longer decide shortcut behavior", async (t) => {
  const { service, keyMonitor, events } = await gestureService(t);
  await writeFile(service.settingsPath, JSON.stringify({ enabled: true, accelerator: "Fn", mode: "tap" }));
  await service.initialize();
  await keyMonitor.emit("down", "Fn");
  t.mock.timers.tick(500);
  await keyMonitor.emit("up", "Fn");
  assert.deepEqual(events, ["start", "finish"]);
  await writeFile(service.settingsPath, JSON.stringify({ enabled: true, accelerator: "Fn", mode: "hold" }));
  service.setRuntimeState("idle");
  t.mock.timers.tick(250);
  await service.initialize();
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("up", "Fn");
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("up", "Fn");
  t.mock.timers.tick(500);
  assert.equal(service.status().mode, "tap");
  assert.deepEqual(events, ["start", "finish", "start"]);
});

test("an empty dictation is a successful no-op that preserves rich clipboard data", async (t) => {
  const userDataDir = await tempDir();
  const clipboard = new FakeClipboard();
  let pasteCount = 0;
  const service = new SystemDictationService({
    userDataDir, platform: "darwin", globalShortcut: new FakeShortcuts(), clipboard,
    shell: { openExternal: async () => {} }, runPasteCommand: async () => { pasteCount += 1; },
    onToggle: () => {}, onCancel: () => {},
  });
  t.after(async () => { service.dispose(); await rm(userDataDir, { recursive: true, force: true }); });
  assert.deepEqual(await service.pasteText(" \n "), { pasted: false, copied: false, error: null });
  assert.equal(pasteCount, 0);
  assert.equal(clipboard.readText(), "before");
  assert.equal(clipboard.readBuffer("text/html").toString(), "<b>before</b>");
});

test("refreshAfterResume restarts the monitor and re-registers only a lost chord", async () => {
  const userDataDir = await tempDir();
  const keyMonitor = new FakeKeyMonitor();
  const service = new SystemDictationService({
    userDataDir,
    platform: "darwin",
    globalShortcut: new FakeShortcuts(),
    keyMonitor,
    clipboard: new FakeClipboard(),
    systemPreferences: { isTrustedAccessibilityClient: () => true },
    shell: { openExternal: async () => {} },
    runPasteCommand: async () => {},
    onToggle: () => {},
    onCancel: () => {},
  });

  await service.initialize();
  const disabled = await service.refreshAfterResume();
  assert.equal(keyMonitor.restarts, 0, "disabled dictation does nothing on resume");
  assert.equal(disabled.enabled, false);

  await service.setEnabled(true);
  const resumed = await service.refreshAfterResume();
  assert.equal(keyMonitor.restarts, 1, "the monitor is the component that dies across sleep");
  assert.equal(resumed.registered, true);
  service.dispose();
  await rm(userDataDir, { recursive: true, force: true });
});

test("refreshAfterResume re-registers the Electron chord the OS lost", async () => {
  const userDataDir = await tempDir();
  const shortcuts = new FakeShortcuts();
  let toggles = 0;
  const service = new SystemDictationService({
    userDataDir,
    platform: "win32",
    globalShortcut: shortcuts,
    clipboard: new FakeClipboard(),
    shell: { openExternal: async () => {} },
    runPasteCommand: async () => {},
    onToggle: () => { toggles += 1; },
    onCancel: () => {},
  });

  await service.initialize();
  const status = await service.setEnabled(true);
  assert.equal(status.registered, true);

  // Healthy chord: resume must NOT churn the registration (re-registering
  // opens a window where another app can steal it).
  const registersBefore = shortcuts.registerCount;
  await service.refreshAfterResume();
  assert.equal(shortcuts.registerCount, registersBefore);

  // Simulate the OS dropping the registration across a session change.
  shortcuts.callbacks.delete(status.accelerator);
  const restored = await service.refreshAfterResume();
  assert.equal(restored.registered, true);
  shortcuts.callbacks.get(status.accelerator)?.();
  assert.equal(toggles, 1);

  service.dispose();
  await rm(userDataDir, { recursive: true, force: true });
});
