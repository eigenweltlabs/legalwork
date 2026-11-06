import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { WikiTeamRecord } from "@legalwork/types/wiki";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import type { ServerConfig } from "../types.js";
import { WIKI_CHUNK_BYTES } from "./team-client.js";

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
type Remote = { orgId: string; deleted: boolean; record: WikiTeamRecord; files: Map<string, { data: Buffer; contentType: string; updatedByUserId: string; updatedAt: string }> };
type Blob = { size: number; chunks: Map<number, Buffer>; confirmed: Set<number> };
type Control = { failure: number; capability: boolean; unknownCreate: boolean; unknownDelete: boolean; corruptDownload: boolean; malformedFiles: boolean; repeatedCursor: boolean; beforeCommit: ((wikiId: string, path: string) => Promise<void>) | null; beforeDownload: (() => Promise<void>) | null };
const createSchema = z.object({ id: z.string().uuid(), name: z.string(), access: z.enum(["org", "members"]), memberIds: z.array(z.string()) });
const patchSchema = z.object({ name: z.string().optional(), access: z.enum(["org", "members"]).optional(), memberIds: z.array(z.string()).optional() });
const commitSchema = z.object({ path: z.string(), sha256: z.string(), size: z.number(), contentType: z.string(), ifMatch: z.string().nullable() });

/** HTTP fixture follows the independent wiki registry and signed chunk contract. */
export async function wikiTeamFixture() {
  const root = await mkdtemp(join(tmpdir(), "wiki-team-"));
  const previousPlatform = process.env.EIGENWELT_PLATFORM_URL;
  const previousRuntime = process.env.LEGALWORK_RUNTIME_DB;
  delete process.env.LEGALWORK_RUNTIME_DB;
  const wikis = new Map<string, Remote>(), blobs = new Map<string, Blob>();
  const identities = new Map<string, { userId: string; orgId: string }>();
  const revoked = new Set<string>();
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  const control: Control = { failure: 0, capability: true, unknownCreate: false, unknownDelete: false, corruptDownload: false, malformedFiles: false, repeatedCursor: false, beforeCommit: null, beforeDownload: null };
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    requests.push({ method: request.method, path, authorization: request.headers.get("authorization") });
    const signed = path.match(/^\/signed\/([^/]+)\/([a-f0-9]+)\/(\d+)$/);
    if (signed) {
      const [, id, hash, rawIndex] = signed;
      const blob = blobs.get(`${id}:${hash}`), index = Number(rawIndex);
      if (!blob) return json({ code: "missing" }, 404);
      if (request.method === "PUT") { blob.chunks.set(index, Buffer.from(await request.arrayBuffer())); return new Response(null, { status: 200 }); }
      await control.beforeDownload?.();
      const bytes = blob.chunks.get(index);
      return bytes ? new Response(new Uint8Array(control.corruptDownload ? Buffer.from("tampered") : bytes)) : json({}, 404);
    }
    if (control.failure) return json({ code: "offline" }, control.failure);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const identity = token ? identities.get(token) : undefined;
    if (!identity) return json({ code: "unauthorized" }, 401);
    // Desktop hosts discover projects independently of wiki sharing.
    if (path === "/api/projects" && request.method === "GET") {
      return json({ projects: [], nextCursor: null, hidden: [] });
    }
    if (path === "/api/intake/members") {
      const members = new Map([...identities.values()].filter(item => item.orgId === identity.orgId).map(item => [item.userId, item]));
      return json({ members: [...members.values()].map(item => ({ ...item, name: item.userId, email: `${item.userId}@example.test`, role: "member" })) });
    }
    if (path === "/api/wikis") {
      if (request.method === "GET") return json({ wikis: [...wikis.values()].filter(item => !item.deleted && item.orgId === identity.orgId && !revoked.has(identity.userId) && (item.record.ownerUserId === identity.userId || item.record.access === "org" || item.record.memberIds.includes(identity.userId))).map(item => ({ ...item.record, role: item.record.ownerUserId === identity.userId ? "owner" : "member" })), nextCursor: control.repeatedCursor ? "repeated" : null, hidden: [], capabilities: control.capability ? { wikiSharing: 1 } : {} });
      if (request.method === "POST") {
        const input = createSchema.parse(await request.json());
        const previous = wikis.get(input.id);
        if (previous?.deleted || (previous && (previous.orgId !== identity.orgId || previous.record.ownerUserId !== identity.userId))) return json({}, 409);
        const record: WikiTeamRecord = previous?.record ?? { ...input, ownerUserId: identity.userId, role: "owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        wikis.set(input.id, previous ?? { orgId: identity.orgId, deleted: false, record, files: new Map() });
        if (control.unknownCreate) { control.unknownCreate = false; return json({}, 503); }
        return json({ wiki: record });
      }
    }
    const route = path.match(/^\/api\/wikis\/([^/]+)(.*)$/);
    if (!route) return json({}, 404);
    const id = route[1] ?? "", suffix = route[2] ?? "", wiki = wikis.get(id);
    if (!suffix && request.method === "DELETE" && wiki?.deleted && wiki.orgId === identity.orgId && wiki.record.ownerUserId === identity.userId) return new Response(null, { status: 204 });
    if (!wiki || wiki.deleted || wiki.orgId !== identity.orgId || revoked.has(identity.userId) || (wiki.record.ownerUserId !== identity.userId && wiki.record.access !== "org" && !wiki.record.memberIds.includes(identity.userId))) return json({}, 404);
    const record: WikiTeamRecord = { ...wiki.record, role: wiki.record.ownerUserId === identity.userId ? "owner" : "member" };
    if (!suffix) {
      if (request.method === "GET") return json({ wiki: record });
      if (request.method === "DELETE") { if (record.role !== "owner") return json({}, 403); wiki.deleted = true; if (control.unknownDelete) { control.unknownDelete = false; return json({}, 503); } return new Response(null, { status: 204 }); }
      if (request.method === "PATCH") {
        const patch = patchSchema.parse(await request.json());
        if ((patch.access || patch.memberIds) && record.role !== "owner") return json({}, 403);
        wiki.record = { ...wiki.record, ...patch, updatedAt: new Date().toISOString() };
        return json({ wiki: { ...wiki.record, role: record.role }, applied: Object.keys(patch) });
      }
    }
    const metadata = (filePath: string, file: { data: Buffer; contentType: string; updatedByUserId: string; updatedAt: string }) => ({ path: filePath, sha256: digest(file.data), size: file.data.byteLength, contentType: file.contentType, updatedByUserId: file.updatedByUserId, updatedAt: file.updatedAt });
    if (suffix === "/files") {
      if (request.method === "GET") return json({ files: control.malformedFiles ? [{ path: "../escape.md", size: 1 }] : [...wiki.files].map(([name, file]) => metadata(name, file)), nextCursor: null, seq: wiki.files.size });
      if (request.method === "DELETE") {
        const name = url.searchParams.get("path") ?? "", file = wiki.files.get(name);
        if (!file || digest(file.data) !== url.searchParams.get("ifMatch")) return json({ reason: "changed" }, 409);
        wiki.files.delete(name); return new Response(null, { status: 204 });
      }
      if (request.method === "POST") {
        const input = commitSchema.parse(await request.json());
        await control.beforeCommit?.(id, input.path);
        const current = wiki.files.get(input.path);
        if ((current ? digest(current.data) : null) !== input.ifMatch) return json({ reason: "changed" }, 409);
        const blob = blobs.get(`${id}:${input.sha256}`);
        const count = Math.ceil(input.size / WIKI_CHUNK_BYTES);
        if (!blob || blob.size !== input.size || blob.confirmed.size !== count) return json({ reason: "incomplete" }, 409);
        const data = Buffer.concat([...blob.chunks.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes));
        const file = { data, contentType: input.contentType, updatedByUserId: identity.userId, updatedAt: new Date().toISOString() };
        wiki.files.set(input.path, file); return json({ file: metadata(input.path, file) });
      }
    }
    if (suffix === "/files/content") {
      const name = url.searchParams.get("path") ?? "", file = wiki.files.get(name);
      if (!file) return json({}, 404);
      const sha256 = digest(file.data), count = Math.ceil(file.data.byteLength / WIKI_CHUNK_BYTES);
      return json({ sha256, size: file.data.byteLength, chunks: Array.from({ length: count }, (_, index) => `${server.url.origin}/signed/${id}/${sha256}/${index}`) });
    }
    const blobRoute = suffix.match(/^\/blobs\/([a-f0-9]+)(?:\/(\d+))?$/);
    if (blobRoute && request.method === "POST") {
      const sha256 = blobRoute[1] ?? "", input = z.object({ size: z.number() }).parse(await request.json()), key = `${id}:${sha256}`;
      let blob = blobs.get(key);
      if (!blob) { blob = { size: input.size, chunks: new Map(), confirmed: new Set() }; blobs.set(key, blob); }
      if (blobRoute[2] !== undefined) { const index = Number(blobRoute[2]); if (!blob.chunks.has(index)) return json({}, 409); blob.confirmed.add(index); return json({ ok: true }); }
      const uploads = Array.from({ length: Math.ceil(input.size / WIKI_CHUNK_BYTES) }, (_, index) => index).filter(index => !blob.confirmed.has(index)).slice(0, 4).map(index => ({ index, url: `${server.url.origin}/signed/${id}/${sha256}/${index}` }));
      return json({ uploads });
    }
    return json({}, 404);
  } });
  process.env.EIGENWELT_PLATFORM_URL = server.url.origin;
  let copyIndex = 0;
  async function account(userId = "owner", orgId = "firm") {
    const directory = join(root, `computer-${++copyIndex}`);
    const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(directory, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    const token = `token-${copyIndex}`;
    identities.set(token, { userId, orgId });
    await writeEigenweltConnection(config, { account: { userId, userName: userId, userEmail: `${userId}@example.test`, orgId, orgName: orgId }, platformToken: token, platformURL: server.url.origin });
    return { directory, config, token, userId, orgId };
  }
  return { root, wikis, blobs, identities, revoked, requests, control, account, origin: server.url.origin,
    async close() { server.stop(true); if (previousPlatform === undefined) delete process.env.EIGENWELT_PLATFORM_URL; else process.env.EIGENWELT_PLATFORM_URL = previousPlatform; if (previousRuntime === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousRuntime; await rm(root, { recursive: true, force: true }); },
  };
}
