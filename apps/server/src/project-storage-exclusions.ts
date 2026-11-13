import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

export const projectStorageExclusionsVersion = 1;
const supportFolders = [".opencode", ".legalwork", ".opencode.legalwork-migrated", ".legalwork.legalwork-migrated"];
const dependencyCaches = new Set(["node_modules", ".pnpm-store", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", ".parcel-cache", ".vite"]);
const browserCaches = new Set(["Cache", "Code Cache", "GPUCache", "GPUPersistentCache", "ShaderCache", "GrShaderCache", "DawnCache", "DawnGraphiteCache", "GraphiteDawnCache", "component_crx_cache"]);
const matches = (name: string, expected: string) => process.platform === "win32" ? name.toLowerCase() === expected.toLowerCase() : name === expected;
const inSet = (name: string, values: Set<string>) => [...values].some(value => matches(name, value));

/** Only metadata is inspected. Never descend into an omitted installation or
 * open its packages, export its environment, or run its interpreter. */
export async function excludeProjectSupport(path: string, info: Stats): Promise<boolean> {
  if (!info.isDirectory() && !info.isSymbolicLink()) return false;
  const name = basename(path), parent = basename(dirname(path));
  if (supportFolders.some(folder => matches(name, folder))) return false;
  if (inSet(name, dependencyCaches)) return true;
  if (info.isSymbolicLink() && (matches(name, ".venv") || matches(name, "venv"))) return true;
  if (matches(name, "_cacache") && matches(parent, ".npm")
    || matches(name, "cache") && [".yarn", ".next"].some(value => matches(parent, value))
    || matches(name, "uv") && matches(parent, ".cache")
    || ["http", "http-v2", "wheels", "selfcheck"].some(value => matches(name, value))
      && (matches(parent, "pip-cache") || matches(parent, "pip") && matches(basename(dirname(dirname(path))), ".cache"))) return true;
  const profile = (name: string) => matches(name, "chrome-profile") || matches(name, "browser-profile");
  if (inSet(name, browserCaches) && path.split(sep).some(part => supportFolders.some(folder => matches(part, folder)))
    && (profile(parent) || /^(Default|Profile \d+|Guest Profile|System Profile)$/i.test(parent) && profile(basename(dirname(dirname(path)))))) return true;
  if (info.isSymbolicLink()) return false;
  return lstat(join(path, "pyvenv.cfg")).then(marker => marker.isFile(), error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
}
