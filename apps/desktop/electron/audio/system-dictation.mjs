import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SETTINGS_FILE = "system-dictation.json";
const RESTORE_DELAY_MS = 500;
const PASTE_DELAY_MS = 120;
const TAP_MAX_PRESS_MS = 200;
const MIN_HOLD_MS = 500;
const DOUBLE_TAP_GAP_MS = 300;
const RESTART_COOLDOWN_MS = 250;
const MODIFIER_KEYS = ["Fn", "Control", "Alt", "Shift", "Command", "Super"];
const NAMED_KEYS = new Set([
  "Space", "Backspace", "Tab", "Enter", "PageUp", "PageDown", "End", "Home",
  "Left", "Up", "Right", "Down", "Insert", "Delete",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} platform
 * @returns {import("@legalwork/types/audio").AudioSystemDictationPlatform}
 */
function normalizedPlatform(platform) {
  if (platform === "darwin" || platform === "linux") return platform;
  return platform === "win32" || platform === "windows" ? "windows" : "linux";
}

function candidateAccelerators(platform) {
  if (platform === "windows") {
    return ["Control+Super+D", "CommandOrControl+Shift+D", "F8", "F9"];
  }
  return ["CommandOrControl+Shift+D", "F8", "F9"];
}

function registerShortcut(globalShortcut, accelerator, callback) {
  try {
    return globalShortcut.register(accelerator, callback);
  } catch {
    return false;
  }
}

function acceleratorKeys(accelerator, platform) {
  const keys = String(accelerator ?? "")
    .split("+")
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => {
      if (key !== "CommandOrControl") return key;
      return platform === "darwin" ? "Command" : "Control";
    });
  return new Set(keys);
}

function acceleratorFromKeys(keys, platform) {
  const unique = [...new Set(keys)];
  const nonModifiers = unique.filter((key) => !MODIFIER_KEYS.includes(key));
  const validKey = (key) => /^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || NAMED_KEYS.has(key);
  if (
    unique.length === 0
    || nonModifiers.length > 1
    || nonModifiers.some((key) => !validKey(key))
    || unique.includes("Escape")
  ) return null;
  const modifierOrder = platform === "darwin"
    ? MODIFIER_KEYS
    : ["Control", "Alt", "Shift", "Super", "Fn", "Command"];
  const ordered = [
    ...modifierOrder.filter((key) => unique.includes(key)),
    ...nonModifiers,
  ];
  return ordered.join("+");
}

function snapshotClipboard(clipboard) {
  return clipboard.availableFormats().map((format) => ({
    format,
    data: clipboard.readBuffer(format),
  }));
}

function restoreClipboard(clipboard, snapshot) {
  clipboard.clear();
  for (const item of snapshot) clipboard.writeBuffer(item.format, item.data);
}

export class SystemDictationService {
  /**
   * @param {{
   *   userDataDir: string,
   *   platform?: string,
   *   globalShortcut: { register: (accelerator: string, callback: () => void) => boolean, unregister: (accelerator: string) => void, isRegistered?: (accelerator: string) => boolean },
   *   clipboard: { availableFormats: () => string[], readBuffer: (format: string) => Buffer, clear: () => void, writeBuffer: (format: string, data: Buffer) => void, readText: () => string, writeText: (text: string) => void },
   *   systemPreferences?: { isTrustedAccessibilityClient?: (prompt: boolean) => boolean },
   *   shell: { openExternal: (url: string) => Promise<unknown> },
   *   runPasteCommand: (platform: "darwin" | "windows" | "linux") => Promise<void>,
   *   keyMonitor?: { isSupported?: () => boolean, start: (onEvent: (event: { type: "down" | "up"; key: string } | { type: "reset" } | { type: "unavailable"; error: string }) => void | Promise<void>) => Promise<boolean>, stop: () => void, restart?: () => Promise<boolean> },
   *   onToggle: () => void,
   *   onPress?: () => void,
   *   onRelease?: () => void,
   *   onCancel: (reason?: "short-press") => void,
   *   onState?: (state: string, message: string, locale?: "en" | "de") => void,
   *   onStatus?: (status: import("@legalwork/types/audio").AudioSystemDictationStatus) => void,
   * }} options
   */
  constructor(options) {
    this.settingsPath = path.join(options.userDataDir, SETTINGS_FILE);
    this.platform = normalizedPlatform(options.platform ?? process.platform);
    this.globalShortcut = options.globalShortcut;
    this.clipboard = options.clipboard;
    this.systemPreferences = options.systemPreferences;
    this.shell = options.shell;
    this.runPasteCommand = options.runPasteCommand;
    this.keyMonitor = options.keyMonitor;
    this.onToggle = options.onToggle;
    this.onPress = options.onPress ?? options.onToggle;
    this.onRelease = options.onRelease ?? options.onToggle;
    this.onCancel = options.onCancel;
    this.onState = options.onState ?? (() => {});
    this.onStatus = options.onStatus ?? (() => {});
    this.enabled = false;
    this.registered = false;
    this.registeredAccelerator = null;
    this.accelerator = candidateAccelerators(this.platform)[0];
    this.defaultAccelerator = this.accelerator;
    this.customAccelerator = false;
    /** @type {import("@legalwork/types/audio").AudioSystemDictationMode} */
    this.mode = "tap";
    this.runtimeState = "idle";
    this.gesture = null;
    this.gestureTimer = null;
    this.shortcutPressedAt = 0;
    this.settledAt = 0;
    this.shortcutCaptureActive = false;
    this.capturePrevious = null;
    this.captureChord = new Set();
    this.pressedKeys = new Set();
    this.shortcutTriggered = false;
    this.monitorAvailable = false;
    this.error = null;
    this.escapeRegistered = false;
    this.pasteQueue = Promise.resolve({ pasted: false, copied: false, error: null });
  }

  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, "utf8"));
      this.enabled = parsed?.enabled === true;
      if (typeof parsed?.accelerator === "string" && parsed.accelerator.trim()) {
        this.accelerator = parsed.accelerator.trim();
        this.customAccelerator = parsed.customAccelerator === true;
      }
    } catch {
      this.enabled = false;
    }
    if (this.enabled) await this.ensureKeyMonitor();
    this.applyRegistration();
    return this.status();
  }

  /** @returns {"granted" | "needed" | "not-required"} */
  accessibilityStatus() {
    if (this.platform !== "darwin") return "not-required";
    try {
      return this.systemPreferences?.isTrustedAccessibilityClient?.(false) ? "granted" : "needed";
    } catch {
      return "needed";
    }
  }

  /** @returns {import("@legalwork/types/audio").AudioSystemDictationStatus} */
  status() {
    return {
      enabled: this.enabled,
      registered: this.registered,
      accelerator: this.accelerator,
      defaultAccelerator: this.defaultAccelerator,
      customAccelerator: this.customAccelerator,
      mode: this.mode,
      supportsHold: this.monitorAvailable || (
        !this.enabled && this.keyMonitor?.isSupported?.() === true
      ),
      shortcutCaptureActive: this.shortcutCaptureActive,
      platform: this.platform,
      accessibility: this.accessibilityStatus(),
      error: this.error,
    };
  }

  applyRegistration() {
    this.unregisterPrimaryShortcut();
    this.error = null;
    if (!this.enabled || this.shortcutCaptureActive) return;

    const keys = acceleratorKeys(this.accelerator, this.platform);
    if (!acceleratorFromKeys(keys, this.platform)) {
      this.error = "Choose one key or a modifier combination for dictation.";
      return;
    }
    if (this.monitorAvailable) {
      this.registered = true;
      return;
    }
    const candidates = this.customAccelerator
      ? [this.accelerator]
      : [this.accelerator, ...candidateAccelerators(this.platform).filter((item) => item !== this.accelerator)];
    for (const accelerator of candidates) {
      if (registerShortcut(this.globalShortcut, accelerator, () => this.toggleHandsFree())) {
        this.accelerator = accelerator;
        this.registered = true;
        this.registeredAccelerator = accelerator;
        return;
      }
    }
    this.error = "No system-wide dictation shortcut is available. Another app may be using it.";
  }

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled) await this.ensureKeyMonitor();
    else this.stopKeyMonitor();
    this.applyRegistration();
    await this.persist();
    return this.status();
  }

  async setShortcut(accelerator) {
    const next = String(accelerator ?? "").trim();
    if (!next) return { ...this.status(), error: "Press a shortcut before saving." };
    const previous = {
      accelerator: this.accelerator,
      customAccelerator: this.customAccelerator,
      registered: this.registered,
    };
    this.unregisterPrimaryShortcut();
    this.accelerator = next;
    this.customAccelerator = next !== this.defaultAccelerator;
    this.registered = false;
    this.error = null;

    if (!acceleratorFromKeys(acceleratorKeys(next, this.platform), this.platform)) {
      this.accelerator = previous.accelerator;
      this.customAccelerator = previous.customAccelerator;
      this.applyRegistration();
      this.error = "Choose one key or a modifier combination for dictation.";
      return this.status();
    }
    this.applyRegistration();
    if (this.enabled && !this.shortcutCaptureActive && !this.registered) {
      this.accelerator = previous.accelerator;
      this.customAccelerator = previous.customAccelerator;
      this.applyRegistration();
      this.error = `Could not register ${next}. Choose another shortcut.`;
      return this.status();
    }
    if (this.shortcutCaptureActive) return this.status();
    await this.persist();
    return this.status();
  }

  persist() {
    return writeFile(
      this.settingsPath,
      `${JSON.stringify({
        enabled: this.enabled,
        accelerator: this.accelerator,
        customAccelerator: this.customAccelerator,
      }, null, 2)}\n`,
      "utf8",
    );
  }

  async setShortcutCapture(active) {
    const next = Boolean(active);
    if (this.shortcutCaptureActive === next) return this.status();
    if (next) await this.ensureKeyMonitor();
    const previous = this.capturePrevious;
    if (next) {
      this.capturePrevious = {
        accelerator: this.accelerator,
        customAccelerator: this.customAccelerator,
      };
      this.captureChord.clear();
      this.pressedKeys.clear();
      this.resetShortcutTrigger(false);
    } else {
      this.captureChord.clear();
      this.capturePrevious = null;
    }
    this.shortcutCaptureActive = next;
    this.applyRegistration();
    if (!next && this.enabled && !this.registered && previous) {
      const failure = this.error;
      this.accelerator = previous.accelerator;
      this.customAccelerator = previous.customAccelerator;
      this.applyRegistration();
      this.error = failure;
    }
    if (!next) {
      await this.persist();
      if (!this.enabled) this.stopKeyMonitor();
    }
    return this.status();
  }

  async ensureKeyMonitor() {
    if (this.monitorAvailable || !this.keyMonitor || this.keyMonitor.isSupported?.() === false) {
      return this.monitorAvailable;
    }
    this.monitorAvailable = await this.keyMonitor.start((event) => this.handleMonitorEvent(event));
    return this.monitorAvailable;
  }

  stopKeyMonitor() {
    this.keyMonitor?.stop();
    this.monitorAvailable = false;
    this.pressedKeys.clear();
    this.resetShortcutTrigger(true);
  }

  unregisterPrimaryShortcut() {
    if (this.registeredAccelerator) this.globalShortcut.unregister(this.registeredAccelerator);
    this.registeredAccelerator = null;
    this.registered = false;
  }

  resetShortcutTrigger(release) {
    const gesture = this.gesture;
    this.clearGesture();
    this.shortcutTriggered = false;
    if (release && gesture === "hold") this.onRelease();
    if (release && gesture === "tap-pending") this.onCancel();
  }

  clearGesture() {
    clearTimeout(this.gestureTimer);
    this.gestureTimer = null;
    this.gesture = null;
  }

  toggleHandsFree() {
    if (["transcribing", "inserting"].includes(this.runtimeState) || this.gesture === "finishing") return;
    if (Date.now() - this.settledAt < RESTART_COOLDOWN_MS) return;
    const active = ["starting", "listening"].includes(this.runtimeState) || this.gesture === "hands-free";
    this.clearGesture();
    this.gesture = active ? "finishing" : "hands-free";
    this.mode = "tap";
    this.onStatus(this.status());
    this.onToggle();
  }

  pressShortcut() {
    if (Date.now() - this.settledAt < RESTART_COOLDOWN_MS) return;
    if (this.gesture === "tap-pending") {
      // Keep the capture opened by the first press; the second tap only
      // removes the requirement to keep holding the shortcut.
      this.clearGesture();
      this.gesture = "hands-free";
      this.mode = "tap";
      this.onStatus(this.status());
      return;
    }
    if (this.gesture === "hands-free") {
      this.gesture = "finishing";
      this.onRelease();
      return;
    }
    if (["transcribing", "inserting"].includes(this.runtimeState) || this.gesture === "finishing") return;
    if (["starting", "listening"].includes(this.runtimeState)) {
      this.toggleHandsFree();
      return;
    }
    this.gesture = "hold";
    this.mode = "hold";
    this.shortcutPressedAt = Date.now();
    this.onStatus(this.status());
    this.onPress();
  }

  releaseShortcut() {
    if (this.gesture !== "hold") return;
    const heldMs = Date.now() - this.shortcutPressedAt;
    if (heldMs >= MIN_HOLD_MS) {
      this.gesture = "finishing";
      this.onRelease();
      return;
    }
    if (heldMs >= TAP_MAX_PRESS_MS) {
      this.gesture = "finishing";
      this.onCancel("short-press");
      return;
    }
    this.gesture = "tap-pending";
    this.gestureTimer = setTimeout(() => {
      this.gestureTimer = null;
      this.gesture = "finishing";
      this.onCancel("short-press");
    }, DOUBLE_TAP_GAP_MS);
  }

  async handleMonitorEvent(event) {
    if (event.type === "unavailable") {
      this.monitorAvailable = false;
      this.pressedKeys.clear();
      this.resetShortcutTrigger(true);
      this.applyRegistration();
      if (!this.registered && !this.error) this.error = event.error;
      this.onStatus(this.status());
      return;
    }

    if (event.type === "reset") {
      // The monitor (or its in-process tap) was recreated — key-ups emitted
      // while it was down are gone, so any held-chord bookkeeping is stale.
      // Releasing a latched hold finalizes that dictation instead of leaving
      // it recording forever. A partly-captured chord is discarded too, so
      // the next key-up can't commit half a pre-reset combination.
      this.pressedKeys.clear();
      this.captureChord.clear();
      this.resetShortcutTrigger(true);
      return;
    }

    if (event.type === "down") {
      if (this.pressedKeys.has(event.key)) return;
      this.pressedKeys.add(event.key);
      if (this.shortcutCaptureActive) {
        if (event.key === "Escape") {
          await this.setShortcutCapture(false);
          this.onStatus(this.status());
          return;
        }
        this.captureChord.add(event.key);
        return;
      }
      if (!this.enabled || !this.registered || this.shortcutTriggered) return;
      const expected = acceleratorKeys(this.accelerator, this.platform);
      if ([...expected].every((key) => this.pressedKeys.has(key))) {
        this.shortcutTriggered = true;
        this.pressShortcut();
      }
      return;
    }

    this.pressedKeys.delete(event.key);
    if (this.shortcutCaptureActive) {
      if (this.captureChord.size > 0 && [...this.captureChord].every((key) => !this.pressedKeys.has(key))) {
        await this.commitCapturedShortcut();
      }
      return;
    }
    if (!this.shortcutTriggered) return;
    const expected = acceleratorKeys(this.accelerator, this.platform);
    if ([...expected].some((key) => !this.pressedKeys.has(key))) {
      this.shortcutTriggered = false;
      this.releaseShortcut();
    }
  }

  async commitCapturedShortcut() {
    const next = acceleratorFromKeys(this.captureChord, this.platform);
    this.captureChord.clear();
    if (!next) {
      this.error = "Choose one key or a modifier combination for dictation.";
      this.onStatus(this.status());
      return;
    }
    const previous = this.capturePrevious;
    this.shortcutCaptureActive = false;
    this.capturePrevious = null;
    this.accelerator = next;
    this.customAccelerator = next !== this.defaultAccelerator;
    this.applyRegistration();
    if (this.enabled && !this.registered && previous) {
      this.accelerator = previous.accelerator;
      this.customAccelerator = previous.customAccelerator;
      this.applyRegistration();
    } else {
      await this.persist();
    }
    if (!this.enabled) this.stopKeyMonitor();
    this.onStatus(this.status());
  }

  /**
   * Post-wake / post-unlock health check. The native key monitor is the
   * component that verifiably dies across sleep and session transitions, so
   * it is restarted outright. The Electron chord registration is OS-held and
   * survives sleep by construction — re-registering it blind would open a
   * window where another app can steal the chord, so it is only re-applied
   * when the OS reports it lost.
   */
  async refreshAfterResume() {
    if (!this.enabled) return this.status();
    const hadMonitor = this.monitorAvailable;
    if (this.keyMonitor) {
      // Key state recorded before sleep is meaningless now; clear it without
      // firing onRelease — suspend already canceled any active dictation. A
      // chord half-captured before sleep is dropped too, so the first key-up
      // after wake can't silently commit it as the new shortcut.
      this.pressedKeys.clear();
      this.captureChord.clear();
      this.resetShortcutTrigger(false);
      if (hadMonitor && typeof this.keyMonitor.restart === "function") {
        this.monitorAvailable = await this.keyMonitor.restart();
      } else if (!hadMonitor && this.keyMonitor.isSupported?.() !== false) {
        this.monitorAvailable = await this.keyMonitor.start((event) => this.handleMonitorEvent(event));
      }
    }
    const monitorChanged = this.monitorAvailable !== hadMonitor;
    const chordLost =
      this.registeredAccelerator !== null
      && typeof this.globalShortcut.isRegistered === "function"
      && !this.globalShortcut.isRegistered(this.registeredAccelerator);
    if (monitorChanged || chordLost || !this.registered) this.applyRegistration();
    this.onStatus(this.status());
    return this.status();
  }

  async openSettings() {
    if (this.platform === "darwin") {
      const accessibilityNeeded = this.accessibilityStatus() !== "granted";
      try {
        this.systemPreferences?.isTrustedAccessibilityClient?.(true);
      } catch {
        // The deep link below remains the reliable manual path.
      }
      await this.shell.openExternal(
        accessibilityNeeded || this.monitorAvailable
          ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
          : "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
      );
    } else if (this.platform === "windows") {
      await this.shell.openExternal("ms-settings:privacy-microphone");
    }
    return this.status();
  }

  setRuntimeState(state, message = "", locale = "en") {
    if (["success", "cancelled", "error"].includes(state) || (state === "idle" && this.runtimeState !== "idle")) {
      this.settledAt = Date.now();
    }
    this.runtimeState = state;
    if (!["starting", "listening"].includes(state)) this.clearGesture();
    const cancellable = ["starting", "listening", "transcribing"].includes(state);
    if (cancellable && !this.escapeRegistered) {
      this.escapeRegistered = registerShortcut(this.globalShortcut, "Escape", () => {
        this.clearGesture();
        this.onCancel();
      });
    } else if (!cancellable && this.escapeRegistered) {
      this.globalShortcut.unregister("Escape");
      this.escapeRegistered = false;
    }
    this.onState(state, message, locale === "de" ? "de" : "en");
    return this.status();
  }

  pasteText(text) {
    const value = String(text ?? "").trim();
    this.pasteQueue = this.pasteQueue
      .catch(() => ({ pasted: false, copied: false, error: null }))
      .then(() => this.performPaste(value));
    return this.pasteQueue;
  }

  async performPaste(text) {
    if (!text) return { pasted: false, copied: false, error: null };

    let snapshot = [];
    try {
      snapshot = snapshotClipboard(this.clipboard);
    } catch {
      // Text still gets copied even if an unusual clipboard format cannot be read.
    }
    this.clipboard.writeText(text);

    if (this.platform === "darwin" && this.accessibilityStatus() !== "granted") {
      return {
        pasted: false,
        copied: true,
        error: "Accessibility is not enabled. The dictation was copied; press Command+V to paste it.",
      };
    }
    if (this.platform === "linux") {
      return {
        pasted: false,
        copied: true,
        error: "Automatic paste is currently available on macOS and Windows. The dictation was copied.",
      };
    }

    try {
      await sleep(PASTE_DELAY_MS);
      await this.runPasteCommand(this.platform);
    } catch (error) {
      return {
        pasted: false,
        copied: true,
        error: `Could not paste automatically. The dictation was copied: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    await sleep(RESTORE_DELAY_MS);
    if (snapshot.length > 0 && this.clipboard.readText() === text) {
      try {
        restoreClipboard(this.clipboard, snapshot);
      } catch {
        // Paste succeeded; failing to restore an exotic format must not report insertion failure.
      }
    }
    return { pasted: true, copied: true, error: null };
  }

  dispose() {
    this.clearGesture();
    this.unregisterPrimaryShortcut();
    if (this.escapeRegistered) this.globalShortcut.unregister("Escape");
    this.escapeRegistered = false;
    this.keyMonitor?.stop();
  }
}
