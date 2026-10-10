import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";

import { ApiError } from "./errors.js";
import type { StorageAdapter } from "./file-storage/common.js";
import { MERGEABLE_TEXT_MAX_BYTES, mergeableText, mergeText } from "./text-merge.js";
import { syncBatches } from "./sync-batches.js";

/**
 * One project folder kept in step with a remote copy of its documents.
 *
 * Every file is compared three ways: as it is here, as it is remotely, and
 * as both sides last agreed (the "base", kept by the caller). Whichever side
 * moved away from the base is the change, and it goes to the other side:
 *
 *   changed here only            → uploaded, naming the version it replaces
 *   changed remotely only        → downloaded over the unchanged local file
 *   deleted here only            → deleted remotely (that version only)
 *   deleted remotely only        → moved to .legalwork/sync-trash here
 *   deleted on one side, edited
 *   on the other                 → the edit wins and comes back
 *   edited differently on both   → text a person writes (notes) is merged,
 *                                  as Git merges; otherwise, or where both
 *                                  changed the same words, the remote version
 *                                  keeps the name and this computer's version
 *                                  is kept beside it as a copy, which then
 *                                  syncs like any new file
 *
 * Nothing is overwritten or removed without the other side's version being
 * the one last seen: uploads and remote deletes are conditional, and a local
 * file is only replaced if it has not changed since it was read. Whatever is
 * refused as stale is settled on the next reconcile. Many deletions made here
 * at once (an emptied or swapped folder) are held back until the user
 * confirms them.
 *
 * Talks to the remote only through a StorageAdapter that lists versions, so
 * it is the same for the Eigenwelt platform and any other connected storage.
 */

export type FileBase = { path: string; sha256: string; size: number; mtimeMs: number };

/** What both sides last agreed on, per file key (see `fileKey`). */
export type FileBaseStore = {
  entries(): Map<string, FileBase>;
  put(key: string, entry: FileBase): void;
  drop(key: string): void;
  /** For text that is merged (`mergeableText`): its agreed content, the base of a merge; null when not kept. */
  text?(key: string): string | null;
  putText?(key: string, text: string | null): void;
};

export type FileSyncOptions = {
  root: string;
  remote: StorageAdapter;
  base: FileBaseStore;
  /** Whether a project-relative path is part of what this project syncs. */
  includes: (path: string) => boolean;
  /**
   * List the remote and settle both sides. Without it only local changes are
   * pushed, each conditional on the base: cheap, and enough while nothing
   * changed remotely.
   */
  reconcile: boolean;
  /** Deletions over the safety threshold were confirmed by the user. */
  allowDeletions: boolean;
  /** Names this computer's copy in a conflict, e.g. the member's name. */
  label: string;
  maxFileBytes: number;
  /** A file changed more recently than this is still being written; it waits. */
  settleMs?: number;
  now?: () => Date;
};

export type FileSyncConflict = { path: string; copyPath: string };
export type FileSyncSkip = { path: string; reason: "too_large" | "name_clash" | "failed"; detail?: string };

export type FileSyncResult = {
  /** Changed on both sides and merged: in place here, and at the firm. */
  merged: number;
  uploaded: number;
  downloaded: number;
  removedRemote: number;
  removedLocal: number;
  conflicts: FileSyncConflict[];
  skipped: FileSyncSkip[];
  /** Local deletions held back by the safety threshold. */
  heldDeletions: number;
  /** A conditional write found a newer remote version: reconcile next time. */
  stale: boolean;
  /** Local changes still not uploaded (held, skipped, still being written, stale). */
  pending: number;
};

/**
 * Never synced: hidden files and folders (the app's own `.legalwork` and
 * `.opencode`, `.git`, `.DS_Store`), Office lock files and temporary
 * downloads, and Windows folder clutter.
 */
export function syncExcluded(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("~$") ||
    /\.(tmp|crdownload|part|partial)$/i.test(name) ||
    /^(thumbs\.db|desktop\.ini)$/i.test(name)
  );
}

/**
 * A remote path that stays inside the project folder on every system: `/`
 * separated, no empty, hidden, `.` or `..` segment, no backslash, drive colon
 * or control character. Anything else from the remote is ignored.
 */
export function safeRemotePath(path: string): boolean {
  if (!path || /[\\:\x00-\x1f\x7f]/.test(path) || path.startsWith("/")) return false;
  return path.split("/").every((part) => part.length > 0 && !syncExcluded(part));
}

/** Files are told apart without case, as the platform and two of the three desktop systems do. */
export function fileKey(path: string): string {
  return path.toLowerCase();
}

type LocalFile = { path: string; abs: string; size: number; mtimeMs: number };

const MAX_LOCAL_FILES = 50_000;

async function scanLocal(root: string, includes: (path: string) => boolean) {
  const files = new Map<string, LocalFile>();
  const clashes: string[] = [];
  const unsyncable: string[] = [];
  const folders = [root];
  while (folders.length > 0) {
    const folder = folders.pop() ?? root;
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (syncExcluded(item.name)) continue;
      const abs = join(folder, item.name);
      // Links are never followed: a link out of the folder must not sync what it points at.
      if (item.isDirectory()) folders.push(abs);
      if (!item.isFile()) continue;
      const path = relative(root, abs).split(sep).join("/").normalize("NFC");
      if (!includes(path)) continue;
      // A name another system cannot hold (a colon, say) stays here, and says so.
      if (!safeRemotePath(path)) {
        unsyncable.push(path);
        continue;
      }
      const key = fileKey(path);
      if (files.has(key)) {
        clashes.push(path);
        continue;
      }
      const info = await stat(abs);
      files.set(key, { path, abs, size: info.size, mtimeMs: info.mtimeMs });
      if (files.size > MAX_LOCAL_FILES) {
        throw new ApiError(413, "project_too_many_files", `A synced project holds at most ${MAX_LOCAL_FILES} files.`);
      }
    }
  }
  return { files, clashes, unsyncable };
}

export async function hashFile(abs: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(abs)) hash.update(chunk);
  return hash.digest("hex");
}

type Action = "none" | "upload" | "download" | "delete-remote" | "delete-local" | "conflict" | "adopt" | "forget";

/**
 * What to do with one file, from its version here (L), remotely (R) and as
 * last agreed (B); null is "not there". Exported for the tests: this table is
 * the whole of the sync's policy.
 */
export function decide(local: string | null, remote: string | null, base: string | null): Action {
  if (local === remote) {
    if (local === null) return base === null ? "none" : "forget";
    return base === local ? "none" : "adopt";
  }
  if (base === null) {
    if (local === null) return "download";
    if (remote === null) return "upload";
    return "conflict";
  }
  if (remote === base) return local === null ? "delete-remote" : "upload";
  if (local === base) return remote === null ? "delete-local" : "download";
  // Both moved: an edit beats a deletion, two different edits keep both.
  if (local === null) return "download";
  if (remote === null) return "upload";
  return "conflict";
}

/** `Klage.pdf` → `Klage (Anna Muster, 2026-09-25 14.03).pdf`, numbered if that exists too. */
export function conflictCopyPath(path: string, label: string, at: Date, taken: (path: string) => boolean): string {
  const extension = extname(path);
  const stem = path.slice(0, path.length - extension.length);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  const cleanLabel = label.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "LegalWork";
  for (let index = 1; ; index++) {
    const candidate = `${stem} (${cleanLabel}, ${stamp}${index > 1 ? ` ${index}` : ""})${extension}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Move a file of the project into the sync trash, as sync does with what it removes here. */
export async function moveToSyncTrash(root: string, path: string, at: Date = new Date()): Promise<void> {
  const target = join(root, ".legalwork", "sync-trash", at.toISOString().replace(/[:.]/g, "-"), ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await rename(join(root, ...path.split("/")), target);
}

/** How long files removed by sync stay recoverable in `.legalwork/sync-trash`. */
const TRASH_KEEP_MS = 30 * 86_400_000;

async function pruneTrash(root: string, at: Date): Promise<void> {
  const trash = join(root, ".legalwork", "sync-trash");
  const entries = await readdir(trash).catch(() => []);
  for (const name of entries) {
    // Folder names are the round's ISO time with ":" and "." made "-".
    const stamp = Date.parse(name.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z"));
    if (Number.isFinite(stamp) && at.getTime() - stamp > TRASH_KEEP_MS) {
      await rm(join(trash, name), { recursive: true, force: true });
    }
  }
}

/** Only failures of this one file are skipped; anything else stops the round. */
function fileLevel(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 404 || error.status === 409 || error.status === 413 || error.status === 400;
}

function isStale(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 404);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncProjectFiles(options: FileSyncOptions): Promise<FileSyncResult> {
  const { root, remote, base, includes, label, maxFileBytes } = options;
  const now = options.now ?? (() => new Date());
  const settleMs = options.settleMs ?? 2_000;
  const result: FileSyncResult = {
    merged: 0,
    uploaded: 0,
    downloaded: 0,
    removedRemote: 0,
    removedLocal: 0,
    conflicts: [],
    skipped: [],
    heldDeletions: 0,
    stale: false,
    pending: 0,
  };

  const workDir = join(root, ".legalwork", "sync-tmp");
  await rm(workDir, { recursive: true, force: true });
  await pruneTrash(root, now());
  // One folder per round, so nothing moved to the trash replaces an earlier copy.
  const trashDir = join(root, ".legalwork", "sync-trash", now().toISOString().replace(/[:.]/g, "-"));

  const { files: local, clashes, unsyncable } = await scanLocal(root, includes);
  for (const path of clashes) result.skipped.push({ path, reason: "name_clash" });
  for (const path of unsyncable) result.skipped.push({ path, reason: "failed", detail: "unsupported file name" });

  const bases = base.entries();
  for (const [key, entry] of bases) {
    // Out of scope now (the owner stopped syncing that kind of file): the
    // file stays wherever it is and is simply no longer compared.
    if (!includes(entry.path)) {
      base.drop(key);
      bases.delete(key);
    }
  }

  const remoteFiles = new Map<string, { path: string; version: string }>();
  if (options.reconcile) {
    if (!remote.listFiles) throw new ApiError(400, "storage_listing_unsupported", "This storage cannot list a folder's files at once.");
    let cursor: string | undefined;
    do {
      const page = await remote.listFiles("", cursor);
      for (const item of page.entries) {
        if (item.kind !== "file" || item.version === undefined || !safeRemotePath(item.path) || !includes(item.path)) continue;
        remoteFiles.set(fileKey(item.path), { path: item.path, version: item.version });
      }
      cursor = page.nextCursor;
    } while (cursor);
  } else {
    // Unlisted: the remote is taken to be as last agreed. Any write the
    // remote refuses as stale sends the next round into a reconcile.
    for (const [key, entry] of bases) remoteFiles.set(key, { path: entry.path, version: entry.sha256 });
  }

  // This side's version of each file; unchanged size and time since the last
  // agreement means unchanged content, so only changed files are read.
  const localVersion = new Map<string, string>();
  const busy = new Set<string>();
  const settledBefore = now().getTime() - settleMs;
  for (const [key, file] of local) {
    const known = bases.get(key);
    if (known && known.size === file.size && known.mtimeMs === file.mtimeMs) {
      localVersion.set(key, known.sha256);
      continue;
    }
    if (file.mtimeMs > settledBefore) {
      busy.add(key);
      continue;
    }
    try {
      localVersion.set(key, await hashFile(file.abs));
    } catch (error) {
      busy.add(key);
      result.skipped.push({ path: file.path, reason: "failed", detail: messageOf(error) });
    }
  }

  const keys = new Set([...local.keys(), ...remoteFiles.keys(), ...bases.keys()]);
  const plan: { key: string; action: Action; localSha: string | null }[] = [];
  for (const key of keys) {
    // Still being written (or unreadable): not a deletion, not a change — later.
    if (busy.has(key)) {
      result.pending += 1;
      continue;
    }
    const localSha = localVersion.get(key) ?? null;
    const action = decide(localSha, remoteFiles.get(key)?.version ?? null, bases.get(key)?.sha256 ?? null);
    if (action !== "none") plan.push({ key, action, localSha });
  }

  const deletions = plan.filter((step) => step.action === "delete-remote").length;
  const holdDeletions = !options.allowDeletions && deletions > Math.max(10, Math.floor(bases.size / 2));
  if (holdDeletions) result.heldDeletions = deletions;

  const takenPaths = new Set([...local.keys(), ...remoteFiles.keys()]);
  const extraUploads: string[] = [];

  /** Keep what both sides now agree a text says, if it is one that is merged. */
  const rememberText = async (key: string, path: string, abs: string, sha256: string): Promise<void> => {
    if (!base.putText || !mergeableText(path)) return;
    const info = await stat(abs).catch(() => null);
    const bytes = info && info.size <= MERGEABLE_TEXT_MAX_BYTES ? await readFile(abs).catch(() => null) : null;
    const agreed = bytes && bytes.byteLength <= MERGEABLE_TEXT_MAX_BYTES && createHash("sha256").update(bytes).digest("hex") === sha256;
    base.putText(key, agreed ? bytes.toString("utf8") : null);
  };

  /**
   * Both sides changed a text: merge the two against what they last agreed
   * on, in place here and at the firm. False when it cannot be merged (no
   * agreed text kept, or both changed the same words): the copy it is.
   */
  const mergeBoth = async (key: string, file: LocalFile, remoteFile: { path: string; version: string }): Promise<boolean> => {
    const agreed = mergeableText(file.path) && file.size <= MERGEABLE_TEXT_MAX_BYTES ? (base.text?.(key) ?? null) : null;
    if (agreed === null) return false;
    await mkdir(workDir, { recursive: true });
    const temporary = join(workDir, randomUUID());
    try {
      const received = await remote.download(remoteFile.path, temporary);
      if (received.sha256 !== remoteFile.version) {
        result.stale = true;
        return true;
      }
      const merged = mergeText(agreed, await readFile(file.abs, "utf8"), await readFile(temporary, "utf8"));
      if (merged === null) return false;
      // Only over the file this round read: one saved meanwhile waits for the next round.
      const current = await stat(file.abs);
      if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) {
        result.stale = true;
        return true;
      }
      await writeFile(temporary, merged, "utf8");
      await rename(temporary, file.abs);
      const placed = await stat(file.abs);
      const sha256 = createHash("sha256").update(merged).digest("hex");
      await remote.upload(file.path, file.abs, "application/octet-stream", { version: remoteFile.version });
      base.put(key, { path: file.path, sha256, size: placed.size, mtimeMs: placed.mtimeMs });
      base.putText?.(key, merged);
      result.merged += 1;
      result.downloaded += 1;
      result.uploaded += 1;
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
  };

  const placeDownload = async (key: string, targetPath: string, expected: LocalFile | null): Promise<void> => {
    const remoteFile = remoteFiles.get(key);
    if (!remoteFile) return;
    await mkdir(workDir, { recursive: true });
    const temporary = join(workDir, randomUUID());
    try {
      const received = await remote.download(remoteFile.path, temporary);
      if (received.sha256 !== remoteFile.version) {
        // It changed between the listing and the download: next reconcile.
        result.stale = true;
        return;
      }
      const target = join(root, ...targetPath.split("/"));
      // The local file must still be the one this round read, or absent.
      const current = await stat(target).catch(() => null);
      if (expected === null ? current !== null : current === null || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) {
        result.stale = true;
        return;
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(temporary, target);
      const placed = await stat(target);
      base.put(key, { path: targetPath, sha256: remoteFile.version, size: placed.size, mtimeMs: placed.mtimeMs });
      await rememberText(key, targetPath, target, remoteFile.version);
      result.downloaded += 1;
    } finally {
      await rm(temporary, { force: true });
    }
  };

  const removeEmptyFolders = async (from: string): Promise<void> => {
    let folder = dirname(from);
    while (folder.startsWith(root + sep) && folder !== root) {
      try {
        await rmdir(folder);
      } catch {
        return;
      }
      folder = dirname(folder);
    }
  };

  const apply = async ({ key, action, localSha }: (typeof plan)[number]) => {
    const file = local.get(key) ?? null;
    const remoteFile = remoteFiles.get(key) ?? null;
    const known = bases.get(key) ?? null;
    const path = file?.path ?? remoteFile?.path ?? known?.path ?? key;
    try {
      switch (action) {
        case "adopt":
          if (file && localSha) {
            base.put(key, { path: file.path, sha256: localSha, size: file.size, mtimeMs: file.mtimeMs });
            await rememberText(key, file.path, file.abs, localSha);
          }
          break;
        case "forget":
          base.drop(key);
          break;
        case "upload": {
          if (!file || !localSha) break;
          if (file.size > maxFileBytes) {
            result.skipped.push({ path, reason: "too_large" });
            result.pending += 1;
            break;
          }
          const version = remoteFile?.version;
          await remote.upload(file.path, file.abs, "application/octet-stream", version === undefined ? { createOnly: true } : { version });
          base.put(key, { path: file.path, sha256: localSha, size: file.size, mtimeMs: file.mtimeMs });
          await rememberText(key, file.path, file.abs, localSha);
          result.uploaded += 1;
          break;
        }
        case "download":
          await placeDownload(key, file?.path ?? path, file);
          break;
        case "delete-remote":
          if (holdDeletions || !known) {
            result.pending += 1;
            break;
          }
          if (!remote.deleteFile) throw new ApiError(400, "storage_delete_unsupported", "This storage cannot delete files.");
          await remote.deleteFile(known.path, { version: known.sha256 });
          base.drop(key);
          result.removedRemote += 1;
          break;
        case "delete-local": {
          if (!file) break;
          const trashed = join(trashDir, ...file.path.split("/"));
          await mkdir(dirname(trashed), { recursive: true });
          await rename(file.abs, trashed);
          await removeEmptyFolders(file.abs);
          base.drop(key);
          result.removedLocal += 1;
          break;
        }
        case "conflict": {
          if (!file || !remoteFile) break;
          if (await mergeBoth(key, file, remoteFile)) break;
          const copyPath = conflictCopyPath(file.path, label, now(), (candidate) => takenPaths.has(fileKey(candidate)));
          takenPaths.add(fileKey(copyPath));
          await rename(file.abs, join(root, ...copyPath.split("/")));
          await placeDownload(key, file.path, null);
          result.conflicts.push({ path: file.path, copyPath });
          extraUploads.push(copyPath);
          break;
        }
        case "none":
          break;
      }
    } catch (error) {
      if (!fileLevel(error)) throw error;
      if (isStale(error)) result.stale = true;
      else result.skipped.push({ path, reason: error instanceof ApiError && error.status === 413 ? "too_large" : "failed", detail: messageOf(error) });
      if (action === "upload" || action === "delete-remote" || action === "conflict") result.pending += 1;
    }
  };
  // Transfers touch distinct paths. Conflicts reserve new names and deletions
  // change folder structure, so those retain their original serial ordering.
  await syncBatches(plan.filter(step => ["upload", "download", "adopt"].includes(step.action)), 4, apply);
  for (const step of plan.filter(step => !["upload", "download", "adopt"].includes(step.action))) await apply(step);

  // This computer's side of each conflict, as a new file under its own name.
  for (const copyPath of extraUploads) {
    const abs = join(root, ...copyPath.split("/"));
    try {
      const info = await stat(abs);
      const sha256 = await hashFile(abs);
      await remote.upload(copyPath, abs, "application/octet-stream", { createOnly: true });
      base.put(fileKey(copyPath), { path: copyPath, sha256, size: info.size, mtimeMs: info.mtimeMs });
      result.uploaded += 1;
    } catch (error) {
      if (!fileLevel(error)) throw error;
      result.pending += 1;
      if (isStale(error)) result.stale = true;
    }
  }

  await rm(workDir, { recursive: true, force: true });
  return result;
}
