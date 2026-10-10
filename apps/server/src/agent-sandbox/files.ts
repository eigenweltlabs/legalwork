import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type SandboxMount = { source: string; target: string; writable: boolean };
const protectedNames = new Set([".git", ".opencode", ".env", ".npmrc", ".bashrc", ".zshrc", ".profile"]);

export function protectedPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  return parts.some((part, index) => protectedNames.has(part) || part.startsWith(".env.") ||
    (part === ".legalwork" && parts[index + 1] !== "scratch"));
}

export function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function safeRelative(path: string): boolean {
  return path.length > 0 && path.length < 4096 && path.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".." && !/[\\:<>"|?*\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export async function validateMounts(mounts: SandboxMount[], protectedPaths: string[] = []): Promise<SandboxMount[]> {
  const targets = new Set<string>();
  const result: SandboxMount[] = [];
  for (const mount of mounts) {
    if (!/^\/(workspace|(?:authorized|skills)\/[0-9]+)$/.test(mount.target) || targets.has(mount.target)) throw new Error("Invalid sandbox folder.");
    if (mount.target.startsWith("/skills/") && mount.writable) throw new Error("Installed skills are read-only.");
    targets.add(mount.target);
    if (!isAbsolute(mount.source)) throw new Error("Sandbox folders must be absolute paths.");
    const source = await realpath(mount.source);
    if (!(await lstat(source)).isDirectory()) throw new Error("Sandbox folder is not a directory.");
    for (const protectedPath of protectedPaths) {
      const root = await realpath(protectedPath).catch(() => protectedPath);
      if (within(source, root) || within(root, source)) throw new Error("This folder overlaps LegalWork's private runtime. Choose a narrower document folder.");
    }
    result.push({ ...mount, source });
  }
  if (!targets.has("/workspace")) throw new Error("Sandbox workspace is missing.");
  return result;
}

export async function checkedPath(mount: SandboxMount, suffix: string, create: boolean): Promise<string> {
  if (await realpath(mount.source) !== mount.source) throw new Error("The authorized folder changed during execution.");
  const parts = suffix.split("/");
  let current = mount.source;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (create) await mkdir(current).catch((error: unknown) => { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; });
    const stat = await lstat(current).catch(() => null);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("A sandbox destination is not a regular directory.");
  }
  return join(mount.source, ...parts);
}
