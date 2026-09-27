import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ApiError } from "./errors.js";
import type { StorageAdapter } from "./file-storage/common.js";
import { decide, fileKey, type FileBase } from "./project-file-sync.js";
import { SavedReviewSchema, type ReviewCell, type SavedReview } from "./reviews/schema.js";
import { atomicJson, serialized } from "./reviews/storage.js";

/**
 * A synced project's Tabular Reviews, and the earlier runs kept of each, go
 * with its documents. They live in the project folder
 * (`.opencode/legalwork/reviews/`), which document sync never reads, and at
 * the firm under `.legalwork/reviews/`, a path older LegalWork versions skip.
 *
 * Each review file is compared three ways, as documents are: here, at the
 * firm, and as both sides last agreed. A review changed on both sides is not
 * kept twice, as a document would be: it is merged part by part (name,
 * settings, each column, each document, each answer cell), and where both
 * sides changed the same part, the newer change wins; for an answer, the
 * answer given later. An earlier run's snapshot is only ever replaced whole.
 *
 * What only makes sense on this computer never leaves it: the chat a review
 * was started from, where its prepared documents are cached, its revision
 * counter. A review running here goes up with a mark naming who runs it (and
 * when this computer last said so), so the others watch instead of running
 * it too; it takes changes from the firm once its run has ended.
 */

/** Where review data lives at the firm, inside the project. */
export const REVIEW_SYNC_PREFIX = ".legalwork/reviews";
const LIVE = /^[0-9a-f-]{36}\.json$/;
const HISTORY = /^[0-9a-f-]{36}-[0-9a-f-]{36}\.json$/;

/** A path at the firm that holds a project's review data rather than one of its documents. */
export function reviewSyncPath(path: string): boolean {
  if (!path.startsWith(`${REVIEW_SYNC_PREFIX}/`)) return false;
  const rest = path.slice(REVIEW_SYNC_PREFIX.length + 1);
  return LIVE.test(rest) || (rest.startsWith("history/") && HISTORY.test(rest.slice("history/".length)));
}

/**
 * The documents a review at `path` reviews, as the firm is told when it goes
 * up; undefined for an earlier run's snapshot or anything else.
 */
export function reviewedDocuments(path: string, data: Buffer): string[] | undefined {
  if (!reviewSyncPath(path) || path.startsWith(`${REVIEW_SYNC_PREFIX}/history/`)) return undefined;
  const read = parseShared(data.toString("utf8"));
  return read ? read.review.documents.map((document) => document.path) : [];
}

const documentCache = new Map<string, { size: number; mtimeMs: number; paths: string[] }>();

/**
 * The documents this computer's reviews of a project review, by file key:
 * with only reviews shared, these are the documents that go with them.
 * Unchanged review files are not read again.
 */
export async function reviewDocumentKeys(root: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const local = await scanLocal(await reviewFolder(root)).catch(() => new Map<string, LocalFile>());
  for (const [key, file] of local) {
    if (key.startsWith(`${REVIEW_SYNC_PREFIX}/history/`)) continue;
    let known = documentCache.get(file.abs);
    if (!known || known.size !== file.size || known.mtimeMs !== file.mtimeMs) {
      const read = parseShared(await readFile(file.abs, "utf8").catch(() => ""));
      known = { size: file.size, mtimeMs: file.mtimeMs, paths: read ? read.review.documents.map((document) => document.path) : [] };
      documentCache.set(file.abs, known);
    }
    for (const path of known.paths) keys.add(fileKey(path));
  }
  return keys;
}

/** What both sides last agreed on, per path at the firm; `content` is the agreed review, for merging. */
export type ReviewBase = FileBase & { content: string | null };
export type ReviewBaseStore = {
  entries(): Map<string, ReviewBase>;
  put(path: string, entry: ReviewBase): void;
  drop(path: string): void;
};

export type ReviewSyncOptions = {
  /** The project folder. */
  root: string;
  remote: StorageAdapter;
  base: ReviewBaseStore;
  /** List the firm's copy; without it, it is taken to be as last agreed (see project-file-sync.ts). */
  reconcile: boolean;
  /** Whether this computer is running the review now. */
  runningHere: (id: string) => boolean;
  /** Who this computer's user is, named on a review it runs. */
  runner: { userId: string; name: string | null };
  now?: () => Date;
};

export type ReviewSyncResult = {
  uploaded: number;
  downloaded: number;
  removedRemote: number;
  removedLocal: number;
  /** A conditional write found a newer version at the firm: reconcile next time. */
  stale: boolean;
  /** Changes here not at the firm yet. */
  pending: number;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A review as it syncs: without what only makes sense on this computer. */
export function sharedReview(review: SavedReview): SavedReview {
  const { sessionCreatedForReview: _created, ...rest } = review;
  return SavedReviewSchema.parse({
    ...rest,
    revision: 0,
    sessionId: null,
    documents: review.documents.map(({ preparationPath: _path, ...document }) => document),
    cells: review.cells.map((cell) => {
      if (!cell.result) return cell;
      const { preparationPath: _path, ...result } = cell.result;
      return { ...cell, result };
    }),
  });
}

/** Both sides changed it: the side that changed it, or the newer side if both did; an edit beats a removal. */
function part<T>(local: T | undefined, remote: T | undefined, base: T | undefined, localNewer: boolean): T | undefined {
  if (same(local, remote)) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;
  if (local === undefined || remote === undefined) return local ?? remote;
  return localNewer ? local : remote;
}

/** Two answers to one cell: the one given later, whatever else changed about the cell. */
function cellPart(local: ReviewCell | undefined, remote: ReviewCell | undefined, base: ReviewCell | undefined, localNewer: boolean) {
  const picked = part(local, remote, base, localNewer);
  if (!local || !remote || same(local, remote) || same(local, base) || same(remote, base)) return picked;
  const localAt = local.result?.completedAt ?? 0;
  const remoteAt = remote.result?.completedAt ?? 0;
  return localAt === remoteAt ? picked : localAt > remoteAt ? local : remote;
}

function mergeList<T>(
  local: T[],
  remote: T[],
  base: T[] | null,
  key: (item: T) => string,
  pick: (local: T | undefined, remote: T | undefined, base: T | undefined) => T | undefined,
): T[] {
  const byKey = (items: T[]) => new Map(items.map((item) => [key(item), item]));
  const [mine, theirs, agreed] = [byKey(local), byKey(remote), byKey(base ?? [])];
  // The order of whichever side moved things; the firm's when neither or both did.
  const localMoved = base !== null && !same(local.map(key), base.map(key));
  const order = [...new Set([...(localMoved ? local : remote).map(key), ...local.map(key), ...remote.map(key)])];
  return order.flatMap((id) => {
    const item = pick(mine.get(id), theirs.get(id), agreed.get(id));
    return item === undefined ? [] : [item];
  });
}

/**
 * One review from two sides that both changed it since they last agreed
 * (`base`, null when they never did). All three in their shared form.
 */
export function mergeReviews(local: SavedReview, remote: SavedReview, base: SavedReview | null): SavedReview {
  const localNewer = local.updatedAt > remote.updatedAt;
  const pick = <T>(l: T | undefined, r: T | undefined, b: T | undefined) => part(l, r, b, localNewer);
  const scalar = <K extends "name" | "settings" | "runId" | "error" | "createdAt">(key: K) => pick(local[key], remote[key], base?.[key]);
  // Whether it runs, and on whose computer, is one thing.
  const run = (review: SavedReview) => ({ status: review.status, runner: review.runner ?? null });
  const state = pick(run(local), run(remote), base ? run(base) : undefined) ?? run(remote);
  const columns = mergeList(local.columns, remote.columns, base?.columns ?? null, (column) => column.key, pick);
  // One document added on both sides is one document: the firm's.
  const firmDocument = new Map(remote.documents.map((document) => [document.path, document.id]));
  const documents = mergeList(local.documents, remote.documents, base?.documents ?? null, (document) => document.id, pick).filter(
    (document) => (firmDocument.get(document.path) ?? document.id) === document.id,
  );
  const cellKey = (cell: ReviewCell) => `${cell.documentId}:${cell.columnKey}`;
  const cells = new Map(
    mergeList(local.cells, remote.cells, base?.cells ?? null, cellKey, (l, r, b) => cellPart(l, r, b, localNewer)).map((cell) => [
      cellKey(cell),
      cell,
    ]),
  );
  const merged: SavedReview = {
    ...remote,
    name: scalar("name") ?? remote.name,
    settings: scalar("settings") ?? remote.settings,
    runId: scalar("runId") ?? null,
    error: scalar("error") ?? null,
    createdAt: scalar("createdAt") ?? remote.createdAt,
    status: state.status,
    runner: state.runner,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    columns,
    documents,
    cells: documents.flatMap((document) =>
      columns.map((column): ReviewCell => {
        const cell = cells.get(`${document.id}:${column.key}`) ?? { documentId: document.id, columnKey: column.key, status: "pending", result: null, error: null };
        // An answer to a question that has changed since is out of date, as after an edit.
        const outdated = cell.result !== null && !same(cell.result.prompt, column) && (cell.status === "complete" || cell.status === "needs_review");
        return outdated ? { ...cell, status: "stale" } : cell;
      }),
    ),
  };
  const checked = SavedReviewSchema.safeParse(merged);
  // Together more than a review may hold (columns, documents): the firm's stands.
  return checked.success ? checked.data : remote;
}

/** The shared form's text, or null for a file that is no review (it is left alone). */
function parseShared(text: string): { review: SavedReview; json: string } | null {
  try {
    const review = sharedReview(SavedReviewSchema.parse(JSON.parse(text)));
    return { review, json: JSON.stringify(review) };
  } catch {
    return null;
  }
}

type LocalFile = { key: string; abs: string; size: number; mtimeMs: number };

/** Local review files by their path at the firm; the folder is where the review store keeps them. */
async function scanLocal(folder: string): Promise<Map<string, LocalFile>> {
  const files = new Map<string, LocalFile>();
  const add = async (dir: string, pattern: RegExp, prefix: string) => {
    for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      // Links are never followed, as the review store refuses them too.
      if (!item.isFile() || !pattern.test(item.name)) continue;
      const abs = join(dir, item.name);
      const info = await lstat(abs);
      files.set(`${prefix}${item.name}`, { key: `${prefix}${item.name}`, abs, size: info.size, mtimeMs: info.mtimeMs });
    }
  };
  await add(folder, LIVE, `${REVIEW_SYNC_PREFIX}/`);
  await add(join(folder, "history"), HISTORY, `${REVIEW_SYNC_PREFIX}/history/`);
  return files;
}

async function reviewFolder(root: string): Promise<string> {
  // The same path the review store locks its files by.
  return join(await realpath(root), ".opencode", "legalwork", "reviews");
}

/** Only failures of this one review are skipped; anything else stops the round. */
function fileLevel(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 404 || error.status === 409 || error.status === 413 || error.status === 400;
}

/** Changes to reviews here that the firm has not got yet, without reading them. */
export async function pendingReviewChanges(root: string, base: ReviewBaseStore): Promise<number> {
  const local = await scanLocal(await reviewFolder(root)).catch(() => new Map<string, LocalFile>());
  const agreed = base.entries();
  let changed = 0;
  for (const [key, file] of local) {
    const known = agreed.get(key);
    if (!known || known.size !== file.size || known.mtimeMs !== file.mtimeMs) changed += 1;
  }
  for (const key of agreed.keys()) if (!local.has(key)) changed += 1;
  return changed;
}

export async function syncProjectReviews(options: ReviewSyncOptions): Promise<ReviewSyncResult> {
  const { remote, base, runner } = options;
  const now = options.now ?? (() => new Date());
  const result: ReviewSyncResult = { uploaded: 0, downloaded: 0, removedRemote: 0, removedLocal: 0, stale: false, pending: 0 };
  const folder = await reviewFolder(options.root);
  const local = await scanLocal(folder);
  const bases = base.entries();
  // No review folder at all (it was removed, or the project copied without
  // it) is not everyone deleting every review: what the firm has comes back.
  if (!(await lstat(folder).catch(() => null))) {
    for (const key of bases.keys()) base.drop(key);
    bases.clear();
  }
  const absOf = (key: string) => join(folder, ...key.slice(REVIEW_SYNC_PREFIX.length + 1).split("/"));
  const idOf = (key: string) => key.slice(REVIEW_SYNC_PREFIX.length + 1).slice(0, 36);
  const isLive = (key: string) => !key.startsWith(`${REVIEW_SYNC_PREFIX}/history/`);

  const remoteFiles = new Map<string, string>();
  if (options.reconcile) {
    if (!remote.listFiles) throw new ApiError(400, "storage_listing_unsupported", "This storage cannot list a folder's files at once.");
    let cursor: string | undefined;
    do {
      const page = await remote.listFiles(REVIEW_SYNC_PREFIX, cursor);
      for (const item of page.entries) {
        if (item.kind === "file" && item.version !== undefined && reviewSyncPath(item.path)) remoteFiles.set(item.path, item.version);
      }
      cursor = page.nextCursor;
    } while (cursor);
  } else {
    for (const [key, entry] of bases) remoteFiles.set(key, entry.sha256);
  }

  // This side's shared form of each file; an unchanged file is as last agreed, unread.
  const shared = new Map<string, { review: SavedReview; json: string; running: boolean }>();
  const localVersion = new Map<string, string>();
  for (const [key, file] of local) {
    const known = bases.get(key);
    const running = isLive(key) && options.runningHere(idOf(key));
    if (known && !running && known.size === file.size && known.mtimeMs === file.mtimeMs) {
      localVersion.set(key, known.sha256);
      continue;
    }
    const read = parseShared(await readFile(file.abs, "utf8").catch(() => ""));
    if (!read) continue;
    if (running) {
      read.review = { ...read.review, runner: { userId: runner.userId, name: runner.name, at: now().getTime() } };
      read.json = JSON.stringify(read.review);
    }
    shared.set(key, { ...read, running });
    localVersion.set(key, sha256(read.json));
  }
  const unreadable = new Set([...local.keys()].filter((key) => !localVersion.has(key)));

  const readLocalShared = async (key: string) => {
    const known = shared.get(key);
    if (known) return known;
    const file = local.get(key);
    const read = file ? parseShared(await readFile(file.abs, "utf8")) : null;
    return read ? { ...read, running: false } : null;
  };

  const fetchRemote = async (key: string): Promise<{ review: SavedReview; json: string } | null> => {
    const version = remoteFiles.get(key);
    if (version === undefined) return null;
    const workDir = join(options.root, ".legalwork", "sync-tmp");
    await mkdir(workDir, { recursive: true });
    const temporary = join(workDir, randomUUID());
    try {
      const received = await remote.download(key, temporary);
      if (received.version !== version) {
        result.stale = true;
        return null;
      }
      const text = await readFile(temporary, "utf8");
      const read = parseShared(text);
      // What the firm holds is kept by its own text, so both sides agree on its version.
      return read ? { review: read.review, json: text } : null;
    } finally {
      await rm(temporary, { force: true });
    }
  };

  /**
   * Put a review in place here, as `review` has it plus what only this
   * computer knows of it. Only over the file this round read (or none): a
   * review changed here meanwhile waits for the next round.
   */
  const place = async (key: string, review: SavedReview, agreedJson: string, record = true): Promise<boolean> => {
    const abs = absOf(key);
    const expected = local.get(key) ?? null;
    return serialized(abs, async () => {
      const current = await lstat(abs).catch(() => null);
      if (expected === null ? current !== null : current === null || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) {
        result.stale = true;
        return false;
      }
      const mine = current === null ? null : SavedReviewSchema.parse(JSON.parse(await readFile(abs, "utf8")));
      await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
      await atomicJson(abs, isLive(key) ? withLocalParts(review, mine) : review);
      const placed = await lstat(abs);
      local.set(key, { key, abs, size: placed.size, mtimeMs: placed.mtimeMs });
      if (record) base.put(key, { path: key, sha256: sha256(agreedJson), size: placed.size, mtimeMs: placed.mtimeMs, content: isLive(key) ? agreedJson : null });
      result.downloaded += 1;
      return true;
    });
  };

  const upload = async (key: string, json: string, condition: { version?: string; createOnly?: boolean }, record = true) => {
    await remote.write(key, Buffer.from(json), "application/json", condition);
    const file = local.get(key);
    if (file && record) base.put(key, { path: key, sha256: sha256(json), size: file.size, mtimeMs: file.mtimeMs, content: isLive(key) ? json : null });
    result.uploaded += 1;
  };

  const trashDir = join(options.root, ".legalwork", "sync-trash", now().toISOString().replace(/[:.]/g, "-"), ".opencode", "legalwork", "reviews");

  for (const key of new Set([...local.keys(), ...remoteFiles.keys(), ...bases.keys()])) {
    if (unreadable.has(key)) continue;
    const localSha = localVersion.get(key) ?? null;
    const remoteSha = remoteFiles.get(key) ?? null;
    const agreed = bases.get(key) ?? null;
    const action = decide(localSha, remoteSha, agreed?.sha256 ?? null);
    const running = shared.get(key)?.running ?? false;
    try {
      // A review running here takes the firm's changes once its run has ended.
      if (running && (action === "download" || action === "delete-local")) {
        result.pending += 1;
        continue;
      }
      switch (action) {
        case "none":
          break;
        case "adopt": {
          const file = local.get(key);
          const read = await readLocalShared(key);
          if (file && read && localSha) base.put(key, { path: key, sha256: localSha, size: file.size, mtimeMs: file.mtimeMs, content: isLive(key) ? read.json : null });
          break;
        }
        case "forget":
          base.drop(key);
          break;
        case "upload": {
          const read = await readLocalShared(key);
          if (read) await upload(key, read.json, remoteSha === null ? { createOnly: true } : { version: remoteSha });
          break;
        }
        case "download": {
          const fetched = await fetchRemote(key);
          if (fetched) await place(key, fetched.review, fetched.json);
          break;
        }
        case "delete-remote":
          if (!remote.deleteFile) throw new ApiError(400, "storage_delete_unsupported", "This storage cannot delete files.");
          if (agreed) await remote.deleteFile(key, { version: agreed.sha256 });
          base.drop(key);
          result.removedRemote += 1;
          break;
        case "delete-local": {
          const file = local.get(key);
          if (!file) break;
          const trashed = join(trashDir, ...key.slice(REVIEW_SYNC_PREFIX.length + 1).split("/"));
          await mkdir(dirname(trashed), { recursive: true });
          await serialized(file.abs, () => rename(file.abs, trashed));
          base.drop(key);
          result.removedLocal += 1;
          break;
        }
        case "conflict": {
          const mine = await readLocalShared(key);
          const theirs = await fetchRemote(key);
          if (!mine || !theirs || remoteSha === null) break;
          if (!isLive(key)) {
            // An earlier run's snapshot: the one saved later stands.
            if (theirs.review.updatedAt >= mine.review.updatedAt) await place(key, theirs.review, theirs.json);
            else await upload(key, mine.json, { version: remoteSha });
            break;
          }
          const agreedReview = agreed?.content ? parseShared(agreed.content)?.review ?? null : null;
          let merged = mergeReviews(mine.review, theirs.review, agreedReview);
          if (running) {
            // Its run here goes on over the file as it is: the others see the merge
            // (and that it runs here); this computer takes it in once the run has
            // ended, and until then nothing counts as agreed.
            merged = { ...merged, status: mine.review.status, runner: mine.review.runner };
            await upload(key, JSON.stringify(merged), { version: remoteSha }, false);
            result.pending += 1;
            break;
          }
          // A run of this user's that no longer runs here (it ended, or this computer restarted) is over.
          if (merged.status === "running" && merged.runner?.userId === runner.userId && !options.runningHere(idOf(key))) {
            merged = { ...merged, status: mine.review.status === "running" ? "interrupted" : mine.review.status, runner: null };
          }
          const json = JSON.stringify(merged);
          // Agreed only once the firm has it: refused, the next round merges again.
          if (await place(key, merged, json, false)) {
            await upload(key, json, { version: remoteSha });
          }
          break;
        }
      }
    } catch (error) {
      if (!fileLevel(error)) throw error;
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) result.stale = true;
      if (action === "upload" || action === "delete-remote" || action === "conflict") result.pending += 1;
    }
  }
  await rm(join(options.root, ".legalwork", "sync-tmp"), { recursive: true, force: true });
  return result;
}

/** A review from the firm, with what only this computer knows of its copy here kept. */
function withLocalParts(review: SavedReview, mine: SavedReview | null): SavedReview {
  if (!mine) return { ...review, revision: 0, sessionId: null };
  const documents = new Map(mine.documents.map((document) => [document.id, document]));
  const results = new Map(mine.cells.map((cell) => [`${cell.documentId}:${cell.columnKey}`, cell.result]));
  return {
    ...review,
    // The app reloads a review whose revision moved.
    revision: mine.revision + 1,
    sessionId: mine.sessionId ?? null,
    ...(mine.sessionCreatedForReview === undefined ? {} : { sessionCreatedForReview: mine.sessionCreatedForReview }),
    documents: review.documents.map((document) => {
      const here = documents.get(document.id);
      return here?.preparationPath && here.sourceHash === document.sourceHash ? { ...document, preparationPath: here.preparationPath } : document;
    }),
    cells: review.cells.map((cell) => {
      const here = results.get(`${cell.documentId}:${cell.columnKey}`);
      return cell.result && here?.preparationPath && here.completedAt === cell.result.completedAt
        ? { ...cell, result: { ...cell.result, preparationPath: here.preparationPath } }
        : cell;
    }),
  };
}
