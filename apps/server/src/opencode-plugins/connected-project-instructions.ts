import type { Plugin } from "@opencode/plugin";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { registerAppStateReminders } from "./native-app-state-reminders.js";
import { z } from "zod";

const within = (root: string, path: string) => {
  const suffix = relative(root, path);
  return !suffix || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
};

/** Native reads skip nearby instructions outside their Location. Preserve the
 * primary content folder's nested scopes through durable native tool context,
 * including Code Mode, without changing any file-tool input or system prefix. */
export async function registerConnectedProjectInstructions(ctx: Plugin.Context, roots: { directory: string; contentPath?: string }) {
  if (!roots.contentPath || within(resolve(roots.directory), resolve(roots.contentPath))) return async () => {};
  const contentPath = roots.contentPath;
  const folders = new Map<string, Set<string>>();
  const restored = new Set<string>();
  const collect = await ctx.tool.hook("execute.after", async event => {
    if (event.tool !== "read" || event.status !== "completed" || !event.input || typeof event.input !== "object") return;
    const value: unknown = Reflect.get(event.input, "path") ?? Reflect.get(event.input, "filePath");
    if (typeof value !== "string") return;
    try {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (!within(resolve(roots.directory), resolve(session.location.directory))) return;
      const target = await realpath(resolve(session.location.directory, value.startsWith("~/") ? join(homedir(), value.slice(2)) : value));
      const root = await realpath(contentPath);
      if (!within(root, target)) return;
      const scoped = folders.get(event.sessionID) ?? new Set<string>();
      let folder = (await stat(target)).isDirectory() ? target : dirname(target);
      while (folder !== root && within(root, folder)) { scoped.add(folder); folder = dirname(folder); }
      folders.set(event.sessionID, scoped);
    } catch { /* The read is complete; a disconnected source cannot fail it retroactively. */ }
  });
  const reminders = await registerAppStateReminders(ctx, {
    topic: "connected-document-instructions",
    cleared: "Previously loaded nested document instructions no longer apply.",
    async read(sessionID, _directory, previousState) {
      const scoped = folders.get(sessionID) ?? new Set<string>();
      const root = await realpath(contentPath).catch(() => null);
      if (!root) return null;
      if (!restored.has(sessionID)) {
        const saved = previousState?.match(/^<!-- legalwork-document-scopes: (.*) -->\n/);
        if (saved) {
          try {
            for (const folder of z.array(z.string()).parse(JSON.parse(saved[1]))) if (folder !== root && within(root, folder)) scoped.add(folder);
          } catch { /* Old context without valid scope metadata is rediscovered by reads. */ }
        }
        restored.add(sessionID); folders.set(sessionID, scoped);
      }
      if (!scoped.size) return "";
      const notes: string[] = [];
      for (const folder of [...scoped].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
        const path = join(folder, "AGENTS.md");
        const canonical = await realpath(path).catch(() => null);
        if (!canonical || !within(root, canonical)) continue;
        const text = await readFile(canonical, "utf8").catch(() => null);
        if (text === null) return null;
        notes.push(`Instructions from: ${path}\nScope: files inside ${folder} and its subfolders.\n${text}`);
      }
      return `<!-- legalwork-document-scopes: ${JSON.stringify([...scoped].sort())} -->\n${notes.join("\n\n")}`;
    },
  });
  return async () => { reminders(); await collect.dispose(); folders.clear(); restored.clear(); };
}
