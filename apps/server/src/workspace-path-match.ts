import { realpath } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";

/**
 * One rule for "is this chat directory inside that LegalWork project?".
 *
 * A project and its chats can name the same folder differently:
 * - Windows mapped drives: the project is saved as `P:\Matters\X`, while the
 *   engine stores the chat in the canonical UNC form `\\server\share\Matters\X`
 *   (native realpath resolves mapped drives to their UNC target).
 * - `\\?\` / `\\?\UNC\` extended-length prefixes, separators, letter case.
 * - Symlinked or junctioned folders on any platform.
 *
 * Purely lexical checks (`relative(resolve(a), resolve(b))`) treat these as
 * different projects, so every project-scoped tool fails with
 * "No LegalWork workspace matches the working directory …".
 */

type MatchOptions = { platform?: "win32" | "posix" };

const CANONICAL_CACHE_MS = 10_000;
const canonicalCache = new Map<string, { at: number; value: string }>();

const hostPlatform = (): "win32" | "posix" => process.platform === "win32" ? "win32" : "posix";

function stripVerbatimPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(path)) return path.slice(4);
  if (/^\/\/\?\/UNC\//i.test(path)) return `//${path.slice(8)}`;
  if (/^\/\/\?\/[a-zA-Z]:\//.test(path)) return path.slice(4);
  return path;
}

/** Lexical key used for comparison only. Never use it as a filesystem path. */
export function projectPathKey(path: string, options: MatchOptions = {}): string {
  const platform = options.platform ?? hostPlatform();
  const resolver = platform === "win32" ? win32.resolve : posix.resolve;
  const resolved = resolver(stripVerbatimPrefix(path.trim()));
  const unified = platform === "win32" ? resolved.replace(/\\/g, "/") : resolved;
  const trimmed = unified.length > 1 && !/^[a-zA-Z]:\/$/.test(unified) ? unified.replace(/\/+$/, "") : unified;
  // NTFS and SMB shares are case-insensitive; POSIX volumes keep exact names.
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** True when `child` is `root` or below it, after lexical normalisation. */
export function pathKeyWithin(root: string, child: string): boolean {
  if (root === child) return true;
  const base = root.endsWith("/") ? root : `${root}/`;
  return child.startsWith(base);
}

/** Canonical filesystem location; falls back to the lexical path if it cannot be resolved. */
export async function canonicalProjectPath(path: string): Promise<string> {
  const absolute = resolve(stripVerbatimPrefix(path.trim()));
  const cached = canonicalCache.get(absolute);
  if (cached && Date.now() - cached.at < CANONICAL_CACHE_MS) return cached.value;
  const value = await realpath(absolute).then(stripVerbatimPrefix).catch(() => absolute);
  canonicalCache.set(absolute, { at: Date.now(), value });
  return value;
}

/** Same folder or a subfolder, accepting mapped-drive/UNC, prefix, case and symlink aliases. */
export async function directoryWithinProject(root: string, directory: string, options: MatchOptions = {}): Promise<boolean> {
  if (!root.trim() || !directory.trim()) return false;
  if (pathKeyWithin(projectPathKey(root, options), projectPathKey(directory, options))) return true;
  const [canonicalRoot, canonicalDirectory] = await Promise.all([canonicalProjectPath(root), canonicalProjectPath(directory)]);
  return pathKeyWithin(projectPathKey(canonicalRoot, options), projectPathKey(canonicalDirectory, options));
}

/** Exactly the same folder (used for chat ownership checks). */
export async function sameProjectDirectory(a: string, b: string, options: MatchOptions = {}): Promise<boolean> {
  if (!a.trim() || !b.trim()) return false;
  if (projectPathKey(a, options) === projectPathKey(b, options)) return true;
  const [left, right] = await Promise.all([canonicalProjectPath(a), canonicalProjectPath(b)]);
  return projectPathKey(left, options) === projectPathKey(right, options);
}

/** Closest (longest) registered project that contains `directory`, or undefined. */
export async function findProjectForDirectory<T extends { path: string }>(items: T[], directory: string, options: MatchOptions = {}): Promise<T | undefined> {
  const candidates = items.filter(item => item.path);
  const key = projectPathKey(directory, options);
  const exact = candidates.find(item => projectPathKey(item.path, options) === key);
  if (exact) return exact;
  // A lexical parent can hide a nested root registered through another alias.
  // Compare canonical roots before falling back to normalized lexical paths.
  const canonicalDirectory = projectPathKey(await canonicalProjectPath(directory), options);
  const canonical = await Promise.all(candidates.map(async item => ({ item, key: projectPathKey(await canonicalProjectPath(item.path), options) })));
  const match = canonical.sort((a, b) => b.key.length - a.key.length).find(entry => pathKeyWithin(entry.key, canonicalDirectory));
  if (match) return match.item;
  return candidates.map(item => ({ item, key: projectPathKey(item.path, options) }))
    .sort((a, b) => b.key.length - a.key.length).find(entry => pathKeyWithin(entry.key, key))?.item;
}

/** Test seam: forget cached canonical paths. */
export function clearProjectPathCache(): void {
  canonicalCache.clear();
}
