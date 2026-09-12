import { googleDesktopClientId, googleDesktopClientSecret } from "./google-client.js";
import { z } from "zod";
import type { StorageEntry, StorageSearch } from "@legalwork/types/file-storage";
import { ApiError } from "../../errors.js";
import { checkCondition, collectStream, conflict, receiveFile, storagePath, type StorageAdapter, type WriteCondition } from "../common.js";
import { authorizedFetch, checkResponse, chunks, jsonResponse, sourceSize } from "./http.js";
import type { OAuthConfig, AccessToken, OAuthProvider } from "./providers.js";

const api = "https://www.googleapis.com/drive/v3/";
const folderType = "application/vnd.google-apps.folder";
const file = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), parents: z.array(z.string()).default([]), size: z.coerce.number().default(0), modifiedTime: z.string().optional(), version: z.string().default(""), headRevisionId: z.string().optional(), trashed: z.boolean().default(false), capabilities: z.object({ canEdit: z.boolean().optional(), canDownload: z.boolean().optional() }).optional() });
const fields = "id,name,mimeType,parents,size,modifiedTime,version,headRevisionId,trashed,capabilities(canEdit,canDownload)";
const listing = z.object({ files: z.array(file), nextPageToken: z.string().optional(), incompleteSearch: z.boolean().optional() });
type DriveFile = z.infer<typeof file> & { etag?: string };
const exports = new Map([
  ["application/vnd.google-apps.document", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" }],
  ["application/vnd.google-apps.spreadsheet", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx" }],
  ["application/vnd.google-apps.presentation", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: ".pptx" }],
  ["application/vnd.google-apps.drawing", { type: "application/pdf", extension: ".pdf" }],
]);
const quote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const displayName = (item: DriveFile) => item.name + (exports.get(item.mimeType)?.extension ?? "");
// Stable IDs disambiguate duplicate names; preserve the visible filename and its extension.
const segment = (item: DriveFile) => `${item.id}~${encodeURIComponent(displayName(item)).replace(/~/g, "%7E")}`;
export function googleDriveRoot(value: string) {
  if (!value) return "root";
  if (/^[\w-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    const match = /^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)$/.exec(url.pathname);
    if (url.protocol === "https:" && url.hostname === "drive.google.com" && match) return match[1];
  } catch { /* Display a single configuration error below. */ }
  throw new ApiError(400, "invalid_storage_root", "Paste a Google Drive folder link or folder ID.");
}
export async function googleDriveAdapter(config: OAuthConfig, token: AccessToken): Promise<StorageAdapter> {
  const url = (resource: string, params: Record<string, string> = {}) => { const value = new URL(resource, api); value.search = new URLSearchParams({ supportsAllDrives: "true", ...params }).toString(); return value; };
  const get = async (id: string): Promise<DriveFile> => {
    const response = await authorizedFetch(token, url(`files/${encodeURIComponent(id)}`, { fields }));
    const etag = response.headers.get("etag") ?? undefined;
    const item = await jsonResponse(response, file);
    if (item.trashed) throw new ApiError(404, "storage_not_found", "This file is in the trash.");
    return { ...item, etag };
  };
  const root = await get(googleDriveRoot(config.root));
  if (root.mimeType !== folderType) throw new ApiError(400, "invalid_storage_root", "Choose a Google Drive folder.");
  const query = async (q: string, cursor?: string) => jsonResponse(await authorizedFetch(token, url("files", {
    q: `trashed = false and (${q})`, spaces: "drive", fields: `files(${fields}),nextPageToken,incompleteSearch`, pageSize: "100", includeItemsFromAllDrives: "true", ...(cursor ? { pageToken: cursor } : {}),
  })), listing);
  const resolve = async (path: string): Promise<DriveFile> => {
    storagePath(path);
    let parent = root;
    for (const part of path ? path.split("/") : []) {
      if (parent.mimeType !== folderType) throw new ApiError(404, "storage_not_found", "The parent folder is unavailable.");
      const id = /^([\w-]+)~/.exec(part)?.[1];
      if (id) {
        const item = await get(id);
        if (!item.parents.includes(parent.id)) throw new ApiError(404, "storage_not_found", "This file is outside the selected folder or has moved.");
        parent = item;
      } else {
        const result = await query(`${quote(parent.id)} in parents and name = ${quote(part)}`);
        if (!result.files.length) throw new ApiError(404, "storage_not_found", "The file or folder is no longer available.");
        if (result.files.length !== 1 || result.nextPageToken) throw new ApiError(409, "storage_ambiguous_name", "Several files have this name. Choose the file from the folder listing.");
        parent = await get(result.files[0].id);
      }
    }
    return parent;
  };
  const info = (item: DriveFile) => ({ name: displayName(item).replace(/[\/\\\x00-\x1f\x7f]/g, "_"), size: item.size, version: item.headRevisionId ?? item.version, contentType: exports.get(item.mimeType)?.type ?? item.mimeType, writable: !exports.has(item.mimeType) && item.capabilities?.canEdit !== false });
  const toEntry = (item: DriveFile, parent: string): StorageEntry => ({ path: `${parent ? `${parent}/` : ""}${segment(item)}`, name: displayName(item), kind: item.mimeType === folderType ? "folder" : "file", size: item.size, modifiedAt: item.modifiedTime ?? null });
  const parentPath = async (item: DriveFile, ancestor: DriveFile, prefix: string) => {
    let current = item; const parts: string[] = []; const seen = new Set<string>();
    while (current.id !== ancestor.id) {
      if (seen.has(current.id) || seen.size >= 100 || !current.parents.length) return null;
      seen.add(current.id); parts.unshift(segment(current));
      try { current = await get(current.parents[0]); }
      catch (error) { if (error instanceof ApiError && [403, 404].includes(error.status)) return null; throw error; }
    }
    return [prefix, ...parts].filter(Boolean).join("/");
  };
  const read = async (path: string) => {
    const item = await resolve(path);
    if (item.capabilities?.canDownload === false) throw new ApiError(403, "storage_access_denied", "The owner has disabled downloads for this file.");
    const format = exports.get(item.mimeType);
    if (item.mimeType.startsWith("application/vnd.google-apps.") && !format)
      throw new ApiError(415, "storage_unsupported_file", "Open this Google Drive item in its original app.");
    const response = await authorizedFetch(token, url(`files/${encodeURIComponent(item.id)}${format ? "/export" : item.headRevisionId ? `/revisions/${encodeURIComponent(item.headRevisionId)}` : ""}`, format ? { mimeType: format.type } : { alt: "media" }), { signal: AbortSignal.timeout(30 * 60_000), ...(item.etag && !format ? { headers: { "If-Match": item.etag } } : {}) });
    if (!response.body) throw new ApiError(502, "storage_invalid_response", "The download was empty.");
    return { item, body: response.body };
  };
  const upload = async (path: string, source: Buffer | string, type: string, condition: WriteCondition) => {
    storagePath(path, false);
    const parent = await resolve(path.split("/").slice(0, -1).join("/"));
    let current: DriveFile | null = null;
    try { current = await resolve(path); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    checkCondition(current ? info(current) : null, condition);
    if (current && !info(current).writable) throw new ApiError(403, "storage_read_only", "Save Google document exports locally or upload them as a new file.");
    const total = await sourceSize(source);
    const start = new URL(`https://www.googleapis.com/upload/drive/v3/files${current ? `/${encodeURIComponent(current.id)}` : ""}`);
    start.search = new URLSearchParams({ uploadType: "resumable", supportsAllDrives: "true" }).toString();
    const response = await authorizedFetch(token, start, {
      method: current ? "PATCH" : "POST", headers: { "Content-Type": "application/json", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(total), ...(current?.etag ? { "If-Match": current.etag } : {}) },
      body: JSON.stringify(current ? {} : { name: path.split("/").at(-1), parents: [parent.id] }),
    });
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location) throw new ApiError(502, "storage_invalid_response", "The upload could not be started.");
    const uploadUrl = new URL(location);
    if (uploadUrl.origin !== "https://www.googleapis.com" || !uploadUrl.pathname.startsWith("/upload/drive/")) throw new ApiError(502, "storage_invalid_response", "The upload address was invalid.");
    let offset = 0;
    const send = async (bytes: Buffer) => {
      // Drive does not consistently enforce If-Match on resumable sessions.
      // Recheck the content revision before committing; preserve its native revision history.
      if (current && condition.version && offset + bytes.length === total)
        checkCondition(info(await get(current.id)), condition);
      const result = await fetch(uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": type, "Content-Range": total ? `bytes ${offset}-${offset + bytes.length - 1}/${total}` : "bytes */0" }, body: new Uint8Array(bytes), redirect: "manual", signal: AbortSignal.timeout(120_000) });
      offset += bytes.length;
      if (result.status === 308 && offset < total) { await result.body?.cancel(); return; }
      await (await checkResponse(result)).body?.cancel();
    };
    if (!total) await send(Buffer.alloc(0));
    else for await (const bytes of chunks(source)) await send(bytes);
  };
  const search = async (input: StorageSearch) => {
    const ancestor = await resolve(input.path);
    if (input.mode === "path_prefix") throw new ApiError(400, "storage_search_unsupported", "Use filename or content search for Google Drive.");
    const result = await query(`${input.mode === "name" ? "name" : "fullText"} contains ${quote(input.query)}`, input.cursor);
    const entries: StorageEntry[] = [];
    for (const item of result.files) {
      const path = await parentPath(item, ancestor, input.path);
      if (path) entries.push({ ...toEntry(item, ""), path });
    }
    return { entries, ...(result.nextPageToken ? { nextCursor: result.nextPageToken } : {}), truncated: result.incompleteSearch, scope: "subtree" as const, path: input.path };
  };
  return {
    async list(path, cursor) { const parent = await resolve(path); const result = await query(`${quote(parent.id)} in parents`, cursor); return { entries: result.files.map((item) => toEntry(item, path)), ...(result.nextPageToken ? { nextCursor: result.nextPageToken } : {}) }; },
    searchCapabilities: async () => ({ modes: ["name", "content"], pagination: true, scope: "subtree" }), search,
    async stat(path) { try { return info(await resolve(path)); } catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; } },
    async read(path) { const { item, body } = await read(path); return { ...info(item), data: await collectStream(body) }; },
    async download(path, destination) { const { item, body } = await read(path); return { ...info(item), ...await receiveFile(body, destination) }; },
    write: upload, upload,
    async mkdir(path) {
      storagePath(path, false);
      try { await resolve(path); conflict(); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      const parent = await resolve(path.split("/").slice(0, -1).join("/"));
      await (await authorizedFetch(token, url("files"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: path.split("/").at(-1), mimeType: folderType, parents: [parent.id] }) })).body?.cancel();
    },
  };
}
export const googleDriveProvider: OAuthProvider = {
  id: "google-drive", name: "Google Drive", rootHint: "Paste a Google Drive folder link. Leave empty for My Drive.",
  clientId: process.env.LEGALWORK_STORAGE_GOOGLE_CLIENT_ID ?? googleDesktopClientId,
  clientSecret: process.env.LEGALWORK_STORAGE_GOOGLE_CLIENT_SECRET ?? (process.env.LEGALWORK_STORAGE_GOOGLE_CLIENT_ID ? undefined : googleDesktopClientSecret),
  clientSecretRequired: true,
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
  authorizeParams: { access_type: "offline", prompt: "consent" },
  scopes: (readOnly) => [`https://www.googleapis.com/auth/${readOnly ? "drive.readonly" : "drive"}`], adapter: googleDriveAdapter,
};
