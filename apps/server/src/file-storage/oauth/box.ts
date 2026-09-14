import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { StorageEntry } from "@legalwork/types/file-storage";
import { ApiError } from "../../errors.js";
import { checkCondition, collectStream, receiveFile, storagePath, type StorageAdapter, type WriteCondition } from "../common.js";
import { authorizedFetch, checkResponse, chunks, jsonResponse, sourceSize } from "./http.js";
import type { AccessToken, OAuthConfig, OAuthProvider } from "./providers.js";

const api = "https://api.box.com/2.0/";
const uploadApi = "https://upload.box.com/api/2.0/";
const fields = "id,type,name,size,etag,modified_at,path_collection";
const ancestor = z.object({ id: z.string(), name: z.string() });
const item = z.object({ id: z.string().regex(/^\d+$/), type: z.string(), name: z.string(), size: z.number().default(0), etag: z.string().nullable().optional(), modified_at: z.string().nullable().optional(), path_collection: z.object({ entries: z.array(ancestor) }).optional() });
type BoxItem = z.infer<typeof item>;
const page = z.object({ entries: z.array(item), next_marker: z.string().nullable().optional(), total_count: z.number().optional(), offset: z.number().optional(), limit: z.number().optional() });
const invalid = () => new ApiError(502, "storage_invalid_response", "Box returned an unexpected response.");
const missing = () => new ApiError(404, "storage_not_found", "This file or folder is no longer available.");
const fileInfo = (file: BoxItem) => ({ size: file.size, version: file.etag ?? "", contentType: "application/octet-stream" });
function entry(file: BoxItem, path: string): StorageEntry {
  return { path: storagePath(path, false), name: file.name, kind: file.type === "folder" ? "folder" : "file", size: file.size, modifiedAt: file.modified_at ?? null };
}
function rootId(value: string) {
  if (!value) return "0";
  if (/^\d+$/.test(value)) return value;
  try {
    const url = new URL(value);
    const match = /^\/folder\/(\d+)\/?$/.exec(url.pathname);
    if (url.protocol === "https:" && (url.hostname === "app.box.com" || url.hostname.endsWith(".app.box.com")) && !url.username && !url.password && match) return match[1]!;
  } catch { /* Show the same actionable error for all invalid folder links. */ }
  throw new ApiError(400, "invalid_storage_root", "Paste a Box folder link or folder ID.");
}

export async function boxAdapter(config: OAuthConfig, token: AccessToken): Promise<StorageAdapter> {
  const get = async (path: string, params: Record<string, string> = {}) => {
    const url = new URL(path, api);
    url.search = new URLSearchParams({ fields, ...params }).toString();
    return authorizedFetch(token, url);
  };
  const root = await jsonResponse(await get(`folders/${rootId(config.root)}`), item);
  if (root.type !== "folder") throw new ApiError(400, "invalid_storage_root", "Choose a Box folder.");
  const children = async (id: string, cursor?: string) => {
    const result = await jsonResponse(await get(`folders/${id}/items`, { usemarker: "true", limit: "100", ...(cursor ? { marker: cursor } : {}) }), page);
    return { values: result.entries.filter((value) => ["file", "folder"].includes(value.type)), nextCursor: result.next_marker ?? undefined };
  };
  // Resolve names against Box on every operation so moves and permission changes
  // cannot turn stale cached IDs into access outside the selected folder.
  const resolve = async (path: string) => {
    let current = root;
    for (const name of storagePath(path).split("/").filter(Boolean)) {
      if (current.type !== "folder") throw missing();
      let cursor: string | undefined;
      let found: BoxItem | undefined;
      const seen = new Set<string>();
      do {
        const result = await children(current.id, cursor);
        found = result.values.find((value) => value.name === name);
        if (found) break;
        cursor = result.nextCursor;
        if (cursor && seen.has(cursor)) throw invalid();
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (!found) throw missing();
      current = found;
    }
    return current;
  };
  const existing = async (path: string) => {
    try { return await resolve(path); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  };
  const download = async (path: string) => {
    const file = await resolve(path);
    if (file.type !== "file") throw new ApiError(415, "storage_unsupported_file", "Choose a file to open.");
    let response = await fetch(new URL(`files/${file.id}/content`, api), { headers: { Authorization: `Bearer ${await token()}` }, redirect: "manual", signal: AbortSignal.timeout(120_000) });
    for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects >= 5) throw invalid();
      const url = new URL(location);
      if (url.protocol !== "https:" || url.username || url.password || !(url.hostname.endsWith(".boxcloud.com") || url.hostname.endsWith(".box.com"))) throw invalid();
      // Box's signed download links authorize the transfer; never forward OAuth tokens.
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30 * 60_000) });
    }
    await checkResponse(response);
    if (response.status === 202 || !response.body) { await response.body?.cancel(); throw new ApiError(409, "storage_file_preparing", "Box is preparing this file. Please try again shortly."); }
    return { file, body: response.body, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  };
  const upload = async (path: string, source: Buffer | string, type: string, condition: WriteCondition) => {
    const parts = storagePath(path, false).split("/");
    const name = parts.pop()!;
    const parent = await resolve(parts.join("/"));
    if (parent.type !== "folder") throw missing();
    const current = await existing(path);
    checkCondition(current ? fileInfo(current) : null, condition);
    if (current && current.type !== "file") throw new ApiError(409, "storage_conflict", "A folder already uses this name.");
    const size = await sourceSize(source);
    const headers: Record<string, string> = condition.version ? { "If-Match": condition.version } : {};
    if (size < 20 * 1024 * 1024) {
      const buffers: ArrayBuffer[] = [];
      for await (const bytes of chunks(source)) buffers.push(Uint8Array.from(bytes).buffer);
      const form = new FormData();
      form.set("attributes", JSON.stringify({ name, parent: { id: parent.id } }));
      form.set("file", new Blob(buffers, { type }), name);
      await (await authorizedFetch(token, new URL(current ? `files/${current.id}/content` : "files/content", uploadApi), { method: "POST", headers, body: form })).body?.cancel();
      return;
    }
    const session = await jsonResponse(await authorizedFetch(token, new URL(current ? `files/${current.id}/upload_sessions` : "files/upload_sessions", uploadApi), { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ file_size: size, file_name: name, folder_id: parent.id }) }), z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), part_size: z.number().int().min(1).max(64 * 1024 * 1024) }));
    const resource = new URL(`files/upload_sessions/${session.id}`, uploadApi);
    const digest = createHash("sha1");
    const uploaded: { part_id: string; offset: number; size: number; sha1: string }[] = [];
    let offset = 0;
    try {
      for await (const bytes of chunks(source, session.part_size)) {
        digest.update(bytes);
        const partDigest = createHash("sha1").update(bytes).digest("base64");
        const result = await jsonResponse(await authorizedFetch(token, resource, { method: "PUT", headers: { Digest: `sha=${partDigest}`, "Content-Type": "application/octet-stream", "Content-Range": `bytes ${offset}-${offset + bytes.length - 1}/${size}` }, body: Uint8Array.from(bytes) }), z.object({ part: z.object({ part_id: z.string(), offset: z.number(), size: z.number(), sha1: z.string() }) }));
        if (result.part.offset !== offset || result.part.size !== bytes.length || result.part.sha1 !== createHash("sha1").update(bytes).digest("hex")) throw invalid();
        uploaded.push(result.part);
        offset += bytes.length;
      }
      if (offset !== size) throw invalid();
      const digestHeader = `sha=${digest.digest("base64")}`;
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await authorizedFetch(token, `${resource}/commit`, { method: "POST", headers: { ...headers, Digest: digestHeader, "Content-Type": "application/json" }, body: JSON.stringify({ parts: uploaded }) });
        const retry = Number(response.headers.get("retry-after") ?? 1);
        await response.body?.cancel();
        if (response.status === 201) return;
        if (response.status !== 202) throw invalid();
        await delay(Math.min(10, Math.max(1, Number.isFinite(retry) ? retry : 1)) * 1000);
      }
      throw new ApiError(502, "storage_incomplete_upload", "Box has not finished this upload. Please try again.");
    } catch (error) {
      await authorizedFetch(token, resource, { method: "DELETE" }).then((response) => response.body?.cancel()).catch(() => undefined);
      throw error;
    }
  };
  return {
    async list(path, cursor) {
      const folder = await resolve(path);
      if (folder.type !== "folder") throw missing();
      const result = await children(folder.id, cursor);
      return { entries: result.values.map((file) => entry(file, [path, file.name].filter(Boolean).join("/"))), nextCursor: result.nextCursor };
    },
    searchCapabilities: async () => ({ modes: ["name", "content"], pagination: true, scope: "subtree" }),
    async search(input) {
      if (input.mode === "path_prefix") throw new ApiError(400, "storage_search_unsupported", "Use filename or content search for Box.");
      const folder = await resolve(input.path);
      if (folder.type !== "folder") throw missing();
      if (input.cursor && !/^\d{1,5}$/.test(input.cursor)) throw invalid();
      const offset = Number(input.cursor ?? 0);
      if (offset > 9999) throw invalid();
      const result = await jsonResponse(await get("search", { query: input.query, ancestor_folder_ids: folder.id, content_types: input.mode === "name" ? "name" : "name,file_content", type: "file", limit: "100", offset: String(offset) }), page);
      const entries: StorageEntry[] = [];
      for (const file of result.entries) {
        const ancestors = file.path_collection?.entries ?? [];
        const index = ancestors.findIndex((value) => value.id === folder.id);
        // Check Box's returned ancestry too; never trust a search filter alone.
        if (index < 0 || file.type !== "file") continue;
        const relative = [...ancestors.slice(index + 1).map((value) => value.name), file.name].join("/");
        entries.push(entry(file, [input.path, relative].filter(Boolean).join("/")));
      }
      const next = offset + (result.limit ?? 100);
      const more = next < (result.total_count ?? 0);
      return { entries, nextCursor: more && next < 10000 ? String(next) : undefined, truncated: more && next >= 10000, scope: "subtree", path: input.path };
    },
    async stat(path) { const file = await existing(path); return file ? fileInfo(file) : null; },
    async read(path) { const { file, body, contentType } = await download(path); return { ...fileInfo(file), contentType, data: await collectStream(body) }; },
    async download(path, destination) { const { file, body, contentType } = await download(path); return { ...fileInfo(file), contentType, ...await receiveFile(body, destination) }; },
    write: upload, upload,
    async mkdir(path) {
      const parts = storagePath(path, false).split("/"); const name = parts.pop()!;
      const parent = await resolve(parts.join("/"));
      if (parent.type !== "folder") throw missing();
      await (await authorizedFetch(token, new URL("folders", api), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, parent: { id: parent.id } }) })).body?.cancel();
    },
  };
}

const broker = process.env.LEGALWORK_STORAGE_BOX_OAUTH_URL ?? "https://platform.eigenweltlabs.com/api/storage-oauth/box/";
export const boxProvider: OAuthProvider = {
  id: "box", name: "Box", rootHint: "Leave empty for all files, or paste a Box folder link.",
  clientId: process.env.LEGALWORK_STORAGE_BOX_CLIENT_ID ?? "tyhmry12o9qcqaeubaueuypyxiu859iv",
  authorizeUrl: new URL("authorize", broker).href, tokenUrl: new URL("token", broker).href,
  scopes: (readOnly) => [readOnly ? "root_readonly" : "root_readwrite"], adapter: boxAdapter,
};
