import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ConfigGetOutput } from "@opencode/client";
import { ConfigCommand } from "@opencode/schema/config/command";
import { Option, Schema } from "effect";
import { parseFrontmatter } from "./frontmatter.js";
import type { CommandDefinitions } from "./native-command-schema.js";
export { commandDefinitionsSchema, encodeCommandDefinitions, type CommandDefinitions, type EncodedCommandDefinitions } from "./native-command-schema.js";

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info);

// This module also runs in Electron's Node process. Follow linked library
// folders without recursing through a symlink cycle or imposing a depth cap.
async function commandFiles(root: string, ancestors: ReadonlySet<string> = new Set()): Promise<string[]> {
  try {
    const canonical = await realpath(root);
    if (ancestors.has(canonical)) return [];
    const next = new Set([...ancestors, canonical]);
    const entries = await readdir(root, { withFileTypes: true });
    return (await Promise.all(entries.map(async entry => {
      const path = join(root, entry.name);
      try {
        const info = entry.isSymbolicLink() ? await stat(path) : entry;
        if (info.isDirectory()) return commandFiles(path, next);
        return info.isFile() && entry.name.endsWith(".md") ? [path] : [];
      } catch { return []; }
    }))).flat();
  } catch { return []; } // Match native discovery for missing/unreadable roots.
}

/** Mirrors the pinned native command loader, without its host shell execution.
 * Native entries already describe the effective roots in low-to-high order.
 * App selections follow them and retain their explicit override semantics. */
export async function resolveNativeCommandDefinitions(
  entries: ConfigGetOutput,
  appCommands: unknown = {},
): Promise<CommandDefinitions> {
  const commands = new Map<string, ConfigCommand.Info>();
  const add = (name: string, input: unknown) => {
    const command = decodeCommand(input);
    if (Option.isSome(command)) commands.set(name, command.value);
  };
  for (const entry of entries) {
    if (entry.type === "document") {
      for (const [name, command] of Object.entries(entry.info.commands ?? {})) add(name, command);
      continue;
    }
    const files = (await Promise.all(["command", "commands"].map(name => commandFiles(join(entry.path, name))))).flat();
    for (const file of files.sort()) {
      try {
        const markdown = parseFrontmatter(await readFile(file, "utf8"));
        const name = relative(entry.path, file).replaceAll("\\", "/")
          .replace(/^(command|commands)\//, "").replace(/\.md$/, "");
        add(name, { ...markdown.data, template: markdown.body.trim() });
      } catch { /* Native discovery ignores malformed/unreadable Markdown. */ }
    }
  }
  if (appCommands && typeof appCommands === "object" && !Array.isArray(appCommands)) {
    for (const [name, command] of Object.entries(appCommands)) add(name, command);
  }
  return { commands: Object.fromEntries(commands) };
}

