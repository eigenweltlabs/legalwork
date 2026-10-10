import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../errors.js";
import type { StorageAdapter } from "../file-storage/common.js";
import { createRemoteProject, type RemoteProjectFile } from "../eigenwelt-projects.js";
import { eigenweltProjectStorage, type RemoteFileIndex } from "../eigenwelt-project-storage.js";
import { requireIntakeClient, type IntakeClient } from "../eigenwelt-intake.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import type { ServerConfig } from "../types.js";
import { digest, syncConflict, type SyncObjects } from "./objects.js";

/** Session data has an owner-only type, but uses the SAME project file API,
 * version conditions, file index, presigned chunks and object store as projects. */
export class PlatformObjects implements SyncObjects {
  private files: RemoteProjectFile[] = [];
  private seq: number | null = null;
  private blobs: Promise<StorageAdapter> | null = null;
  private index: RemoteFileIndex = {
    seq: () => this.seq, files: () => this.files,
    replace: (files, seq) => { if (this.seq !== null && seq !== null && seq < this.seq) return; this.files = files; this.seq = seq; },
    apply: changes => {
      if (this.seq !== null && changes.seq < this.seq) return;
      const files = new Map(this.files.map(file => [file.path.toLowerCase(), file]));
      for (const removed of changes.removed) files.delete(removed.toLowerCase());
      for (const file of changes.files) files.set(file.path.toLowerCase(), file);
      this.files = [...files.values()]; this.seq = changes.seq;
    },
    clear: () => { this.files = []; this.seq = null; },
  };
  private constructor(private client: () => Promise<IntakeClient>, readonly projectId: string) {}
  static async open(config: ServerConfig, accountId: string) {
    const client = async () => {
      await ensureFreshPlatformToken(config);
      return requireIntakeClient(await readEigenweltConnection(config));
    };
    const hash = createHash("sha256").update(`legalwork-personal-state-v1:${accountId}`).digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const project = await createRemoteProject(await client(), { id, purpose: "personal-state", name: "Personal assistant state",
      fields: [], scope: { documents: true, notes: false, tasks: false, recordings: false, metadata: false, reviews: false, calendar: false },
      access: "members", memberIds: [] });
    if (project.purpose !== "personal-state" || project.role !== "owner" || project.access !== "members" || project.memberIds.length) {
      throw new ApiError(409, "sync_platform_upgrade", "The platform needs private personal-state support before sessions can be uploaded.");
    }
    return new PlatformObjects(client, id);
  }
  async adapter() { return eigenweltProjectStorage(await this.client(), this.projectId, this.index); }
  private blobAdapter() { return this.blobs ??= this.adapter().catch(error => { this.blobs = null; throw error; }); }
  async stat(key: string) { return (await (await (key.startsWith("blobs/") ? this.blobAdapter() : this.adapter())).stat(key))?.version ?? null; }
  async get(key: string) {
    // Control must always be fresh. Immutable chunks share a listing until
    // the next control read; a newly published checkpoint refreshes it too.
    if (key === "control.json") this.blobs = null;
    let adapter = await (key.startsWith("blobs/") ? this.blobAdapter() : this.adapter());
    if (key.startsWith("blobs/") && await adapter.stat(key) === null) adapter = await this.adapter();
    if (await adapter.stat(key) === null) return null;
    const temporary = await mkdtemp(join(tmpdir(), "legalwork-sync-read-"));
    try {
      const path = join(temporary, "data");
      const file = await adapter.download(key, path);
      return { data: await readFile(path), revision: file.version };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async put(key: string, data: Buffer, expected: string | null) {
    const temporary = await mkdtemp(join(tmpdir(), "legalwork-sync-write-"));
    try {
      const path = join(temporary, "data");
      await writeFile(path, data, { mode: 0o600 });
      await (await this.adapter()).upload(key, path, "application/octet-stream", expected === null ? { createOnly: true } : { version: expected });
      return digest(data);
    } catch (error) { if (error instanceof ApiError && error.status === 409) syncConflict(); throw error; }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

/** A resource directory inside personal state. No second index/manifest. */
export function resourceStorage(adapter: StorageAdapter, prefix: string, virtualRoot = ""): StorageAdapter {
  const path = (value: string) => {
    const relative = virtualRoot && value.startsWith(virtualRoot) ? value.slice(virtualRoot.length).replace(/^\//, "") : value;
    return relative ? `${prefix}/${relative}` : prefix;
  };
  const virtual = (value: string) => [virtualRoot, value.slice(prefix.length + 1)].filter(Boolean).join("/");
  const page = async (value: string, cursor?: string) => {
    const result = await adapter.list(path(value), cursor);
    return { ...result, entries: result.entries.map(file => ({ ...file, path: virtual(file.path) })) };
  };
  return {
    list: page,
    async listFiles(value, cursor) {
      const result = await adapter.listFiles?.(path(value), cursor);
      if (!result) return page(value, cursor);
      return { ...result, entries: result.entries.map(file => ({ ...file, path: virtual(file.path) })) };
    },
    stat: value => adapter.stat(path(value)), read: value => adapter.read(path(value)),
    download: (value, destination) => adapter.download(path(value), destination),
    write: (value, data, contentType, condition) => adapter.write(path(value), data, contentType, condition),
    upload: (value, source, contentType, condition) => adapter.upload(path(value), source, contentType, condition),
    mkdir: value => adapter.mkdir(path(value)),
    deleteFile: (value, condition) => adapter.deleteFile ? adapter.deleteFile(path(value), condition) : Promise.reject(new Error("Storage cannot delete files")),
  };
}
