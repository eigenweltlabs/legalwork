import { createHash } from "node:crypto";
import { z } from "zod";
import type { WikiSharingInput, WikiTeamOverview, WikiTeamRecord, WikiTeamSyncSettings } from "@legalwork/types/wiki";
import { eigenweltConnectionPlatformUrl } from "../eigenwelt-endpoints.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { isWikiPath, WIKI_MAX_ASSET_BYTES, WIKI_MAX_PAGE_BYTES } from "./store.js";

export const WIKI_CHUNK_BYTES = 8 * 1024 * 1024;
const LEASE_MS = 30_000;
const recordSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(200), ownerUserId: z.string().min(1),
  role: z.enum(["owner", "member"]), access: z.enum(["org", "members"]), memberIds: z.array(z.string().min(1)).max(1000),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
const pageSchema = z.object({ wikis: z.array(recordSchema).max(200), nextCursor: z.string().nullable(), hidden: z.array(z.string()).optional(), capabilities: z.object({ wikiSharing: z.literal(1) }) });
const memberSchema = z.object({ userId: z.string().min(1), name: z.string().nullable(), email: z.string().nullable(), role: z.string() });
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sizeSchema = z.number().int().min(0).max(WIKI_MAX_ASSET_BYTES);
const fileSchema = z.object({ path: z.string().refine(isWikiPath), sha256: hashSchema, size: sizeSchema, contentType: z.string(), updatedByUserId: z.string(), updatedAt: z.string().datetime() }).refine(file => !/\.md$/i.test(file.path) || file.size <= WIKI_MAX_PAGE_BYTES);
export type WikiTeamFile = z.infer<typeof fileSchema>;
type Identity = { platformURL: string; orgId: string; userId: string; orgName: string | null; token: string };
type Lease = { identity: Identity; record: WikiTeamRecord; at: number };
const base = (id: string) => `/api/wikis/${encodeURIComponent(z.string().uuid().parse(id))}`;
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(502, "wiki_team_bad_response", "The wiki sharing service returned an invalid response. Local files are retained.");
  return result.data;
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Account-scoped registry and per-file CAS. Tokens never go to signed storage URLs. */
export class WikiTeamClient {
  private leases = new Map<string, Lease>();
  constructor(private config: ServerConfig) {}
  private async identity(orgId?: string): Promise<Identity> {
    await ensureFreshPlatformToken(this.config);
    const connection = await readEigenweltConnection(this.config);
    const account = connection.account;
    const token = connection.platformToken;
    if (!token || !account) { this.leases.clear(); throw new ApiError(401, "wiki_team_sign_in", "Sign in with your firm to share or open team wikis."); }
    if (orgId !== undefined && account.orgId !== orgId) throw new ApiError(403, "wiki_team_wrong_firm", "This wiki belongs to a different firm. Sign in with that firm to sync it.");
    return { platformURL: eigenweltConnectionPlatformUrl(connection), token, orgId: account.orgId, userId: account.userId, orgName: account.orgName };
  }
  private async request(method: string, path: string, body?: unknown, orgId?: string): Promise<unknown> {
    const identity = await this.identity(orgId);
    let response: Response;
    try {
      response = await fetch(`${identity.platformURL}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${identity.token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new ApiError(503, "wiki_team_unavailable", "Team wiki sharing is unavailable. Local files are retained."); }
    // A sign-out or firm switch during a transfer must not authorize its result.
    const current = await readEigenweltConnection(this.config);
    if (!current.account || !current.platformToken) { this.leases.clear(); throw new ApiError(401, "wiki_team_sign_in", "Sign in with your firm to open this wiki."); }
    if (current.account.orgId !== identity.orgId || current.account.userId !== identity.userId || eigenweltConnectionPlatformUrl(current) !== identity.platformURL) throw new ApiError(403, "wiki_team_identity_changed", "Your signed-in firm changed during wiki sync. Local files are retained.");
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      const failure = z.object({ reason: z.string().optional(), details: z.object({ reason: z.string().optional() }).optional() }).safeParse(details);
      if (response.status === 403 || response.status === 404) this.leases.clear();
      throw new ApiError(response.status, response.status === 409 ? "wiki_team_conflict" : "wiki_team_unavailable",
        response.status === 403 || response.status === 404 ? "You no longer have access to this team wiki." : response.status === 409 ? "This team wiki changed. Refresh before trying again." : "Team wiki sharing is unavailable. Local files are retained.",
        failure.success ? { reason: failure.data.reason ?? failure.data.details?.reason } : undefined);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new ApiError(502, "wiki_team_bad_response", "The wiki sharing service returned an invalid response."); }
  }
  async overview(): Promise<WikiTeamOverview> {
    const identity = await this.identity();
    const items: WikiTeamRecord[] = [], cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      let json: unknown;
      try { json = await this.request("GET", `/api/wikis${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, identity.orgId); }
      catch (error) {
        if (error instanceof ApiError && error.status === 404) throw new ApiError(409, "wiki_server_update_required", "The firm's server needs an update before wikis can be shared. Local files are retained.");
        throw error;
      }
      if (!z.object({ capabilities: z.object({ wikiSharing: z.literal(1) }) }).safeParse(json).success) throw new ApiError(409, "wiki_server_update_required", "The firm's server needs an update before wikis can be shared. Local files are retained.");
      const page: z.infer<typeof pageSchema> = parsed(pageSchema, json);
      items.push(...page.wikis);
      if (items.length > 10_000 || (page.nextCursor !== null && cursors.has(page.nextCursor))) throw new ApiError(502, "wiki_team_bad_response", "The wiki sharing service repeated or exceeded its wiki list.");
      cursor = page.nextCursor;
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    if (new Set(items.map(item => item.id)).size !== items.length) throw new ApiError(502, "wiki_team_bad_response", "The wiki sharing service returned duplicate wikis.");
    const json = await this.request("GET", "/api/intake/members", undefined, identity.orgId);
    const members = parsed(z.union([z.array(memberSchema).max(10_000), z.object({ members: z.array(memberSchema).max(10_000) }).transform(value => value.members)]), json);
    return { orgId: identity.orgId, userId: identity.userId, orgName: identity.orgName, items, members };
  }
  async cached(binding: WikiTeamSyncSettings): Promise<WikiTeamRecord | null> {
    const identity = await this.identity(binding.orgId), lease = this.leases.get(binding.wikiId);
    return lease && lease.identity.platformURL === identity.platformURL && lease.identity.orgId === identity.orgId && lease.identity.userId === identity.userId && lease.identity.token === identity.token && Date.now() - lease.at < LEASE_MS ? lease.record : null;
  }
  async ownerOffline(binding: WikiTeamSyncSettings): Promise<boolean> {
    // Sign-out, another firm, and a revoked membership are never offline access.
    const identity = await this.identity(binding.orgId), lease = this.leases.get(binding.wikiId);
    return Boolean(lease && lease.record.role === "owner" && lease.identity.platformURL === identity.platformURL && lease.identity.orgId === identity.orgId && lease.identity.userId === identity.userId);
  }
  async record(binding: WikiTeamSyncSettings, fresh = true): Promise<WikiTeamRecord> {
    if (!fresh) { const cached = await this.cached(binding); if (cached) return cached; }
    const identity = await this.identity(binding.orgId);
    const record = parsed(z.object({ wiki: recordSchema }), await this.request("GET", base(binding.wikiId), undefined, binding.orgId)).wiki;
    if (record.id !== binding.wikiId || (record.role === "owner") !== (record.ownerUserId === identity.userId)) throw new ApiError(502, "wiki_team_bad_response", "The wiki sharing service returned inconsistent ownership.");
    this.leases.set(binding.wikiId, { identity, record, at: Date.now() });
    return record;
  }
  async create(id: string, name: string, input: WikiSharingInput, orgId: string): Promise<WikiTeamRecord> {
    const record = parsed(z.object({ wiki: recordSchema }), await this.request("POST", "/api/wikis", { id, name, ...input }, orgId)).wiki;
    const identity = await this.identity(orgId);
    if (record.id !== id || record.role !== "owner" || record.ownerUserId !== identity.userId) throw new ApiError(502, "wiki_team_bad_response", "The wiki sharing service returned inconsistent ownership.");
    this.leases.set(id, { identity, record, at: Date.now() });
    return record;
  }
  async update(binding: WikiTeamSyncSettings, input: WikiSharingInput): Promise<WikiTeamRecord> {
    const record = await this.record(binding);
    if (record.role !== "owner") throw new ApiError(403, "wiki_team_owner_required", "Only the wiki owner can change sharing.");
    const result = parsed(z.object({ wiki: recordSchema.nullable(), applied: z.array(z.string()) }), await this.request("PATCH", base(binding.wikiId), { ...input, changedAt: new Date().toISOString() }, binding.orgId));
    if (!result.wiki || result.wiki.id !== binding.wikiId) throw new ApiError(409, "wiki_team_conflict", "Wiki sharing changed. Refresh and try again.");
    this.leases.delete(binding.wikiId);
    return this.record(binding);
  }
  async remove(binding: WikiTeamSyncSettings): Promise<void> {
    // The endpoint enforces ownership, including an already deleted record.
    // A preceding GET would make a successful-but-unconfirmed delete unretryable.
    await this.request("DELETE", base(binding.wikiId), undefined, binding.orgId);
    this.leases.delete(binding.wikiId);
  }
  async rename(binding: WikiTeamSyncSettings, name: string): Promise<void> {
    await this.record(binding);
    const result = parsed(z.object({ wiki: recordSchema.nullable(), applied: z.array(z.string()) }), await this.request("PATCH", base(binding.wikiId), { name, changedAt: new Date().toISOString() }, binding.orgId));
    if (!result.wiki || result.wiki.id !== binding.wikiId || result.wiki.name !== name) throw new ApiError(409, "wiki_team_conflict", "This wiki changed. Refresh before renaming it.");
    this.leases.delete(binding.wikiId);
  }
  async files(binding: WikiTeamSyncSettings): Promise<WikiTeamFile[]> {
    const files: WikiTeamFile[] = [], cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const schema = z.object({ files: z.array(fileSchema).max(1000), nextCursor: z.string().nullable(), seq: z.number().int().optional() });
      const page: z.infer<typeof schema> = parsed(schema, await this.request("GET", `${base(binding.wikiId)}/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, binding.orgId));
      files.push(...page.files);
      if (files.length > 50_000 || (page.nextCursor !== null && cursors.has(page.nextCursor))) throw new ApiError(502, "wiki_team_bad_response", "The shared wiki file list repeated or exceeded its limit.");
      cursor = page.nextCursor;
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new ApiError(502, "wiki_team_bad_response", "The shared wiki contains duplicate file paths.");
    return files;
  }
  private async storage(url: string, init: RequestInit): Promise<Response> {
    let target: URL;
    try { target = new URL(url); } catch { throw new ApiError(502, "wiki_team_bad_response", "A wiki storage link was invalid."); }
    if (target.username || target.password || (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)))) throw new ApiError(502, "wiki_team_bad_response", "A wiki storage link was invalid.");
    let response: Response;
    try { response = await fetch(target, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
    catch { throw new ApiError(503, "wiki_storage_unavailable", "The firm's wiki file storage is unavailable."); }
    if (!response.ok) throw new ApiError(502, "wiki_storage_failed", "The firm's wiki file storage could not transfer this file.");
    return response;
  }
  async read(binding: WikiTeamSyncSettings, file: WikiTeamFile): Promise<Buffer> {
    const content = parsed(z.object({ sha256: hashSchema, size: sizeSchema, chunks: z.array(z.string()).max(13) }), await this.request("GET", `${base(binding.wikiId)}/files/content?path=${encodeURIComponent(file.path)}`, undefined, binding.orgId));
    if (content.sha256 !== file.sha256 || content.size !== file.size || content.chunks.length !== Math.ceil(file.size / WIKI_CHUNK_BYTES)) throw new ApiError(409, "wiki_remote_changed", "This file changed while downloading. Sync will retry.");
    const buffers: Buffer[] = [];
    let size = 0;
    for (const url of content.chunks) {
      const response = await this.storage(url, { method: "GET" });
      if (!response.body) throw new ApiError(502, "wiki_storage_failed", "A wiki file chunk arrived without content.");
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > file.size) throw new ApiError(502, "wiki_object_invalid", "A wiki file exceeded its declared size.");
          buffers.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel().catch(() => undefined); }
    }
    const data = Buffer.concat(buffers);
    if (size !== file.size || digest(data) !== file.sha256) throw new ApiError(502, "wiki_object_invalid", "A shared wiki file could not be verified.");
    await this.record(binding); // Re-check permission before placing downloaded bytes locally.
    return data;
  }
  async write(binding: WikiTeamSyncSettings, path: string, data: Buffer, ifMatch: string | null): Promise<WikiTeamFile> {
    if (!isWikiPath(path) || data.byteLength > WIKI_MAX_ASSET_BYTES || (/\.md$/i.test(path) && data.byteLength > WIKI_MAX_PAGE_BYTES)) throw new ApiError(413, "wiki_file_too_large", "This wiki file is invalid or exceeds its size limit.");
    const sha256 = digest(data), size = data.byteLength;
    const contentType = /\.md$/i.test(path) ? "text/markdown;charset=utf-8" : "application/octet-stream";
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.record(binding);
      try {
        const file = parsed(z.object({ file: fileSchema }), await this.request("POST", `${base(binding.wikiId)}/files`, { path, sha256, size, contentType, ifMatch }, binding.orgId)).file;
        if (file.path !== path || file.sha256 !== sha256 || file.size !== size) throw new ApiError(502, "wiki_team_bad_response", "The wiki service returned a different file revision.");
        return file;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || attempt > 0 || !z.object({ reason: z.literal("incomplete") }).safeParse(error.details).success) throw error;
        for (let round = 0; ; round++) {
          const { uploads } = parsed(z.object({ uploads: z.array(z.object({ index: z.number().int().min(0).max(12), url: z.string() })).max(4) }), await this.request("POST", `${base(binding.wikiId)}/blobs/${sha256}`, { size }, binding.orgId));
          if (!uploads.length) break;
          if (round > Math.ceil(size / WIKI_CHUNK_BYTES) || new Set(uploads.map(item => item.index)).size !== uploads.length) throw new ApiError(502, "wiki_team_bad_response", "The wiki service kept requesting the same chunks.");
          for (const { index, url } of uploads) {
            const bytes = new Uint8Array(data.subarray(index * WIKI_CHUNK_BYTES, Math.min((index + 1) * WIKI_CHUNK_BYTES, size)));
            if (!bytes.byteLength) throw new ApiError(502, "wiki_team_bad_response", "The wiki service requested an invalid chunk.");
            await this.storage(url, { method: "PUT", body: bytes });
            await this.request("POST", `${base(binding.wikiId)}/blobs/${sha256}/${index}`, { size }, binding.orgId);
          }
        }
      }
    }
    throw new ApiError(409, "wiki_team_conflict", "The wiki file changed while uploading.");
  }
  async delete(binding: WikiTeamSyncSettings, path: string, ifMatch: string): Promise<void> {
    await this.record(binding);
    await this.request("DELETE", `${base(binding.wikiId)}/files?path=${encodeURIComponent(path)}&ifMatch=${encodeURIComponent(ifMatch)}`, undefined, binding.orgId);
  }
}
