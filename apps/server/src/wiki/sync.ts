import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { WikiRegistration, WikiSharingInput, WikiTeamOverview, WikiTeamRecord, WikiTeamSyncSettings, WikiSyncStatus } from "@legalwork/types/wiki";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { parseFrontmatter, buildFrontmatter } from "../frontmatter.js";
import { WikiTeamClient } from "./team-client.js";
import { mergeText, mergeableText, MERGEABLE_TEXT_MAX_BYTES } from "./text-merge.js";
import type { WikiStore } from "./store.js";

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const DOWNLOAD_CONCURRENCY = 6;
const entrySchema = z.object({ path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(100 * 1024 * 1024) });
type SyncedFile = z.infer<typeof entrySchema>;
const baseSchema = z.object({ binding: z.string(), files: z.array(entrySchema.extend({ text: z.string().optional() })).max(50_000) });
const sharingSchema = z.object({ access: z.enum(["org", "members"]), memberIds: z.array(z.string().min(1)).max(1000) });
const intentSchema = z.object({ orgId: z.string().min(1), wikiId: z.string().uuid(), input: sharingSchema.optional() });
type SyncBase = z.infer<typeof baseSchema>;
type Store = Pick<WikiStore, "list" | "get" | "create" | "update" | "files" | "readAsset" | "writeAsset" | "remove">;
type TeamClient = Pick<WikiTeamClient, "overview" | "cached" | "ownerOffline" | "record" | "create" | "update" | "rename" | "remove" | "files" | "read" | "write" | "delete">;
type Options = { client?: TeamClient; intervalMs?: number };
const teamBinding = (wiki: WikiRegistration): WikiTeamSyncSettings => {
  if (!wiki.sync) throw new ApiError(400, "wiki_not_shared", "This wiki is local.");
  if (!("kind" in wiki.sync)) throw new ApiError(409, "wiki_sharing_migration_required", "This wiki uses retired connector sharing. Its local files are retained. Stop the old sharing and share it with your firm to migrate.");
  return wiki.sync;
};
const localStatus = (): WikiSyncStatus => ({ state: "local", lastSyncedAt: null, error: null, conflicts: [] });

/** Saved Markdown files synchronize independently with per-file SHA revision checks. */
export class WikiSync {
  private statuses = new Map<string, WikiSyncStatus>();
  private pending = new Map<string, Promise<WikiSyncStatus>>();
  private dirty = new Set<string>();
  private sharingPending = new Map<string, Promise<WikiTeamRecord>>();
  private joiningPending = new Map<string, Promise<WikiRegistration>>();
  private scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private hashes = new Map<string, { size: number; updatedAt: number; changedAt: number | undefined; hash: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private client: TeamClient;
  private stateDirectory: string;
  constructor(private config: ServerConfig, private store: Store, private options: Options = {}) {
    this.client = options.client ?? new WikiTeamClient(config);
    this.stateDirectory = join(config.configPath ? dirname(resolve(config.configPath)) : join(homedir(), ".config", "legalwork"), "wiki-sync");
  }
  async team(): Promise<WikiTeamOverview> { return this.client.overview(); }
  async sharing(id: string): Promise<WikiTeamRecord | null> {
    const wiki = await this.store.get(id);
    if (!wiki.sync || !("kind" in wiki.sync)) return null;
    return this.client.cached(wiki.sync);
  }
  private intentPath(id: string) { return join(this.stateDirectory, `share-${id}.md`); }
  async pendingSharing(id: string): Promise<WikiSharingInput | null> {
    try { return intentSchema.parse(parseFrontmatter(await readFile(this.intentPath(id), "utf8")).data).input ?? null; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw new ApiError(500, "wiki_share_state_invalid", "The pending wiki sharing state could not be read."); }
  }
  async share(id: string, input: WikiSharingInput): Promise<WikiTeamRecord> {
    const previous = this.sharingPending.get(id);
    if (previous) return previous;
    const run = this.performShare(id, input).catch((error: unknown) => {
      this.statuses.set(id, { ...this.status(id), state: "error", error: error instanceof Error ? error.message : "Wiki sharing failed. Local files are retained." });
      throw error;
    });
    this.sharingPending.set(id, run);
    try { return await run; } finally { if (this.sharingPending.get(id) === run) this.sharingPending.delete(id); }
  }
  private async performShare(id: string, input: WikiSharingInput): Promise<WikiTeamRecord> {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    const wiki = await this.store.get(id);
    if (wiki.sync && "kind" in wiki.sync) throw new ApiError(409, "wiki_already_shared", "Stop the existing sharing before sharing this wiki again.");
    const overview = await this.team();
    let intent: z.infer<typeof intentSchema>;
    try { intent = intentSchema.parse(parseFrontmatter(await readFile(this.intentPath(id), "utf8")).data); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new ApiError(500, "wiki_share_state_invalid", "The pending wiki sharing state could not be read. No files were shared.");
      intent = { orgId: overview.orgId, wikiId: randomUUID(), input };
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      const temporary = `${this.intentPath(id)}.${randomUUID()}.tmp`;
      await writeFile(temporary, buildFrontmatter(intent) + "\n# Pending wiki sharing\n", { mode: 0o600 });
      await rename(temporary, this.intentPath(id));
    }
    if (intent.orgId !== overview.orgId) throw new ApiError(403, "wiki_team_wrong_firm", "A sharing request for this wiki is pending with a different firm.");
    const binding: WikiTeamSyncSettings = { kind: "team", wikiId: intent.wikiId, orgId: intent.orgId };
    let record = await this.client.create(intent.wikiId, wiki.name, intent.input ?? input, intent.orgId);
    if (record.access !== input.access || [...record.memberIds].sort().join("\n") !== [...input.memberIds].sort().join("\n")) record = await this.client.update(binding, input);
    await this.store.update(id, { sync: binding });
    await rm(this.intentPath(id), { force: true });
    this.changed(id);
    return record;
  }
  async updateSharing(id: string, input: WikiSharingInput): Promise<WikiTeamRecord> {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    return this.client.update(teamBinding(await this.store.get(id)), input);
  }
  async rename(id: string, name: string): Promise<void> {
    const wiki = await this.store.get(id);
    if (wiki.sync && "kind" in wiki.sync) await this.client.rename(wiki.sync, name);
  }
  async stopSharing(id: string): Promise<void> {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    await this.sharingPending.get(id);
    const wiki = await this.store.get(id);
    if (!wiki.sync) return;
    await this.pending.get(id);
    if ("kind" in wiki.sync) await this.client.remove(wiki.sync);
    await this.store.update(id, { sync: null });
    await rm(this.intentPath(id), { force: true });
    this.statuses.set(id, localStatus());
  }
  async join(input: { wikiId: string; root?: string }): Promise<WikiRegistration> {
    const previous = this.joiningPending.get(input.wikiId);
    if (previous) return previous;
    const run = this.performJoin(input);
    this.joiningPending.set(input.wikiId, run);
    try { return await run; } finally { if (this.joiningPending.get(input.wikiId) === run) this.joiningPending.delete(input.wikiId); }
  }
  private async performJoin(input: { wikiId: string; root?: string }): Promise<WikiRegistration> {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    const overview = await this.team();
    const binding: WikiTeamSyncSettings = { kind: "team", wikiId: input.wikiId, orgId: overview.orgId };
    const record = await this.client.record(binding);
    const existing = (await this.store.list()).find(wiki => wiki.sync && "kind" in wiki.sync && wiki.sync.orgId === binding.orgId && wiki.sync.wikiId === binding.wikiId);
    if (existing) return existing;
    const wiki = await this.store.create({ name: record.name, root: input.root, attach: true, sync: binding });
    this.changed(wiki.id);
    return wiki;
  }
  status(id: string): WikiSyncStatus { return this.statuses.get(id) ?? localStatus(); }
  start() {
    const tick = async () => {
      if (this.stopped) return;
      try {
        for (const wiki of await this.store.list()) {
          if (this.stopped) return;
          if (wiki.sync) void this.sync(wiki.id);
        }
      } catch { /* A damaged registry is reported by the wiki API, not a timer. */ }
    };
    this.timer = setInterval(() => void tick(), this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
    void tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    await Promise.allSettled(this.pending.values());
    await Promise.allSettled(this.sharingPending.values());
    await Promise.allSettled(this.joiningPending.values());
  }
  changed(id: string) {
    if (this.stopped) return;
    this.dirty.add(id);
    const previous = this.scheduled.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => { this.scheduled.delete(id); void this.sync(id); }, 350);
    timer.unref?.();
    this.scheduled.set(id, timer);
  }
  async ensureWritable(wiki: WikiRegistration, allowOffline = false) {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    if (!wiki.sync) return;
    if (!("kind" in wiki.sync) && allowOffline) return;
    const binding = teamBinding(wiki);
    try { await this.client.record(binding); }
    catch (error) {
      if (allowOffline && error instanceof ApiError && error.code !== "wiki_team_sign_in" && (error.status >= 500 || error.status === 401) && await this.client.ownerOffline(binding)) return;
      throw error;
    }
  }
  async ensureReadable(wiki: WikiRegistration, allowOffline = false) {
    if (!wiki.sync) return;
    if (!("kind" in wiki.sync) && allowOffline) return;
    const binding = teamBinding(wiki);
    try { await this.client.record(binding, false); }
    catch (error) {
      if (allowOffline && error instanceof ApiError && error.code !== "wiki_team_sign_in" && (error.status >= 500 || error.status === 401) && await this.client.ownerOffline(binding)) return;
      throw error;
    }
  }
  async sync(id: string, fresh = false): Promise<WikiSyncStatus> {
    if (fresh) this.dirty.add(id);
    const existing = this.pending.get(id);
    if (existing) return existing;
    const run = (async () => {
      let result: WikiSyncStatus;
      do {
        this.dirty.delete(id);
        result = await this.perform(id);
      } while (!this.stopped && this.dirty.has(id));
      return result;
    })().catch((error: unknown) => {
      const previous = this.status(id);
      const next: WikiSyncStatus = { ...previous, state: "error", error: error instanceof Error ? error.message : "Wiki sync failed. Local files are retained." };
      this.statuses.set(id, next);
      return next;
    });
    this.pending.set(id, run);
    try { return await run; }
    finally { if (this.pending.get(id) === run) this.pending.delete(id); }
  }
  private statePath(id: string) { return join(this.stateDirectory, `${id}.md`); }
  private async unchanged(id: string, binding: string): Promise<WikiRegistration> {
    const wiki = await this.store.get(id);
    if (JSON.stringify(wiki.sync) !== binding) throw new ApiError(409, "wiki_binding_changed", "Wiki sharing changed during sync. Local files are retained.");
    return wiki;
  }
  private async loadBase(id: string, binding: string): Promise<SyncBase> {
    try {
      const parsed = baseSchema.parse(parseFrontmatter(await readFile(this.statePath(id), "utf8")).data);
      return parsed.binding === binding ? parsed : { binding, files: [] };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { binding, files: [] };
      throw new ApiError(500, "wiki_sync_state_invalid", "Wiki sync state could not be read. No files were changed.");
    }
  }
  private async saveBase(id: string, base: SyncBase) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath(id)}.${randomUUID()}.tmp`;
    await writeFile(temp, buildFrontmatter(base) + "\n# Local wiki sync state\n", { mode: 0o600 });
    await rename(temp, this.statePath(id));
  }
  private async perform(id: string): Promise<WikiSyncStatus> {
    const wiki = await this.store.get(id);
    if (!wiki.sync) { const status = localStatus(); this.statuses.set(id, status); return status; }
    const syncSettings = teamBinding(wiki);
    await this.client.record(syncSettings);
    const binding = JSON.stringify(syncSettings);
    const base = await this.loadBase(id, binding);
    this.statuses.set(id, { ...this.status(id), state: "syncing", error: null });
    const metadata = new Map((await this.client.files(syncSettings)).map(file => [file.path, file]));
    const remoteFiles: SyncedFile[] = [...metadata.values()].map(file => ({ path: file.path, hash: file.sha256, size: file.size }));
    const fetched = new Map<string, Buffer>();
    const fetchRemote = async (file: SyncedFile) => {
      const cached = fetched.get(file.path);
      if (cached) return cached;
      const info = metadata.get(file.path);
      if (!info) throw new ApiError(409, "wiki_remote_changed", "A shared wiki file changed during sync.");
      const data = await this.client.read(syncSettings, info);
      if (data.byteLength !== file.size || hash(data) !== file.hash) throw new ApiError(502, "wiki_object_invalid", `The shared revision of ${file.path} could not be verified.`);
      fetched.set(file.path, data);
      return data;
    };
      const locals = new Map<string, { file: SyncedFile }>();
      for (const file of await this.store.files(id)) {
        if (/\.md$/i.test(file.path) && file.size > MERGEABLE_TEXT_MAX_BYTES) throw new ApiError(413, "wiki_file_too_large", `${file.path} exceeds the 2 MB Markdown page limit. Local files are retained.`);
        const key = `${id}:${file.path}`, cached = this.hashes.get(key);
        const unchanged = file.changedAt !== undefined && cached?.size === file.size && cached.updatedAt === file.updatedAt && cached.changedAt === file.changedAt;
        const sha = unchanged ? cached.hash : hash(await this.store.readAsset(id, file.path));
        this.hashes.set(key, { size: file.size, updatedAt: file.updatedAt, changedAt: file.changedAt, hash: sha });
        locals.set(file.path, { file: { path: file.path, hash: sha, size: file.size } });
      }
      const localData = async (file: SyncedFile) => {
        const data = await this.store.readAsset(id, file.path);
        if (hash(data) !== file.hash) throw new ApiError(409, "wiki_changed_during_sync", `${file.path} changed during sync. Its newer edits will sync on the next round.`);
        return data;
      };
      const agreed = new Map(base.files.map((file) => [file.path, file]));
      const theirs = new Map(remoteFiles.map((file) => [file.path, file]));
      const next = new Map(theirs);
      const uploads = new Map<string, { file: SyncedFile; data?: Buffer; source?: SyncedFile }>();
      const placements: Array<{ path: string; file: SyncedFile | null; expected: string; data?: Buffer }> = [];
      const conflicts: string[] = [];
      const keys = new Set([...locals.keys(), ...theirs.keys(), ...agreed.keys()]);
      for (const path of keys) {
        const mine = locals.get(path);
        const their = theirs.get(path);
        const previous = agreed.get(path);
        const mineHash = mine?.file.hash ?? null;
        const theirHash = their?.hash ?? null;
        const baseHash = previous?.hash ?? null;
        if (mineHash === theirHash) continue;
        if (mineHash === baseHash) { placements.push({ path, file: their ?? null, expected: mineHash ?? "" }); continue; }
        if (theirHash === baseHash) {
          if (mine) { next.set(path, mine.file); uploads.set(path, mine); }
          else next.delete(path);
          continue;
        }
        if (mine && their && previous?.text !== undefined && mergeableText(path) && mine.file.size <= MERGEABLE_TEXT_MAX_BYTES && their.size <= MERGEABLE_TEXT_MAX_BYTES) {
          const merged = mergeText(previous.text, (await localData(mine.file)).toString("utf8"), (await fetchRemote(their)).toString("utf8"));
          if (merged !== null) {
            const data = Buffer.from(merged);
            const file = { path, hash: hash(data), size: data.byteLength };
            next.set(path, file); uploads.set(path, { file, data });
            placements.push({ path, file, data, expected: mine.file.hash });
            continue;
          }
        }
        // Preserve both conflicting edits as ordinary files. The remote keeps
        // its name; this computer's differing version gets a stable copy name.
        conflicts.push(path);
        if (mine && their) {
          const extension = path.match(/\.[^/.]+$/)?.[0] ?? "";
          const copy = `${path.slice(0, path.length - extension.length)}.conflict-${mine.file.hash.slice(0, 12)}${extension}`;
          const file = { ...mine.file, path: copy };
          const data = await localData(mine.file);
          next.set(copy, file); uploads.set(copy, { file, data });
          placements.push({ path: copy, file, data, expected: locals.get(copy)?.file.hash ?? "" });
          placements.push({ path, file: their, expected: mine.file.hash });
        } else if (their) placements.push({ path, file: their, expected: "" });
        else if (mine) { next.set(path, mine.file); uploads.set(path, mine); }
      }
      if (next.size > 50_000) throw new ApiError(413, "wiki_too_many_files", "A shared wiki supports up to 50,000 files. Split this collection into another wiki.");
      for (const upload of uploads.values()) {
        const { file } = upload;
        if (theirs.get(file.path)?.hash === file.hash) continue;
        const data = upload.data ?? await localData(upload.source ?? file);
        await this.ensureWritable(await this.unchanged(id, binding));
        await this.client.write(syncSettings, file.path, data, theirs.get(file.path)?.hash ?? null);
      }
      for (const file of theirs.values()) if (!next.has(file.path)) {
        await this.ensureWritable(await this.unchanged(id, binding));
        await this.client.delete(syncSettings, file.path, file.hash);
      }
      await this.client.record(syncSettings);
      const stale = new Set<string>();
      // Place downloads only after successful file updates. Each local write
      // names its base, so a save made during the transfer survives for retry.
      const queue = placements.values();
      let failed = false;
      const placeDownloads = async () => {
        for (const placement of queue) {
          if (failed) return;
          try {
            const data = placement.file ? placement.data ?? await fetchRemote(placement.file) : null;
            await this.unchanged(id, binding);
            if (data) await this.store.writeAsset(id, placement.path, data, placement.expected);
            else if (placement.expected) await this.store.remove(id, placement.path, placement.expected);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 409) || error.code === "wiki_binding_changed") {
              failed = true;
              throw error;
            }
            stale.add(placement.path);
          }
          if (placement.file && !mergeableText(placement.path)) fetched.delete(placement.path);
        }
      };
      // Drain in-flight work before reporting failure so a retry cannot race
      // downloads from the previous round. Stop starting new work on failure.
      const results = await Promise.allSettled(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, placements.length) }, placeDownloads));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      const saved: SyncBase = { binding, files: [] };
      for (const file of next.values()) {
        if (stale.has(file.path)) {
          const previous = agreed.get(file.path);
          if (previous) saved.files.push(previous);
          continue;
        }
        let content = uploads.get(file.path)?.data ?? fetched.get(file.path);
        const previous = agreed.get(file.path);
        if (!content && previous?.hash === file.hash && previous.text !== undefined) content = Buffer.from(previous.text);
        if (!content && mergeableText(file.path) && file.size <= MERGEABLE_TEXT_MAX_BYTES) {
          const local = locals.get(file.path);
          if (local?.file.hash === file.hash) content = await this.store.readAsset(id, file.path);
        }
        const text = content && hash(content) === file.hash && mergeableText(file.path) && content.byteLength <= MERGEABLE_TEXT_MAX_BYTES ? content.toString("utf8") : undefined;
        saved.files.push({ ...file, ...(text !== undefined ? { text } : {}) });
      }
      // Keep deleted bases if a newer local save prevented a remote deletion.
      for (const path of stale) if (!next.has(path) && agreed.has(path)) saved.files.push(agreed.get(path)!);
      await this.unchanged(id, binding);
      await this.saveBase(id, saved);
      const conflictCopies = [...next.keys()].filter((path) => /\.conflict-[a-f0-9]{12}(?:\.|$)/.test(path));
      const result: WikiSyncStatus = { state: "idle", lastSyncedAt: Date.now(), error: null, conflicts: [...new Set([...conflicts, ...conflictCopies])] };
    this.statuses.set(id, result);
    return result;
  }
}
