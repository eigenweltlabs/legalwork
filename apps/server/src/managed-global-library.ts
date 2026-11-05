import { lstat, mkdir, readFile, readdir, readlink, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { ConfigPlugin } from "@opencode/schema/config/plugin";
import { Option, Schema } from "effect";
import { withFileWriteLock } from "./file-write-lock.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { globalOpencodeConfigDir } from "./workspace-files.js";
import type { NativeConfig } from "./native-opencode-config.js";
import type { ServerConfig } from "./types.js";

const directories = ["agent", "agents", "mode", "modes", "command", "commands", "plugin", "plugins"];
const decodePlugins = Schema.decodeUnknownOption(ConfigPlugin.Plugins);
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const expandEnvironment = (value: string) => value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] || "");

function referencePath(source: string, value: string) {
  const expanded = expandEnvironment(value);
  return expanded.startsWith("~/") ? join(homedir(), expanded.slice(2))
    : isAbsolute(expanded) ? expanded : resolve(dirname(source), expanded);
}

/** Keep option secrets as native file references, rooted at their original source. */
function rebaseReferences(source: string, value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\{file:([^}]+)\}/g, (_, name: string) => `{file:${referencePath(source, name)}}`);
  if (Array.isArray(value)) return value.map(item => rebaseReferences(source, item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebaseReferences(source, item)]));
  return value;
}

async function resolveTarget(source: string, target: string): Promise<string> {
  let expanded = expandEnvironment(target);
  for (const match of [...expanded.matchAll(/\{file:([^}]+)\}/g)]) {
    const content = await readFile(referencePath(source, match[1]), "utf8").catch(() => "");
    expanded = expanded.replace(match[0], content.trim());
  }
  if (expanded.startsWith("-")) return expanded;
  return expanded.startsWith("file://") ? fileURLToPath(expanded)
    : expanded.startsWith("./") || expanded.startsWith("../") ? resolve(dirname(source), expanded) : expanded;
}

async function configuredPlugins(source: string): Promise<NonNullable<NativeConfig["plugins"]>> {
  let text: string;
  try { text = await readFile(source, "utf8"); }
  catch (error) { if (missing(error)) return []; throw error; }
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) return [];
  const document = Object.fromEntries(Object.entries(value));
  const configured = document.plugins ?? document.plugin;
  const parsed = decodePlugins(configured);
  if (Option.isNone(parsed)) return [];
  return Promise.all(parsed.value.map(async plugin => {
    if (typeof plugin === "string") return resolveTarget(source, plugin);
    const options = rebaseReferences(source, plugin.options);
    return new ConfigPlugin.Entry({ package: await resolveTarget(source, plugin.package),
      ...(options && typeof options === "object" && !Array.isArray(options) ? { options: Object.fromEntries(Object.entries(options)) } : {}) });
  }));
}

/** Expose only the shared library's package folders to native loaders. The
 * engine keeps its protected config directory and project discovery disabled.
 * Native agent/command parsing, identities and file watching remain upstream's.
 * No global profile file or project/ancestor path is created or changed here. */
export async function prepareManagedGlobalLibrary(config: ServerConfig): Promise<{ plugins: NativeConfig["plugins"] }> {
  const source = globalOpencodeConfigDir(), destination = orgPolicyEngineDir(config);
  if (resolve(source) === resolve(destination)) throw new Error("The protected engine directory must be separate from the shared library.");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await withFileWriteLock(join(destination, "managed-library-links.lock"), async () => {
    for (const name of directories) {
      const target = join(source, name), path = join(destination, name);
      const existing = await lstat(path).catch(error => { if (missing(error)) return undefined; throw error; });
      if (existing) {
        if (existing.isSymbolicLink() && resolve(dirname(path), await readlink(path)) === resolve(target)) continue;
        throw new Error(`The protected engine library entry is already occupied: ${path}`);
      }
      await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
    }
  });
  const plugins: NonNullable<NativeConfig["plugins"]>[number][] = [];
  for (const name of ["plugin", "plugins"]) {
    const entries = await readdir(join(source, name), { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error; });
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const info = entry.isSymbolicLink() ? await stat(join(source, name, entry.name)).catch(() => undefined) : entry;
      if (info?.isDirectory() || info?.isFile() && /\.(?:js|ts)$/.test(entry.name)) plugins.push(join(destination, name, entry.name));
    }
  }
  for (const name of ["opencode.json", "opencode.jsonc"]) plugins.push(...await configuredPlugins(join(source, name)));
  return { plugins };
}
