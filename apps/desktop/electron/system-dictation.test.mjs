import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SystemDictationService } from "./audio/system-dictation.mjs";

class FakeShortcuts {
  constructor(blocked = []) {
    this.blocked = new Set(blocked);
    this.callbacks = new Map();
  }

  register(accelerator, callback) {
    if (this.blocked.has(accelerator)) return false;
    this.callbacks.set(accelerator, callback);
    return true;
  }

  unregister(accelerator) {
    this.callbacks.delete(accelerator);
  }
}

class FakeKeyMonitor {
  isSupported() {
    return true;
  }

  async start(callback) {
    this.callback = callback;
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

test("native shortcut monitoring supports modifier-only capture and hold-to-talk", async () => {
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

  const hold = await service.setMode("hold");
  assert.equal(hold.mode, "hold");
  await keyMonitor.emit("down", "Fn");
  await keyMonitor.emit("down", "Control");
  assert.equal(presses, 1);
  await keyMonitor.emit("up", "Control");
  assert.equal(releases, 1);
  await keyMonitor.emit("up", "Fn");

  await service.setShortcutCapture(true);
  await keyMonitor.emit("down", "Control");
  await keyMonitor.emit("up", "Control");
  assert.equal(service.status().accelerator, "Control");
  await service.setMode("tap");
  await keyMonitor.emit("down", "Control");
  assert.equal(toggles, 1);
  await keyMonitor.emit("up", "Control");

  const stored = JSON.parse(await readFile(path.join(userDataDir, "system-dictation.json"), "utf8"));
  assert.equal(stored.accelerator, "Control");
  assert.equal(stored.mode, "tap");
  service.dispose();
  await rm(userDataDir, { recursive: true, force: true });
});
