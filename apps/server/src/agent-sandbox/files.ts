import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const MAX_FILES = 10000;
export const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
export type SandboxMount = { source: string; target: string; writable: boolean };
export type SnapshotFile = { path: string; sha256: string; mode: number; size: number };
export type Snapshot = { mounts: SandboxMount[]; directories: string[]; files: Map<string, SnapshotFile>; bytes: number };
export type FileChange = { path: string; directory: true; deleted?: boolean; content?: never; mode?: never }
  | { path: string; directory?: false; deleted: true; content?: never; mode?: never }
  | { path: string; directory?: false; deleted?: false; content: Buffer; mode?: number };
const protectedNames = new Set([".git", ".opencode", ".env", ".npmrc", ".bashrc", ".zshrc", ".profile"]);
export const hashFile = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function protectedPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  return parts.some((part, index) => protectedNames.has(part) || part.startsWith(".env.") ||
    (part === ".legalwork" && parts[index + 1] !== "scratch"));
}

export async function readSnapshotFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Unsupported or oversized sandbox input file.");
    return await file.readFile();
  } finally { await file.close(); }
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

export function locate(snapshot: Snapshot, path: string) {
  const mount = snapshot.mounts.find((entry) => path.startsWith(entry.target + "/"));
  if (!mount) throw new Error("Sandbox file is outside the authorized folders.");
  const suffix = path.slice(mount.target.length + 1);
  if (!safeRelative(suffix)) throw new Error("Unsafe sandbox file path.");
  return { mount, suffix, host: join(mount.source, ...suffix.split("/")) };
}

/** No host filesystem is shared with the guest, even if its kernel is compromised. */
export async function snapshotFolders(mounts: SandboxMount[], signal: AbortSignal): Promise<Snapshot> {
  const snapshot: Snapshot = { mounts: await validateMounts(mounts), directories: [], files: new Map(), bytes: 0 };
  const visit = async (source: string, target: string) => {
    signal.throwIfAborted();
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!safeRelative(entry.name)) throw new Error(`Unsupported sandbox filename: ${entry.name}`);
      // App state and host execution configuration never enter the VM.
      const host = join(source, entry.name), path = `${target}/${entry.name}`;
      // Allow only the task scratch area inside the app's project metadata.
      if (protectedPath(path) && entry.name.toLowerCase() !== ".legalwork") continue;
      const stat = await lstat(host);
      if (stat.isSymbolicLink()) throw new Error(`Sandbox snapshots do not follow symbolic links: ${path}`);
      if (stat.isDirectory()) {
        if (snapshot.directories.length >= MAX_FILES) throw new Error("Too many sandbox directories.");
        snapshot.directories.push(path);
        await visit(host, path); continue;
      }
      if (protectedPath(path)) continue;
      if (!stat.isFile()) throw new Error(`Unsupported sandbox file type: ${path}`);
      snapshot.bytes += stat.size;
      if (stat.size > MAX_FILE_BYTES || snapshot.bytes > MAX_SNAPSHOT_BYTES || snapshot.files.size >= MAX_FILES) {
        throw new Error("This folder exceeds the protected environment's limit (512 MB, 10,000 files, 128 MB per file). Choose a narrower document folder.");
      }
      const bytes = await readSnapshotFile(host);
      if (bytes.length !== stat.size) throw new Error(`File changed while preparing the sandbox: ${path}`);
      snapshot.files.set(path, { path, size: bytes.length, sha256: hashFile(bytes), mode: stat.mode & 0o777 });
    }
  };
  for (const mount of snapshot.mounts) await visit(mount.source, mount.target);
  return snapshot;
}

async function checkedPath(mount: SandboxMount, suffix: string, create: boolean): Promise<string> {
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

export async function applyChanges(snapshot: Snapshot, changes: FileChange[], signal: AbortSignal): Promise<void> {
  const seen = new Set<string>();
  let bytes = 0;
  const checked = [];
  for (const change of changes) {
    signal.throwIfAborted();
    const { mount, suffix } = locate(snapshot, change.path);
    if (!mount.writable) throw new Error("The sandbox attempted to change a read-only folder.");
    if (protectedPath(suffix) && !(change.directory && !change.deleted && suffix.toLowerCase() === ".legalwork")) throw new Error("The sandbox cannot change host execution settings.");
    const hostKey = join(mount.source, suffix);
    const key = process.platform === "linux" ? hostKey : hostKey.normalize("NFD").toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate sandbox output path.");
    seen.add(key);
    bytes += change.content?.length ?? 0;
    if (seen.size > MAX_FILES || bytes > MAX_SNAPSHOT_BYTES || (change.content?.length ?? 0) > MAX_FILE_BYTES) throw new Error("Sandbox output exceeded its file limit.");
    if (!change.directory && !change.deleted && !change.content) throw new Error("Sandbox output is missing file data.");
    const host = await checkedPath(mount, suffix, false);
    const stat = await lstat(host).catch(() => null);
    if (change.directory) {
      if (stat && (!stat.isDirectory() || !snapshot.directories.includes(change.path))) throw new Error("A sandbox directory conflicts with a host change.");
      if (!stat && snapshot.directories.includes(change.path)) throw new Error("A sandbox directory changed outside the sandbox.");
      checked.push({ change, mount, suffix, host });
      continue;
    }
    if (stat && !stat.isFile()) throw new Error("A sandbox output would replace a non-file.");
    const current = stat ? hashFile(await readSnapshotFile(host)) : undefined;
    if (current !== snapshot.files.get(change.path)?.sha256) throw new Error(`File changed outside the sandbox; output was not applied: ${change.path}`);
    checked.push({ change, mount, suffix, host });
  }
  // Validate the complete response before applying anything. Atomic file
  // replacement preserves hard-link targets elsewhere on the host.
  checked.sort((a, b) => {
    const rank = (change: FileChange) => change.directory ? change.deleted ? 2 : 0 : 1;
    return rank(a.change) - rank(b.change) || (a.change.directory && a.change.deleted ? b.suffix.length - a.suffix.length : a.suffix.length - b.suffix.length);
  });
  for (const { change, mount, suffix, host } of checked) {
    signal.throwIfAborted();
    await checkedPath(mount, suffix, true);
    const current = await lstat(host).catch(() => null);
    if (change.directory) {
      if (current && !current.isDirectory()) throw new Error("A sandbox destination changed during copy-back.");
      if (change.deleted) { if (current) await rmdir(host); }
      else await mkdir(host, { recursive: true });
      continue;
    }
    if (current && !current.isFile()) throw new Error("A sandbox destination changed during copy-back.");
    if ((current ? hashFile(await readSnapshotFile(host)) : undefined) !== snapshot.files.get(change.path)?.sha256) {
      throw new Error(`File changed outside the sandbox: ${change.path}`);
    }
    if (change.deleted) { await rm(host, { force: true }); continue; }
    const temporary = `${host}.legalwork-${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", (change.mode ?? 0o644) & 0o777);
      try { await file.writeFile(change.content); } finally { await file.close(); }
      await rename(temporary, host);
    } finally { await rm(temporary, { force: true }); }
  }
}
