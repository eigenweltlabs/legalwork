import { constants, type BigIntStats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, statfs, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { checkedPath, protectedPath, safeRelative, validateMounts, within, type SandboxMount } from "./files.js";

const pathSchema = z.string().min(1).max(4096);
const numberSchema = z.number().int().nonnegative().safe();
const handleSchema = numberSchema.min(1);
const CHUNK = 128 * 1024;
const PRIVATE_PREFIX = "legalwork-sandbox-staging-";
const MAX_HANDLES = 256;
const MAX_CHANGED_FILES = 10000;
const reserveBytes = 1024 ** 3;
export const filesystemRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("stat"), path: pathSchema, handle: handleSchema.optional() }).strict(),
  z.object({ op: z.literal("list"), path: pathSchema, offset: numberSchema }).strict(),
  z.object({ op: z.literal("open"), path: pathSchema, write: z.boolean(), create: z.boolean(), exclusive: z.boolean(), truncate: z.boolean() }).strict(),
  z.object({ op: z.literal("read"), handle: handleSchema, offset: numberSchema, size: numberSchema.max(CHUNK) }).strict(),
  z.object({ op: z.literal("write"), handle: handleSchema, offset: numberSchema, data: z.instanceof(Buffer).refine((data) => data.length <= CHUNK) }).strict(),
  z.object({ op: z.literal("close"), handle: handleSchema }).strict(),
  z.object({ op: z.literal("truncate"), path: pathSchema, length: numberSchema, handle: handleSchema.optional() }).strict(),
  z.object({ op: z.literal("mkdir"), path: pathSchema, mode: numberSchema }).strict(),
  z.object({ op: z.enum(["unlink", "rmdir"]), path: pathSchema }).strict(),
  z.object({ op: z.literal("rename"), path: pathSchema, destination: pathSchema }).strict(),
  z.object({ op: z.literal("chmod"), path: pathSchema, mode: numberSchema }).strict(),
  z.object({ op: z.literal("space") }).strict(),
]);
export type FilesystemRequest = z.infer<typeof filesystemRequestSchema>;

const errno: Record<string, number> = { EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EACCES: 13, EBUSY: 16, EEXIST: 17, EXDEV: 18,
  ENOTDIR: 20, EISDIR: 21, EINVAL: 22, EMFILE: 24, EFBIG: 27, ENOSPC: 28, EROFS: 30, ENOTEMPTY: 39, ELOOP: 40, ESTALE: 116 };
function error(code: string, message = code): never { throw Object.assign(new Error(message), { code }); }
export function filesystemError(value: unknown): number {
  return value && typeof value === "object" && "code" in value && typeof value.code === "string" ? errno[value.code] ?? errno.EIO : errno.EIO;
}
function version(stat: BigIntStats | null): string | undefined {
  return stat ? `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : undefined;
}
const keyFor = (path: string) => process.platform === "linux" ? path : path.normalize("NFD").toLowerCase();
const privatePath = (path: string) => path.split(/[\\/]/).some((part) => part.toLowerCase().startsWith(PRIVATE_PREFIX));
type Location = { mount: SandboxMount; suffix: string; host: string; key: string; path: string };
type Entry = Location & { baseline: string | undefined; originalDirectory: boolean; directory: boolean; deleted: boolean;
  dirty: boolean; mode: number; size: number; contentHash?: string; stage?: string; descriptor?: FileHandle };

/** Capability-checked, lazy filesystem. File contents stay off the wire until
 * read. Writes go to private disk staging and never modify originals mid-run. */
export class SandboxFilesystem {
  private entries = new Map<string, Entry>();
  private allEntries = new Set<Entry>();
  private handles = new Map<number, { entry: Entry; write: boolean }>();
  private sequence = 0;
  private stagedBytes = 0;
  private stagedFiles = 0;
  private changedKeys = new Set<string>();
  private closed = false;
  private operationController = new AbortController();
  private listCache: { path: string; names: string[] } | undefined;
  private constructor(readonly mounts: SandboxMount[], readonly staging: string, readonly budget: number, private signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.operationController.signal]);
  }

  cancel(): void { this.operationController.abort(new Error("Sandbox filesystem stopped.")); }

  static async create(mounts: SandboxMount[], signal: AbortSignal): Promise<SandboxFilesystem> {
    const checked = await validateMounts(mounts);
    if (checked.some((mount) => privatePath(mount.source))) error("EACCES", "Private sandbox storage cannot be authorized.");
    const staging = await mkdtemp(join(tmpdir(), PRIVATE_PREFIX));
    try {
      const space = await statfs(staging);
      const available = space.bavail * space.bsize;
      // A budget for NEW temporary data, independent of authorized folder size.
      return new SandboxFilesystem(checked, staging, Math.max(0, Math.floor((available - reserveBytes) / 2)), signal);
    } catch (failure) { await rm(staging, { recursive: true, force: true }); throw failure; }
  }

  private locate(path: string): Location {
    this.signal.throwIfAborted();
    const mount = this.mounts.find((item) => path === item.target || path.startsWith(item.target + "/"));
    if (!mount) error("EACCES", "Path is outside the authorized folders.");
    const suffix = path.slice(mount.target.length + 1);
    if (suffix && !safeRelative(suffix)) error("EACCES", "Unsafe sandbox path.");
    if ((protectedPath(suffix) && suffix.toLowerCase() !== ".legalwork") || privatePath(suffix)) error("EACCES", "Protected host files are unavailable.");
    const host = join(mount.source, ...suffix.split("/"));
    if (privatePath(host)) error("EACCES");
    return { mount, suffix, host, key: keyFor(host), path };
  }

  private writable(location: Location): void {
    if (!location.suffix) error("EPERM", "Authorized folder roots cannot be replaced.");
    if (!location.mount.writable || this.mounts.some((mount) => !mount.writable && within(keyFor(mount.source), keyFor(location.host)))) error("EROFS");
    if (protectedPath(location.suffix) && location.suffix.toLowerCase() !== ".legalwork") error("EACCES");
  }

  private async original(location: Location): Promise<BigIntStats | null> {
    await checkedPath(location.mount, location.suffix || ".", false);
    const stat = await lstat(location.host, { bigint: true }).catch((failure: unknown) => {
      if (failure && typeof failure === "object" && "code" in failure && failure.code === "ENOENT") return null;
      throw failure;
    });
    if (stat && (!stat.isFile() && !stat.isDirectory() || stat.isSymbolicLink())) error("EACCES", "Links and special files are unavailable.");
    return stat;
  }

  private async entry(path: string, missing = false): Promise<Entry> {
    const location = this.locate(path);
    const cached = this.entries.get(location.key);
    if (cached) {
      // Case-sensitive APFS and Windows Unicode names can contain distinct
      // files whose portable keys collide. Never merge their data silently.
      if (cached.host !== location.host) error("EEXIST", "Ambiguous path spelling. Use consistent capitalization and Unicode spelling.");
      if (cached.deleted && !missing) error("ENOENT");
      return cached;
    }
    const stat = await this.original(location);
    if (!stat && !missing) error("ENOENT");
    if (this.allEntries.size >= 100000) error("EMFILE", "Too many files accessed in one command.");
    const entry: Entry = { ...location, baseline: version(stat), originalDirectory: stat?.isDirectory() ?? false,
      directory: stat?.isDirectory() ?? false, deleted: !stat, dirty: false,
      size: Number(stat?.size ?? 0), mode: Number(stat?.mode ?? 0o644) & 0o777 };
    if (!Number.isSafeInteger(entry.size)) error("EFBIG");
    this.entries.set(location.key, entry);
    this.allEntries.add(entry);
    return entry;
  }

  private async hashOriginal(entry: Entry, signal = this.signal): Promise<string> {
    await this.checkOriginal(entry);
    const file = await open(entry.host, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (version(await file.stat({ bigint: true })) !== entry.baseline) error("ESTALE");
      const hash = createHash("sha256"), buffer = Buffer.alloc(CHUNK);
      for (let offset = 0;;) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (version(await file.stat({ bigint: true })) !== entry.baseline) error("ESTALE");
      return hash.digest("hex");
    } finally { await file.close(); }
  }

  private async protectOriginal(entry: Entry): Promise<void> {
    // NTFS/Bun timestamps can stay unchanged across a fast same-size edit.
    // Only mutated files need content fingerprints; reads remain lazy.
    if (entry.baseline !== undefined && !entry.originalDirectory && entry.contentHash === undefined) entry.contentHash = await this.hashOriginal(entry);
  }

  private async checkOriginal(entry: Entry, content = false, signal = this.signal): Promise<void> {
    if (version(await this.original(entry)) !== entry.baseline) error("ESTALE", `File changed outside the sandbox: ${entry.path}`);
    if (content && entry.contentHash !== undefined && await this.hashOriginal(entry, signal) !== entry.contentHash) error("ESTALE", `File contents changed outside the sandbox: ${entry.path}`);
  }

  private async descriptor(entry: Entry): Promise<FileHandle> {
    if (entry.descriptor) return entry.descriptor;
    if (!entry.stage) await this.checkOriginal(entry);
    const file = await open(entry.stage ?? entry.host, (entry.stage ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || (!entry.stage && version(stat) !== entry.baseline)) { await file.close(); error("ESTALE"); }
    entry.descriptor = file;
    return file;
  }

  private change(entry: Entry): void {
    if (!this.changedKeys.has(entry.key) && this.changedKeys.size >= MAX_CHANGED_FILES) error("ENOSPC", "Too many changed files in one command.");
    this.changedKeys.add(entry.key);
    entry.dirty = true;
    this.listCache = undefined;
  }

  private async capacity(growth: number): Promise<void> {
    if (growth <= 0) return;
    if (this.stagedBytes + growth > this.budget) error("ENOSPC", "Temporary edits exceed the available disk budget.");
    const space = await statfs(this.staging);
    if (space.bavail * space.bsize < growth + reserveBytes) error("ENOSPC", "Not enough free disk space to safely stage edits.");
  }

  private async stage(entry: Entry, empty = false): Promise<void> {
    if (entry.directory) error("EISDIR");
    if (entry.stage) return;
    if (this.stagedFiles >= MAX_CHANGED_FILES) error("ENOSPC", "Too many temporary files in one command.");
    await this.checkOriginal(entry);
    await this.protectOriginal(entry);
    const size = empty || entry.deleted ? 0 : entry.size;
    await this.capacity(size);
    const stage = join(this.staging, randomUUID());
    const destination = await open(stage, "wx+");
    this.stagedFiles++;
    try {
      if (size) {
        const source = await this.descriptor(entry);
        const buffer = Buffer.alloc(CHUNK);
        for (let offset = 0; offset < size;) {
          this.signal.throwIfAborted();
          const { bytesRead } = await source.read(buffer, 0, Math.min(CHUNK, size - offset), offset);
          if (!bytesRead) error("ESTALE");
          for (let written = 0; written < bytesRead;) {
            const result = await destination.write(buffer, written, bytesRead - written, offset + written);
            if (!result.bytesWritten) error("EIO");
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        await this.checkOriginal(entry);
      }
      await entry.descriptor?.close();
      entry.descriptor = undefined;
      entry.descriptor = destination;
      entry.stage = stage;
      entry.size = size;
      entry.deleted = false;
      this.stagedBytes += size;
      this.change(entry);
    } catch (failure) { await destination.close(); await rm(stage, { force: true }); throw failure; }
  }

  private handle(id: number, write = false) {
    const handle = this.handles.get(id);
    if (!handle || write && !handle.write) error("EBADF");
    return handle.entry;
  }

  private attributes(entry: Entry) {
    // Node reports Windows directories as 0666. Linux FUSE needs traversal
    // bits; actual host access remains checked by the broker and Windows ACLs.
    const traverse = process.platform === "win32" && entry.directory ? 0o111 : 0;
    return { st_mode: (entry.directory ? 0o40000 : 0o100000) | entry.mode | traverse,
      st_nlink: entry.directory ? 2 : 1, st_uid: 1000, st_gid: 1000, st_size: entry.directory ? 4096 : entry.size,
      st_atime: 0, st_mtime: 0, st_ctime: 0 };
  }

  private async names(path: string): Promise<string[]> {
    const entry = await this.entry(path);
    if (!entry.directory) error("ENOTDIR");
    if (entry.originalDirectory) await this.original(entry);
    const names = new Set(entry.originalDirectory ? await readdir(entry.host) : []);
    for (const item of this.entries.values()) {
      if (keyFor(dirname(item.host)) !== entry.key) continue;
      if (item.deleted) names.delete(basename(item.host)); else names.add(basename(item.host));
    }
    return [...names].filter((name) => {
      try { this.locate(`${path}/${name}`); return true; } catch { return false; }
    }).sort();
  }

  async request(raw: unknown): Promise<unknown> {
    this.signal.throwIfAborted();
    if (this.closed) error("EIO", "Sandbox filesystem is closed.");
    const request = filesystemRequestSchema.parse(raw);
    if (request.op === "space") return { budget: this.budget, available: Math.max(0, this.budget - this.stagedBytes), chunk: CHUNK };
    if (request.op === "stat") {
      const entry = request.handle ? this.handle(request.handle) : await this.entry(request.path);
      return this.attributes(entry);
    }
    if (request.op === "list") {
      this.locate(request.path);
      if (!this.listCache || this.listCache.path !== request.path || request.offset === 0) this.listCache = { path: request.path, names: await this.names(request.path) };
      const names = this.listCache.names.slice(request.offset, request.offset + 512);
      return { names, more: request.offset + names.length < this.listCache.names.length };
    }
    if (request.op === "open") {
      const location = this.locate(request.path);
      if (request.write || request.create || request.truncate) this.writable(location);
      if ((request.create || request.truncate) && !request.write) error("EINVAL");
      if (this.handles.size >= MAX_HANDLES) error("EMFILE");
      let entry = await this.entry(request.path, request.create);
      if (entry.directory && !entry.deleted) error("EISDIR");
      if (request.exclusive && request.create && !entry.deleted) error("EEXIST");
      if (entry.deleted) {
        if (!request.create) error("ENOENT");
        if (entry.originalDirectory) error("EISDIR");
        if (!(await this.entry(request.path.slice(0, request.path.lastIndexOf("/")))).directory) error("ENOTDIR");
        if (entry.dirty) {
          if (this.allEntries.size >= 100000) error("EMFILE");
          entry = { ...entry, descriptor: undefined, stage: undefined, size: 0, directory: false };
          this.entries.set(entry.key, entry); this.allEntries.add(entry);
        }
        await this.stage(entry, true);
      } else if (request.write) {
        await this.stage(entry, request.truncate);
        if (request.truncate) { await (await this.descriptor(entry)).truncate(0); this.stagedBytes -= entry.size; entry.size = 0; }
      } else await this.descriptor(entry);
      const handle = ++this.sequence;
      this.handles.set(handle, { entry, write: request.write });
      return handle;
    }
    if (request.op === "close") {
      const entry = this.handle(request.handle);
      this.handles.delete(request.handle);
      if (![...this.handles.values()].some((handle) => handle.entry === entry)) { await entry.descriptor?.close(); entry.descriptor = undefined; }
      return 0;
    }
    if (request.op === "read") {
      const entry = this.handle(request.handle);
      const descriptor = await this.descriptor(entry);
      if (!entry.stage && version(await descriptor.stat({ bigint: true })) !== entry.baseline) error("ESTALE");
      const buffer = Buffer.alloc(request.size);
      const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, request.offset);
      if (!entry.stage && version(await descriptor.stat({ bigint: true })) !== entry.baseline) error("ESTALE");
      return buffer.subarray(0, bytesRead);
    }
    if (request.op === "write") {
      const entry = this.handle(request.handle, true);
      const bytes = request.data;
      const size = Math.max(entry.size, request.offset + bytes.length);
      if (!Number.isSafeInteger(size)) error("EFBIG");
      await this.capacity(size - entry.size);
      const descriptor = await this.descriptor(entry);
      for (let offset = 0; offset < bytes.length;) {
        const result = await descriptor.write(bytes, offset, bytes.length - offset, request.offset + offset);
        if (!result.bytesWritten) error("EIO");
        offset += result.bytesWritten;
      }
      this.stagedBytes += size - entry.size; entry.size = size; this.change(entry);
      return bytes.length;
    }
    if (request.op === "truncate") {
      this.writable(this.locate(request.path));
      const entry = request.handle ? this.handle(request.handle, true) : await this.entry(request.path);
      await this.stage(entry, request.length === 0);
      await this.capacity(request.length - entry.size);
      await (await this.descriptor(entry)).truncate(request.length);
      this.stagedBytes += request.length - entry.size; entry.size = request.length; this.change(entry);
      return 0;
    }
    const location = this.locate(request.path);
    this.writable(location);
    const entry = await this.entry(request.path, request.op === "mkdir");
    if (request.op === "mkdir") {
      if (!entry.deleted) error("EEXIST");
      if (entry.baseline !== undefined && !entry.originalDirectory) error("ENOTDIR");
      if (!(await this.entry(request.path.slice(0, request.path.lastIndexOf("/")))).directory) error("ENOTDIR");
      entry.directory = true; entry.deleted = false; entry.mode = request.mode & 0o777; this.change(entry);
    } else if (request.op === "unlink" || request.op === "rmdir") {
      if (entry.directory !== (request.op === "rmdir")) error(entry.directory ? "EISDIR" : "ENOTDIR");
      if (entry.directory && (await this.names(request.path)).length) error("ENOTEMPTY");
      await this.protectOriginal(entry);
      entry.deleted = true; this.change(entry);
    } else if (request.op === "chmod") {
      // Owner/group changes, setuid, device creation and links are never exposed.
      if (!entry.directory) await this.stage(entry);
      entry.mode = request.mode & 0o777; this.change(entry);
    } else if (request.op === "rename") {
      const destination = this.locate(request.destination);
      this.writable(destination);
      const target = await this.entry(request.destination, true);
      if (entry.key === destination.key) return 0;
      // mv/shutil can use their copy-and-delete path for directories.
      if (entry.directory) error("EXDEV");
      if (target.directory && !target.deleted) error("EISDIR");
      if (!(await this.entry(request.destination.slice(0, request.destination.lastIndexOf("/")))).directory) error("ENOTDIR");
      await this.stage(entry);
      await this.protectOriginal(target);
      if (this.allEntries.size >= 100000) error("EMFILE");
      const removed: Entry = { ...entry, descriptor: undefined, deleted: true };
      this.allEntries.add(removed);
      this.entries.set(entry.key, removed);
      Object.assign(entry, destination, { baseline: target.baseline, contentHash: target.contentHash, originalDirectory: false });
      this.entries.set(destination.key, entry);
      this.change(removed); this.change(entry);
    }
    return 0;
  }

  private async closeHandles(): Promise<void> {
    this.closed = true;
    for (const entry of this.allEntries) { await entry.descriptor?.close(); entry.descriptor = undefined; }
    this.handles.clear();
  }

  async commit(signal = this.signal): Promise<void> {
    await this.closeHandles();
    const changed = [...this.entries.values()].filter((entry) => entry.dirty);
    // Validate every destination before applying any change.
    for (const entry of changed) { signal.throwIfAborted(); this.writable(entry); await this.checkOriginal(entry, true, signal); }
    changed.sort((a, b) => {
      const rank = (entry: Entry) => entry.directory ? entry.deleted ? 2 : 0 : 1;
      return rank(a) - rank(b) || (a.directory && a.deleted ? b.suffix.length - a.suffix.length : a.suffix.length - b.suffix.length);
    });
    for (const entry of changed) {
      signal.throwIfAborted();
      await checkedPath(entry.mount, entry.suffix, true);
      // Own child edits can change a directory's mtime; file baselines must
      // still match immediately before replacement.
      if (!entry.directory) await this.checkOriginal(entry, entry.deleted, signal);
      if (entry.deleted) {
        if (entry.baseline !== undefined) { if (entry.directory) await rmdir(entry.host); else await rm(entry.host); }
      } else if (entry.directory) {
        await mkdir(entry.host, { recursive: true, mode: entry.mode });
        await chmod(entry.host, entry.mode);
      }
      else if (entry.stage) {
        await chmod(entry.stage, entry.mode);
        signal.throwIfAborted();
        await this.checkOriginal(entry, true, signal);
        try {
          // Same-volume publication needs no second copy of a large output.
          await rename(entry.stage, entry.host);
          continue;
        } catch (failure) {
          if (!failure || typeof failure !== "object" || !("code" in failure) || failure.code !== "EXDEV") throw failure;
        }
        const temporary = `${entry.host}.legalwork-${randomUUID()}.tmp`;
        try {
          await copyFile(entry.stage, temporary, constants.COPYFILE_EXCL);
          const file = await open(temporary, "r+");
          try { await file.chmod(entry.mode); } finally { await file.close(); }
          signal.throwIfAborted();
          await this.checkOriginal(entry, true, signal);
          await rename(temporary, entry.host);
        } finally { await rm(temporary, { force: true }); }
      }
    }
  }

  async dispose(): Promise<void> {
    this.cancel();
    await this.closeHandles();
    await rm(this.staging, { recursive: true, force: true });
  }
}
