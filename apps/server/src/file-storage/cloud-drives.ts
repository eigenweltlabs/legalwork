import { openAsBlob } from "node:fs";
import { z } from "zod";
import type { StorageConfig } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import type { StreamingConnectorRequest } from "../connectors/request.js";
import { nativePagePath, parseNative } from "../connectors/native.js";
import { checkResponse, chunks, sourceSize } from "./oauth/http.js";
import { nativeDriveAdapter, type DriveItem } from "./native-drive.js";
import { conflict, type StorageAdapter } from "./common.js";
import { googleDriveTree, googleFolder, googleExports } from "./google-drive-tree.js";

export const cloudStorageProviders = ["google-drive", "onedrive", "onedrive-personal", "sharepoint-files"];
export function isCloudStorage(config: StorageConfig): config is Extract<StorageConfig, { kind: "oauth" }> {
  return config.kind === "oauth" && cloudStorageProviders.includes(config.provider);
}
function sessionPath(location: string | null) {
  if (!location) throw new ApiError(502, "storage_invalid_response", "The provider did not create an upload session.");
  const url = new URL(location);
  if (url.origin !== "https://www.googleapis.com" || !url.pathname.startsWith("/upload/drive/v3/files") || url.username || url.password || url.hash) throw new ApiError(502, "storage_invalid_response", "Invalid Google upload session.");
  return `${url.pathname}${url.search}`;
}
export async function googleStorageAdapter(config: Extract<StorageConfig, { kind: "oauth" }>, request: StreamingConnectorRequest): Promise<StorageAdapter> {
  if (config.root.startsWith("https://drive.google.com/")) {
    const link = new URL(config.root);
    const id = /\/folders\/([^/]+)/.exec(link.pathname)?.[1];
    if (!id) throw new ApiError(400, "invalid_storage_root", "Choose a Google Drive folder link or ID.");
    config = { ...config, root: decodeURIComponent(id) };
  }
  const tree = await googleDriveTree(config, request);
  const adapter = nativeDriveAdapter({ ...tree,
    async download(item) {
      if (item.exported && !Object.values(googleExports).some((format) => format.type === item.contentType)) throw new ApiError(415, "storage_export_unsupported", "This Google file cannot be exported to a supported editor format. Open its provider link.");
      const file = await tree.get(item.id);
      const target = file.targetId ?? file.id;
      const key = file.targetResourceKey ?? file.resourceKey;
      const path = `/drive/v3/files/${encodeURIComponent(target)}`;
      return request.response(item.exported ? `${path}/export?${new URLSearchParams({ mimeType: item.contentType })}` : `${path}?alt=media&supportsAllDrives=true`, { bytes: true, ...(key ? { headers: { "X-Goog-Drive-Resource-Keys": `${target}/${key}` } } : {}) });
    },
    async upload(parent, name, current, source, type, condition) {
      parent = await tree.writeParent(parent);
      const size = await sourceSize(source);
      const headers = { "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(size), ...(condition.version ? { "If-Match": condition.version } : {}) };
      const path = `/upload/drive/v3/files${current ? `/${encodeURIComponent(current.id)}` : ""}?uploadType=resumable&supportsAllDrives=true&fields=id`;
      const session = await request.response(path, { method: current ? "PATCH" : "POST", headers, body: current ? { mimeType: type } : { name, mimeType: type, parents: [parent.id] } });
      const uploadPath = sessionPath(session.headers.get("location"));
      await session.body?.cancel();
      let offset = 0;
      if (size === 0) {
        const result = await request.response(uploadPath, { method: "PUT", rawBody: new Blob([]), headers: { "Content-Type": type, "Content-Length": "0", ...headers } });
        await result.body?.cancel(); return;
      }
      for await (const bytes of chunks(source)) {
        const end = offset + bytes.length;
        const result = await request.response(uploadPath, { method: "PUT", rawBody: new Blob([Uint8Array.from(bytes)]), incomplete: end < size,
          headers: { "Content-Type": type, "Content-Range": `bytes ${offset}-${end - 1}/${size}`, ...(condition.version ? { "If-Match": condition.version } : {}) } });
        await result.body?.cancel();
        if (end < size && (result.status !== 308 || result.headers.get("range") !== `bytes=0-${end - 1}`)) throw new ApiError(502, "storage_invalid_response", "Google did not acknowledge the uploaded bytes.");
        if (end === size && !result.ok) conflict();
        offset = end;
      }
      if (offset !== size) conflict();
    },
    async mkdir(parent, name) {
      parent = await tree.writeParent(parent);
      await request(`/drive/v3/files?supportsAllDrives=true&fields=id`, { method: "POST", body: { name, mimeType: googleFolder, parents: [parent.id] } });
    },
    async rename(item, parent, name) {
      parent = await tree.writeParent(parent);
      const query = new URLSearchParams({ supportsAllDrives: "true", fields: "id" });
      if (!item.parents.includes(parent.id)) { query.set("addParents", parent.id); query.set("removeParents", item.parents.join(",")); }
      await request(`/drive/v3/files/${encodeURIComponent(item.id)}?${query}`, { method: "PATCH", body: { name }, headers: { "If-Match": item.version } });
    },
    async remove(item, version) {
      await request(`/drive/v3/files/${encodeURIComponent(item.id)}?supportsAllDrives=true`, { method: "PATCH", body: { trashed: true }, headers: { "If-Match": version ?? item.version } });
    },
  });
  return { ...adapter,
    async list(path, cursor) {
      await request.assertRead?.();
      return adapter.list(path, cursor);
    },
    ...(tree.listFilesAtRoot ? { listFilesAtRoot: tree.listFilesAtRoot } : {}),
    async restrictToFolder(reference) {
      if (!reference.id || reference.id.startsWith("legalwork:google:")) return null;
      const folder = await tree.get(reference.id);
      return googleStorageAdapter({ ...config, root: folder.targetId ?? folder.id, driveId: undefined }, request);
    },
  };
}
const graphFile = z.object({ id: z.string(), name: z.string(), size: z.number().default(0), lastModifiedDateTime: z.string().optional(), eTag: z.string().optional(), webUrl: z.string().optional(),
  file: z.object({ mimeType: z.string().optional() }).optional(), folder: z.object({}).optional(),
  parentReference: z.object({ id: z.string().optional(), driveId: z.string().optional() }).optional(), "@microsoft.graph.downloadUrl": z.string().optional(), "@content.downloadUrl": z.string().optional() });
function graphItem(file: z.infer<typeof graphFile>): DriveItem {
  return { id: file.id, name: file.name, folder: Boolean(file.folder), parents: file.parentReference?.id ? [file.parentReference.id] : [], size: file.size,
    version: file.eTag ?? `sha256:${file.lastModifiedDateTime ?? file.id}`, contentType: file.file?.mimeType ?? "application/octet-stream", modifiedAt: file.lastModifiedDateTime, webUrl: file.webUrl };
}
function microsoftContentUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || ![".sharepoint.com", ".files.1drv.com", ".onedrive.com", ".storage.live.com", ".up.1drv.com"].some((suffix) => url.hostname.endsWith(suffix))) throw new ApiError(502, "storage_invalid_response", "Invalid Microsoft transfer URL.");
  return url;
}
export async function microsoftStorageAdapter(config: Extract<StorageConfig, { kind: "oauth" }>, request: StreamingConnectorRequest): Promise<StorageAdapter> {
  const origin = request.apiOrigin ?? "https://graph.microsoft.com";
  const personal = origin === "https://api.onedrive.com";
  if (config.provider === "sharepoint-files" && !config.driveId) throw new ApiError(409, "storage_drive_required", "Choose a SharePoint document library in File Storage settings.");
  const defaultBase = personal ? "/v1.0/drive" : "/v1.0/me/drive";
  const drive = parseNative(z.object({ id: z.string() }), await request(config.driveId ? `/v1.0/drives/${encodeURIComponent(config.driveId)}` : defaultBase));
  const base = `/v1.0/drives/${encodeURIComponent(drive.id)}`;
  const itemPath = (id: string) => `${base}/items/${encodeURIComponent(id)}`;
  const raw = async (id: string) => {
    const value = parseNative(graphFile, await request(itemPath(id)));
    if (value.parentReference?.driveId && value.parentReference.driveId !== drive.id) throw new ApiError(404, "storage_not_found", "This file belongs to another drive.");
    return value;
  };
  const root = config.root ? graphItem(await raw(config.root)) : graphItem(parseNative(graphFile, await request(`${base}/root`)));
  if (!root.folder) throw new ApiError(400, "invalid_storage_root", "Choose a Microsoft folder ID.");
  const get = async (id: string) => graphItem(await raw(id));
  const page = async (path: string, cursor?: string) => {
    const response = parseNative(z.object({ value: z.array(graphFile), "@odata.nextLink": z.string().optional() }), await request(cursor ? nativePagePath(cursor, origin, path) : `${path}?$top=100`));
    if (response["@odata.nextLink"]) nativePagePath(response["@odata.nextLink"], origin, path);
    return { items: response.value.map(graphItem), nextCursor: response["@odata.nextLink"] };
  };
  const behavior = personal ? "@name.conflictBehavior" : "@microsoft.graph.conflictBehavior";
  return nativeDriveAdapter({ root, namespace: `${config.provider}:${config.accountId}:${drive.id}:${root.id}`, get,
    children: (id, cursor) => page(`${itemPath(id)}/children`, cursor), searchScope: "subtree",
    search: (parent, input) => page(`${itemPath(parent.id)}/search(q='${encodeURIComponent(input.query.replace(/'/g, "''"))}')`, input.cursor),
    async download(item) {
      const file = await raw(item.id);
      const location = file["@microsoft.graph.downloadUrl"] ?? file["@content.downloadUrl"];
      if (!file.file || !location) throw new ApiError(415, "storage_download_unavailable", "This Microsoft item has no downloadable file content.");
      // Signed provider URLs authorize content; credentials never leave the Microsoft API origin.
      return checkResponse(await fetch(microsoftContentUrl(location), { redirect: "error", signal: AbortSignal.timeout(30 * 60_000) }));
    },
    async upload(parent, name, current, source, type, condition) {
      const size = await sourceSize(source);
      const path = current ? itemPath(current.id) : `${itemPath(parent.id)}:/${encodeURIComponent(name)}:`;
      const headers: Record<string, string> = condition.version ? { "If-Match": condition.version } : { "If-None-Match": "*" };
      if (size <= 250 * 1024 * 1024) {
        const body = typeof source === "string" ? await openAsBlob(source, { type }) : new Blob([Uint8Array.from(source)], { type });
        await request(`${path}/content?${new URLSearchParams({ [behavior]: "fail" })}`, { method: "PUT", rawBody: body, headers: { ...headers, "Content-Type": type } });
        return;
      }
      if (current) throw new ApiError(413, "storage_conditional_write_unsupported", "Microsoft can safely replace files up to 250 MB. Upload this larger file under a new name.");
      const session = parseNative(z.object({ uploadUrl: z.string() }), await request(`${path}/createUploadSession`, { method: "POST", headers, body: { item: { name, [behavior]: "fail" } } }));
      const uploadUrl = microsoftContentUrl(session.uploadUrl);
      let offset = 0;
      for await (const bytes of chunks(source, 10 * 1024 * 1024)) {
        await request.assertWrite();
        const end = offset + bytes.length;
        const response = await checkResponse(await fetch(uploadUrl, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(120_000),
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length), "Content-Range": `bytes ${offset}-${end - 1}/${size}` }, body: Uint8Array.from(bytes) }));
        await response.body?.cancel();
        if (end < size && response.status !== 202) throw new ApiError(502, "storage_invalid_response", "Microsoft did not acknowledge the upload session.");
        if (end === size && response.status !== 200 && response.status !== 201) conflict();
        offset = end;
      }
      if (offset !== size) conflict();
    },
    async mkdir(parent, name) { await request(`${itemPath(parent.id)}/children`, { method: "POST", body: { name, folder: {}, [behavior]: "fail" } }); },
    async rename(item, parent, name) { await request(itemPath(item.id), { method: "PATCH", body: { name, parentReference: { id: parent.id, driveId: drive.id }, [behavior]: "fail" }, headers: { "If-Match": item.version } }); },
    async remove(item, version) { await request(itemPath(item.id), { method: "DELETE", empty: true, headers: { "If-Match": version ?? item.version } }); },
  });
}
