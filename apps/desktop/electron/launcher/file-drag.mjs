import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Prepare before the gesture: no HTTP, icon loading or async filesystem work at drag start.
 * Tokens are short-lived, single-use and bound to the originating renderer.
 * @template {{ isEmpty: () => boolean }} Image
 */
export class LauncherFileDrag {
  /** @param {{ icon: (file: string) => Promise<Image>, now?: () => number }} options */
  constructor({ icon, now = Date.now }) {
    this.icon = icon;
    this.now = now;
    /** @type {Map<string, { owner: number, source: string, file: string, root: string, icon: Image, expires: number }>} */
    this.entries = new Map();
  }
  /** @param {number} owner @param {{ path: string, root: string }[]} paths */
  async prepare(owner, paths) {
    if (!Array.isArray(paths) || paths.length > 100 || paths.some(item => !item || [item.path, item.root].some(file => typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")))) throw new Error("Choose up to 100 local files or folders.");
    for (const [token, item] of this.entries) if (item.expires <= this.now()) this.entries.delete(token);
    // Query caches can revisit a still-fresh result set; newer preparations must not revoke it.
    while (this.entries.size > 2000) this.entries.delete(this.entries.keys().next().value);
    const prepared = await Promise.all([...new Map(paths.map(item => [item.path, item])).values()].map(async ({ path: file, root: sourceRoot }) => {
      try {
        const root = await realpath(sourceRoot), canonical = await realpath(file), info = await stat(canonical);
        if (canonical !== root && !canonical.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return null;
        if (!info.isFile() && !info.isDirectory()) return null;
        const icon = await this.icon(canonical);
        if (icon.isEmpty()) return null;
        const token = randomUUID();
        this.entries.set(token, { owner, source: file, file: canonical, root, icon, expires: this.now() + 60_000 });
        return { path: file, token };
      } catch { return null; } // A removed/unavailable result must not disable unrelated files.
    }));
    return prepared.filter(item => item !== null);
  }
  /** @param {{ id: number, startDrag: (item: { file: string, files: string[], icon: Image }) => void }} sender @param {string[]} tokens */
  start(sender, tokens) {
    if (!Array.isArray(tokens) || !tokens.length || tokens.length > 100) throw new Error("Choose up to 100 local files or folders.");
    const items = [...new Set(tokens)].map(token => {
      const item = this.entries.get(token);
      if (!item || item.owner !== sender.id || item.expires <= this.now()) throw new Error("The file selection has changed. Select it again before dragging.");
      // A path swapped for a symlink after preparation must not change the exported source.
      if (realpathSync(item.source) !== item.file || realpathSync(item.root) !== item.root) throw new Error("The file location has changed.");
      const info = statSync(item.file);
      if (!info.isFile() && !info.isDirectory()) throw new Error("The file is no longer available.");
      return item;
    });
    tokens.forEach(token => this.entries.delete(token));
    sender.startDrag({ file: items[0].file, files: [...new Set(items.map(item => item.file))], icon: items[0].icon });
  }
}
