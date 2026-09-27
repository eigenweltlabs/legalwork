import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageEntry } from "@legalwork/types/file-storage";

import type { IntakeClient } from "./eigenwelt-intake.js";
import {
  deleteRemoteProjectFile,
  downloadRemoteProjectFile,
  listRemoteProjectChanges,
  listRemoteProjectFiles,
  type RemoteProjectChanges,
  type RemoteProjectFile,
  uploadRemoteProjectFile,
} from "./eigenwelt-projects.js";
import { ApiError } from "./errors.js";
import { safeRemotePath } from "./project-file-sync.js";
import { reviewedDocuments, reviewSyncPath } from "./project-review-sync.js";
import {
  collectStream,
  entry,
  pageEntries,
  type StorageAdapter,
  type WriteCondition,
} from "./file-storage/common.js";

/**
 * The firm's listing of a project's documents as this computer last saw it,
 * with the number of the last change in it: kept, so a listing only asks
 * what changed since (project-sync-store.ts keeps it).
 */
export type RemoteFileIndex = {
  seq(): number | null;
  files(): RemoteProjectFile[];
  replace(files: RemoteProjectFile[], seq: number | null): void;
  apply(changes: RemoteProjectChanges): void;
  /** Forget it: the next listing is a whole one. */
  clear(): void;
};

/** Projects listed whole since this server started: a kept listing is trusted from the second round on. */
const listedWhole = new Set<string>();

/**
 * A synced project's documents on the Eigenwelt platform, behind the same
 * StorageAdapter every connected storage implements (file-storage/). Project
 * sync (project-file-sync.ts) talks to this interface only, so the documents
 * could as well sync with any other adapter that lists versions.
 *
 * Folders are implied by paths: there are no empty folders, and `mkdir` has
 * nothing to do. A document's version is its sha256. With an `index`, a
 * listing is the kept one brought up to date with what changed since; one
 * adapter lists once (a round's reviews and documents share it).
 */
export function eigenweltProjectStorage(client: IntakeClient, projectId: string, index?: RemoteFileIndex): StorageAdapter {
  let fresh: Promise<RemoteProjectFile[]> | null = null;
  const current = async (): Promise<RemoteProjectFile[]> => {
    const seq = index?.seq() ?? null;
    if (index && seq !== null && listedWhole.has(projectId)) {
      const changes = await listRemoteProjectChanges(client, projectId, seq);
      if (!changes.reset) {
        index.apply(changes);
        return index.files();
      }
    }
    const whole = await listRemoteProjectFiles(client, projectId);
    index?.replace(whole.files, whole.seq);
    listedWhole.add(projectId);
    return whole.files;
  };
  // A path that could leave the project folder is not listed at all: one bad
  // entry must not stop the project's other documents from syncing. Review
  // data (project-review-sync.ts) is listed; document sync passes it over.
  const listing = async (): Promise<RemoteProjectFile[]> =>
    (await (fresh ??= current())).filter((file) => safeRemotePath(file.path) || reviewSyncPath(file.path));
  const find = async (path: string) => {
    const key = path.toLowerCase();
    return (await listing()).find((file) => file.path.toLowerCase() === key) ?? null;
  };
  // The platform checks the version itself; an unconditional write names
  // whatever is there now.
  const ifMatchFor = async (path: string, condition: WriteCondition): Promise<string | null> => {
    if (condition.version !== undefined) return condition.version;
    if (condition.createOnly) return null;
    return (await find(path))?.sha256 ?? null;
  };
  const toEntry = (file: RemoteProjectFile): StorageEntry => ({
    ...entry(file.path, "file", file.size, file.updatedAt),
    version: file.sha256,
  });

  return {
    async list(path, cursor) {
      const prefix = path ? `${path}/` : "";
      const children = new Map<string, StorageEntry>();
      for (const file of await listing()) {
        if (!file.path.startsWith(prefix)) continue;
        const [name, ...rest] = file.path.slice(prefix.length).split("/");
        children.set(name, rest.length === 0 ? toEntry(file) : entry(`${prefix}${name}`, "folder"));
      }
      return pageEntries([...children.values()], cursor);
    },
    async listFiles(path) {
      const prefix = path ? `${path}/` : "";
      return { entries: (await listing()).filter((file) => file.path.startsWith(prefix)).map(toEntry) };
    },
    async stat(path) {
      const file = await find(path);
      return file === null ? null : { size: file.size, version: file.sha256, contentType: file.contentType };
    },
    async read(path) {
      const file = await find(path);
      if (file === null) throw new ApiError(404, "storage_not_found", "The file was not found.");
      const folder = await mkdtemp(join(tmpdir(), "legalwork-project-"));
      try {
        const target = join(folder, "file");
        await downloadRemoteProjectFile(client, projectId, file.path, target);
        return { size: file.size, version: file.sha256, contentType: file.contentType, data: await collectStream(createReadStream(target)) };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    async download(path, destination) {
      if (destination === undefined) throw new ApiError(400, "storage_destination_required", "Download needs a destination.");
      const received = await downloadRemoteProjectFile(client, projectId, path, destination);
      return { ...received, version: received.sha256 };
    },
    async write(path, data, contentType, condition) {
      await uploadRemoteProjectFile(client, projectId, path, data, contentType, await ifMatchFor(path, condition), reviewedDocuments(path, data));
    },
    async upload(path, source, contentType, condition) {
      await uploadRemoteProjectFile(client, projectId, path, source, contentType, await ifMatchFor(path, condition));
    },
    async mkdir() {
      // Folders exist through the paths of the documents in them.
    },
    async deleteFile(path, condition) {
      const version = condition?.version ?? (await find(path))?.sha256;
      if (version !== undefined) await deleteRemoteProjectFile(client, projectId, path, version);
    },
  };
}
