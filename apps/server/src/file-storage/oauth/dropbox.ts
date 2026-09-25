import { z } from "zod";
import type { StorageEntry, StorageSearch } from "@legalwork/types/file-storage";
import { ApiError } from "../../errors.js";
import { collectStream, receiveFile, storagePath, type StorageAdapter, type WriteCondition } from "../common.js";
import { checkResponse, chunks, jsonResponse, sourceSize } from "./http.js";
import type { OAuthConfig, AccessToken, OAuthProvider } from "./providers.js";

const metadata = z.object({
  ".tag": z.enum(["file", "folder", "deleted"]).default("file"), name: z.string(), path_display: z.string().optional(), path_lower: z.string().optional(),
  size: z.number().optional(), rev: z.string().optional(), server_modified: z.string().optional(),
});
const listing = z.object({ entries: z.array(metadata), cursor: z.string(), has_more: z.boolean() });
const searchPage = z.object({ matches: z.array(z.object({ metadata: z.object({ metadata }) })), cursor: z.string().optional(), has_more: z.boolean() });
const account = z.object({ root_info: z.object({ root_namespace_id: z.string() }) });
const api = "https://api.dropboxapi.com/2/";
const content = "https://content.dropboxapi.com/2/";
function argument(value: unknown) { return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`); }

export async function dropboxAdapter(config: OAuthConfig, token: AccessToken): Promise<StorageAdapter> {
  const root = config.root.replace(/^\/+|\/+$/g, "");
  storagePath(root);
  const base = root ? `/${root}` : "";
  const auth = () => token().then((value) => ({ Authorization: `Bearer ${value}` }));
  const user = await jsonResponse(await fetch(`${api}users/get_current_account`, {
    method: "POST", headers: await auth(), redirect: "error", signal: AbortSignal.timeout(30_000),
  }), account);
  const headers = async () => ({ ...await auth(), "Dropbox-API-Path-Root": argument({ ".tag": "root", root: user.root_info.root_namespace_id }) });
  const path = (value: string) => { storagePath(value); return base + (value ? `/${value}` : ""); };
  const rpc = async (method: string, input: unknown) => {
    const response = await fetch(`${api}${method}`, { method: "POST", headers: { ...await headers(), "Content-Type": "application/json" }, body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (response.status === 409) {
      const error = z.object({ error_summary: z.string() }).safeParse(await response.clone().json());
      if (error.success && /(?:path|path_lookup)\/not_found/.test(error.data.error_summary)) {
        await response.body?.cancel(); throw new ApiError(404, "storage_not_found", "This file or folder is no longer available.");
      }
    }
    return checkResponse(response);
  };
  const toEntry = (item: z.infer<typeof metadata>): StorageEntry | undefined => {
    const full = item.path_display ?? item.path_lower;
    if (!full || item[".tag"] === "deleted") return;
    // Dropbox paths are case-insensitive. Never return search matches outside the configured root.
    if (base && !full.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return;
    const relative = full.slice(base.length + 1);
    return { path: storagePath(relative, false), name: item.name, kind: item[".tag"] === "folder" ? "folder" : "file", size: item.size ?? null, modifiedAt: item.server_modified ?? null };
  };
  const entries = (items: z.infer<typeof metadata>[]) => items.flatMap((item) => { const entry = toEntry(item); return entry ? [entry] : []; });
  const info = (item: z.infer<typeof metadata>) => ({ size: item.size ?? 0, version: item.rev ?? "", contentType: "application/octet-stream" });
  const download = async (value: string) => {
    const response = await checkResponse(await fetch(`${content}files/download`, { method: "POST", headers: { ...await headers(), "Dropbox-API-Arg": argument({ path: path(value) }) }, redirect: "error", signal: AbortSignal.timeout(30 * 60_000) }));
    const file = metadata.parse(JSON.parse(response.headers.get("Dropbox-API-Result") ?? "{}"));
    if (!response.body) throw new ApiError(502, "storage_invalid_response", "The download was empty.");
    return { response, file };
  };
  const upload = async (value: string, source: Buffer | string, condition: WriteCondition) => {
    const commit = { path: path(value), mode: condition.version ? { ".tag": "update", update: condition.version } : { ".tag": condition.createOnly ? "add" : "overwrite" }, autorename: false, strict_conflict: true, mute: true };
    const send = async (method: string, args: unknown, bytes: Buffer) => checkResponse(await fetch(`${content}files/${method}`, {
      method: "POST", headers: { ...await headers(), "Content-Type": "application/octet-stream", "Dropbox-API-Arg": argument(args) }, body: new Uint8Array(bytes), redirect: "error", signal: AbortSignal.timeout(120_000),
    }));
    const size = await sourceSize(source);
    if (!size) { await (await send("upload", commit, Buffer.alloc(0))).body?.cancel(); return; }
    const session = await jsonResponse(await send("upload_session/start", { close: false }, Buffer.alloc(0)), z.object({ session_id: z.string() }));
    let offset = 0;
    for await (const bytes of chunks(source)) {
      const cursor = { session_id: session.session_id, offset };
      const final = offset + bytes.length === size;
      await (await send(final ? "upload_session/finish" : "upload_session/append_v2", final ? { cursor, commit } : { cursor, close: false }, bytes)).body?.cancel();
      offset += bytes.length;
    }
  };
  const search = async (input: StorageSearch) => {
    if (input.mode === "path_prefix") throw new ApiError(400, "storage_search_unsupported", "Use filename or content search for Dropbox.");
    const result = await jsonResponse(await rpc(input.cursor ? "files/search/continue_v2" : "files/search_v2", input.cursor ? { cursor: input.cursor } : {
      query: input.query, options: { path: path(input.path), filename_only: input.mode === "name", max_results: 100, file_status: "active" },
    }), searchPage);
    return { entries: entries(result.matches.map((match) => match.metadata.metadata)), ...(result.has_more && result.cursor ? { nextCursor: result.cursor } : {}), scope: "subtree" as const, path: input.path };
  };
  return {
    async list(value, cursor) {
      const result = await jsonResponse(await rpc(cursor ? "files/list_folder/continue" : "files/list_folder", cursor ? { cursor } : { path: path(value), limit: 100, include_deleted: false }), listing);
      return { entries: entries(result.entries), ...(result.has_more ? { nextCursor: result.cursor } : {}) };
    },
    searchCapabilities: async () => ({ modes: ["name", "content"], pagination: true, scope: "subtree" }), search,
    async stat(value) {
      try { return info(await jsonResponse(await rpc("files/get_metadata", { path: path(value) }), metadata)); }
      catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
    },
    async read(value) {
      const { response, file } = await download(value);
      return { ...info(file), data: await collectStream(response.body!) };
    },
    async download(value, destination) {
      const { response, file } = await download(value);
      return { ...info(file), ...await receiveFile(response.body!, destination) };
    },
    write: (value, source, _type, condition) => upload(value, source, condition),
    upload: (value, source, _type, condition) => upload(value, source, condition),
    async mkdir(value) { await (await rpc("files/create_folder_v2", { path: path(value), autorename: false })).body?.cancel(); },
  };
}
export const dropboxProvider: OAuthProvider = {
  id: "dropbox", name: "Dropbox", rootHint: "Folder path, for example /Matters. Leave empty for your Dropbox.",
  clientId: process.env.LEGALWORK_STORAGE_DROPBOX_CLIENT_ID ?? "rk0s21ffqpizdbg", port: 53687,
  authorizeUrl: "https://www.dropbox.com/oauth2/authorize", tokenUrl: "https://api.dropboxapi.com/oauth2/token",
  authorizeParams: { token_access_type: "offline" },
  scopes: (readOnly) => ["account_info.read", "files.metadata.read", "files.content.read", ...readOnly ? [] : ["files.content.write"]],
  adapter: dropboxAdapter,
};
