import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { canonicalFilePath, withFileWriteLock } from "./file-write-lock.js";
import { readLegalworkWorkspaceConfig, writeLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const catalogID = "__native_engine_approved_plugins__";
const catalogSchema = z.object({ identities: z.array(z.string()) });
export type ProjectPluginTarget = { target: string; identity: string; sources: string[] };

/** The released loader applies policies to npm package identities, stripping
 * versions. Local targets retain their absolute path. Do not promise a native
 * version lock that this public policy mechanism does not enforce. */
export function nativePluginIdentity(target: string) {
  const version = target.lastIndexOf("@");
  return isAbsolute(target) || version <= 0 ? target : target.slice(0, version);
}

export async function approvedNativePluginIdentities(config: ServerConfig): Promise<string[]> {
  const parsed = catalogSchema.safeParse(await readLegalworkWorkspaceConfig(config, catalogID));
  return parsed.success ? parsed.data.identities : [];
}

export async function approveNativePluginTargets(config: ServerConfig, targets: string[]): Promise<void> {
  await withFileWriteLock(join(runtimeStorageDir(config), "native-plugin-approvals.lock"), async () => {
    const identities = new Set(await approvedNativePluginIdentities(config));
    targets.forEach(target => identities.add(nativePluginIdentity(target)));
    await writeLegalworkWorkspaceConfig(config, catalogID, () => ({ identities: [...identities].sort() }));
  });
}

async function substituteTarget(source: string, original: string): Promise<string> {
  let result = original.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] || "");
  for (const match of [...result.matchAll(/\{file:[^}]+\}/g)]) {
    const file = match[0].slice(6, -1);
    const expanded = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
    const content = await readFile(isAbsolute(expanded) ? expanded : resolve(dirname(source), expanded), "utf8").catch(() => "");
    result = result.replace(match[0], content.trim());
  }
  return result;
}

/** Only executable target metadata is returned; provider/MCP credentials and
 * other configuration values never leave the private config reader. */
export async function discoverProjectPluginTargets(directory: string, excludedDocuments: string[] = [], resolveReferences = false): Promise<ProjectPluginTarget[]> {
  const excluded = new Set(await Promise.all(excludedDocuments.map(canonicalFilePath)));
  const targets = new Map<string, { identity: string; sources: Set<string> }>();
  const add = async (target: string, source: string, base: string) => {
    if (!target || target.startsWith("-") || target.startsWith("opencode.") || target === "*" || target.endsWith(".*")) return;
    const dynamic = /\{(?:env|file):[^}]+\}/.test(target);
    const value = dynamic && resolveReferences ? await substituteTarget(source, target) : target;
    const normalize = (item: string) => item.startsWith("file://") ? fileURLToPath(item)
      : item.startsWith("./") || item.startsWith("../") ? resolve(base, item) : item;
    const label = dynamic ? target : normalize(target);
    const entry = targets.get(label) ?? { identity: dynamic && !resolveReferences ? `unresolved:${target}` : nativePluginIdentity(normalize(value)), sources: new Set<string>() };
    entry.sources.add(source); targets.set(label, entry);
  };
  let current = directory;
  while (true) {
    for (const base of [current, join(current, ".opencode")]) {
      for (const name of ["opencode.json", "opencode.jsonc"]) {
        const source = join(base, name);
        if (excluded.has(await canonicalFilePath(source))) continue;
        let text: string;
        try { text = await readFile(source, "utf8"); }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
        const errors: ParseError[] = [];
        const value: unknown = parse(text, errors, { allowTrailingComma: true });
        if (errors.length) throw new ApiError(409, "project_engine_configuration_conflict", "An authored OpenCode configuration is not valid JSONC. Correct it before approving project automation.", { path: source });
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        for (const [key, configured] of Object.entries(value)) {
          if (!["plugin", "plugins"].includes(key) || !Array.isArray(configured)) continue;
          for (const item of configured) {
            if (typeof item === "string") await add(item, source, base);
            else if (item && typeof item === "object" && "package" in item && typeof item.package === "string") await add(item.package, source, base);
          }
        }
      }
    }
    for (const name of ["plugin", "plugins"]) {
      const base = join(current, ".opencode", name);
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const target = join(base, entry.name), info = entry.isSymbolicLink() ? await stat(target).catch(() => null) : entry;
        if (info?.isDirectory() || info?.isFile() && /\.(ts|js)$/.test(entry.name)) await add(target, base, current);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...targets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([target, entry]) => ({ target, identity: entry.identity, sources: [...entry.sources].sort() }));
}


/** Explicit shared-library selections are trusted privately; preserve native
 * variable lookup without returning resolved values in project review text. */
export async function managedNativePluginTargets(config: ServerConfig, targets: string[]): Promise<string[]> {
  const source = join(runtimeStorageDir(config), "runtime-opencode-config.json");
  const values = await Promise.all(targets.map(target => substituteTarget(source, target)));
  return values.filter(target => target && !target.startsWith("-") && !target.startsWith("opencode.") && target !== "*" && !target.endsWith(".*")).map(target => target.startsWith("file://") ? fileURLToPath(target)
    : target.startsWith("./") || target.startsWith("../") ? resolve(dirname(source), target) : target);
}
