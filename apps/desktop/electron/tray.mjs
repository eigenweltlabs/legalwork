/**
 * Tray / menu-bar presence while LegalWork runs in the background.
 *
 * Created whenever the app must stay reachable without a visible window:
 * "Dictate anywhere" is enabled, or a recording is running behind a closed
 * window. Without it, a hidden window on Windows (no taskbar entry) leaves
 * the user no way back into the app.
 *
 * The Tray reference is held on the instance deliberately: a garbage
 * collected Tray disappears from the OS bar (Electron FAQ).
 */

import { Menu, Tray } from "electron";

export class AppTray {
  /**
   * @param {{
   *   appName: string,
   *   icon: import("electron").NativeImage | null,
   *   onOpen: () => void,
   *   onQuit: () => void,
   * }} options
   */
  constructor(options) {
    this.appName = options.appName;
    this.icon = options.icon;
    this.onOpen = options.onOpen;
    this.onQuit = options.onQuit;
    /** @type {Tray | null} */
    this.tray = null;
  }

  /**
   * @param {{ dictationEnabled: boolean, shortcutLabel: string | null }} state
   */
  ensure(state) {
    if (!this.tray) {
      let image = this.icon;
      try {
        if (image && !image.isEmpty()) image = image.resize({ width: 18, height: 18 });
      } catch {
        image = this.icon;
      }
      if (!image || image.isEmpty()) return;
      this.tray = new Tray(image);
      this.tray.setToolTip(this.appName);
      // Windows convention: single click restores the window. On macOS the
      // click opens the context menu (set below) like other menu-bar extras.
      if (process.platform !== "darwin") {
        this.tray.on("click", () => this.onOpen());
      }
    }
    const dictationLabel = state.dictationEnabled
      ? state.shortcutLabel
        ? `Dictation ready (${state.shortcutLabel})`
        : "Dictation ready"
      : "Dictation off";
    const menu = Menu.buildFromTemplate([
      { label: `Open ${this.appName}`, click: () => this.onOpen() },
      { type: "separator" },
      { label: dictationLabel, enabled: false },
      { type: "separator" },
      { label: `Quit ${this.appName}`, click: () => this.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  /** Windows-only hint the first time the window hides instead of closing. */
  displayCloseHint() {
    if (process.platform !== "win32" || !this.tray) return;
    try {
      this.tray.displayBalloon({
        title: this.appName,
        content: `${this.appName} keeps running here so your dictation shortcut stays available. Right-click the icon to quit.`,
      });
    } catch {
      // Balloon support varies; the tray icon itself is the fallback.
    }
  }

  isActive() {
    return this.tray !== null;
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
}
