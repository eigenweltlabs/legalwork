import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

const FILE = "launcher.json";
export const LAUNCHER_SEARCH_KINDS = ["files", "projects", "chats", "tasks", "recordings"];
/** @type {Readonly<import("@legalwork/types/launcher").LauncherSettings>} */
export const DEFAULT_LAUNCHER_SETTINGS = Object.freeze({
  shortcut: "CommandOrControl+Shift+Space", backgroundPresence: false, autostart: false, companion: false, companionBadge: true,
  aliases: { files: "f", projects: "p", chats: "c", tasks: "t", recordings: "r" }, actionShortcuts: {}, pinned: false, rememberPosition: true,
});
const ACCELERATOR = /^[A-Za-z0-9+]{1,60}$/;

/**
 * Validate a settings patch field by field; unknown or malformed values keep the current value.
 * @param {unknown} input
 * @param {import("@legalwork/types/launcher").LauncherSettings} [current]
 * @returns {import("@legalwork/types/launcher").LauncherSettings}
 */
export function normalizeLauncherSettings(input, current = DEFAULT_LAUNCHER_SETTINGS) {
  /** @type {import("@legalwork/types/launcher").LauncherSettings} */
  const next = { ...DEFAULT_LAUNCHER_SETTINGS, ...current, pinned: false, aliases: { ...current.aliases }, actionShortcuts: { ...current.actionShortcuts } };
  if (!input || typeof input !== "object") return next;
  const patch = /** @type {Record<string, unknown>} */ (input);
  if (typeof patch.shortcut === "string" && ACCELERATOR.test(patch.shortcut.trim())) next.shortcut = patch.shortcut.trim();
  for (const key of /** @type {const} */ (["backgroundPresence", "autostart", "companion", "companionBadge", "rememberPosition"])) if (typeof patch[key] === "boolean") next[key] = patch[key];
  if (patch.aliases && typeof patch.aliases === "object") {
    const aliases = /** @type {Record<string, unknown>} */ (patch.aliases);
    for (const kind of /** @type {const} */ (["files", "projects", "chats", "tasks", "recordings"])) {
      const value = typeof aliases[kind] === "string" ? aliases[kind].trim().toLowerCase() : "";
      if (/^[a-z0-9]{1,3}$/.test(value)) next.aliases[kind] = value;
    }
  }
  if (patch.actionShortcuts && typeof patch.actionShortcuts === "object") {
    next.actionShortcuts = {};
    for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (patch.actionShortcuts))) if (id.length <= 200 && typeof value === "string" && ACCELERATOR.test(value.trim())) next.actionShortcuts[id] = value.trim();
  }
  return next;
}

/** Persisted beside the dictation settings; writes are atomic so a crash never leaves a half file. */
export class LauncherSettingsStore {
  constructor(userDataDir) {
    this.path = path.join(userDataDir, FILE);
    /** @type {import("@legalwork/types/launcher").LauncherSettings} */
    this.settings = { ...DEFAULT_LAUNCHER_SETTINGS, aliases: { ...DEFAULT_LAUNCHER_SETTINGS.aliases }, actionShortcuts: {} };
    this.writes = Promise.resolve();
  }
  async load() {
    try { this.settings = normalizeLauncherSettings(JSON.parse(await readFile(this.path, "utf8"))); }
    catch { /* First run or unreadable file: defaults apply. */ }
    return this.settings;
  }
  get() { return this.settings; }
  async update(patch) {
    this.settings = normalizeLauncherSettings(patch, this.settings);
    const snapshot = JSON.stringify(this.settings, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, "utf8");
      await rename(temporary, this.path);
    });
    await this.writes;
    return this.settings;
  }
}
