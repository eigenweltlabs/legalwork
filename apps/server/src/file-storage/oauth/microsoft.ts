import { z } from "zod";
import type { StorageEntry, StorageSearch } from "@legalwork/types/file-storage";
import { ApiError } from "../../errors.js";
import { checkCondition, collectStream, receiveFile, storagePath, type StorageAdapter, type WriteCondition } from "../common.js";
import { authorizedFetch, checkResponse, chunks, jsonResponse, sourceSize } from "./http.js";
import type { OAuthConfig, AccessToken, OAuthProvider } from "./providers.js";

const api = "https://graph.microsoft.com/v1.0/";
const parent = z.object({ driveId: z.string().optional(), id: z.string().optional(), path: z.string().optional() });
const item = z.object({ id: z.string(), name: z.string(), size: z.number().default(0), eTag: z.string().optional(), lastModifiedDateTime: z.string().optional(), folder: z.object({}).optional(), file: z.object({ mimeType: z.string().optional() }).optional(), parentReference: parent.optional(), webUrl: z.string().optional(), "@microsoft.graph.downloadUrl": z.string().optional() });
type DriveItem = z.infer<typeof item>;
const page = z.object({ value: z.array(item), "@odata.nextLink": z.string().optional() });
const drive = z.object({ id: z.string(), webUrl: z.string() });
const encodedPath = (path: string) => storagePath(path).split("/").map(encodeURIComponent).join("/");
function microsoftUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "invalid_storage_root", "Paste a OneDrive folder link or SharePoint site or folder link."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(url.hostname.endsWith(".sharepoint.com") || ["1drv.ms", "onedrive.live.com"].includes(url.hostname)))
    throw new ApiError(400, "invalid_storage_root", "Use an HTTPS OneDrive or SharePoint link.");
  return url;
}
function transferUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !["sharepoint.com", "1drv.com", "onedrive.com", "storage.live.com", "onedrive.live.com", "microsoftpersonalcontent.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))
    throw new ApiError(502, "storage_invalid_response", "The file service returned an invalid transfer address.");
  return url;
}
export async function microsoftAdapter(config: OAuthConfig, token: AccessToken): Promise<StorageAdapter> {
  const get = <T>(resource: string, schema: z.ZodType<T>) => authorizedFetch(token, new URL(resource, api)).then((response) => jsonResponse(response, schema));
  const resolveRoot = async (): Promise<{ root: DriveItem; driveId: string }> => {
    if (!config.root) {
      if (config.provider === "sharepoint") throw new ApiError(400, "invalid_storage_root", "Paste the SharePoint site or folder link in File storage settings.");
      const selectedDrive = await get("me/drive", drive);
      return { root: await get(`drives/${encodeURIComponent(selectedDrive.id)}/root`, item), driveId: selectedDrive.id };
    }
    const link = microsoftUrl(config.root);
    if (link.hostname.endsWith(".sharepoint.com") && !link.pathname.startsWith("/:")) {
      const path = (link.searchParams.get("id") ?? link.searchParams.get("RootFolder") ?? decodeURIComponent(link.pathname)).replace(/\/+$/, "");
      const sitePath = /^\/(?:sites|teams|personal)\/[^/]+/.exec(path)?.[0] ?? "";
      const site = await get(`sites/${encodeURIComponent(link.hostname)}:${sitePath || "/"}`, z.object({ id: z.string() }));
      if (path === sitePath || path === "") {
        const selectedDrive = await get(`sites/${encodeURIComponent(site.id)}/drive`, drive);
        return { root: await get(`drives/${encodeURIComponent(selectedDrive.id)}/root`, item), driveId: selectedDrive.id };
      }
      const librariesUrl = new URL(`sites/${encodeURIComponent(site.id)}/drives`, api);
      let librariesNext: string | undefined = librariesUrl.href;
      const visited = new Set<string>();
      while (librariesNext) {
        const url: URL = new URL(librariesNext);
        if (url.origin !== librariesUrl.origin || url.pathname !== librariesUrl.pathname || visited.has(url.href))
          throw new ApiError(502, "storage_invalid_response", "Invalid document library pagination response.");
        visited.add(url.href);
        const drives: { value: z.infer<typeof drive>[]; "@odata.nextLink"?: string } = await get(url.href, z.object({ value: z.array(drive), "@odata.nextLink": z.string().optional() }));
        librariesNext = drives["@odata.nextLink"];
        for (const selectedDrive of drives.value) {
        const prefix = decodeURIComponent(new URL(selectedDrive.webUrl).pathname).replace(/\/+$/, "");
        if (path.toLowerCase() !== prefix.toLowerCase() && !path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) continue;
        const relative = path.slice(prefix.length).replace(/^\//, "").replace(/(?:^|\/)Forms\/AllItems\.aspx$/i, "").replace(/\/$/, "");
        return { root: await get(`drives/${encodeURIComponent(selectedDrive.id)}/root${relative ? `:/${encodedPath(relative)}` : ""}`, item), driveId: selectedDrive.id };
      }
      }
      throw new ApiError(404, "invalid_storage_root", "This document library is unavailable to your account.");
    }
    const shared = await get(`shares/u!${Buffer.from(link.href).toString("base64url")}/driveItem`, item);
    const driveId = shared.parentReference?.driveId;
    if (!driveId) throw new ApiError(400, "invalid_storage_root", "Choose a OneDrive or SharePoint folder link.");
    return { root: shared, driveId };
  };
  const { root, driveId } = await resolveRoot();
  if (!root.folder) throw new ApiError(400, "invalid_storage_root", "Choose a folder to connect.");
  const drivePath = `drives/${encodeURIComponent(driveId)}`;
  const resource = (path: string) => `${drivePath}/items/${encodeURIComponent(root.id)}${path ? `:/${encodedPath(path)}` : ""}`;
  const getItem = (path: string) => get(resource(path), item);
  const info = (entry: DriveItem) => ({ size: entry.size, version: entry.eTag ?? "", contentType: entry.file?.mimeType ?? "application/octet-stream" });
  const entry = (value: DriveItem, path: string): StorageEntry => ({ path: storagePath(path, false), name: value.name, kind: value.folder ? "folder" : "file", size: value.size, modifiedAt: value.lastModifiedDateTime ?? null });
  const queryPage = async (resource: string, cursor?: string) => {
    const url = new URL(resource, api); url.searchParams.set("$top", "100");
    if (cursor) url.searchParams.set("$skiptoken", cursor);
    const response = await jsonResponse(await authorizedFetch(token, url), page);
    let nextCursor: string | undefined;
    if (response["@odata.nextLink"]) {
      const next = new URL(response["@odata.nextLink"]);
      if (next.origin !== new URL(api).origin || next.pathname !== url.pathname) throw new ApiError(502, "storage_invalid_response", "Invalid folder pagination response.");
      nextCursor = next.searchParams.get("$skiptoken") ?? undefined;
      if (!nextCursor) throw new ApiError(502, "storage_invalid_response", "This folder page could not be continued.");
    }
    return { values: response.value, nextCursor };
  };
  const subtreePath = async (value: DriveItem, ancestor: DriveItem, prefix: string) => {
    let current = value; const parts: string[] = []; const seen = new Set<string>();
    while (current.id !== ancestor.id) {
      if (seen.has(current.id) || seen.size >= 100 || current.parentReference?.driveId !== driveId || !current.parentReference.id) return null;
      seen.add(current.id); parts.unshift(current.name);
      try { current = await get(`${drivePath}/items/${encodeURIComponent(current.parentReference.id)}`, item); }
      catch (error) { if (error instanceof ApiError && [403, 404].includes(error.status)) return null; throw error; }
    }
    return [prefix, ...parts].filter(Boolean).join("/");
  };
  const download = async (path: string) => {
    const file = await getItem(path);
    const link = file["@microsoft.graph.downloadUrl"];
    if (!link || !file.file) throw new ApiError(415, "storage_unsupported_file", "This item must be opened in its original Microsoft app.");
    const response = await checkResponse(await fetch(transferUrl(link), { redirect: "error", signal: AbortSignal.timeout(30 * 60_000) }));
    if (!response.body) throw new ApiError(502, "storage_invalid_response", "The download was empty.");
    return { file, body: response.body };
  };
  const upload = async (path: string, source: Buffer | string, type: string, condition: WriteCondition) => {
    storagePath(path, false);
    const parentPath = path.split("/").slice(0, -1).join("/");
    const name = path.split("/").at(-1)!;
    let current: DriveItem | null = null;
    try { current = await getItem(path); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    checkCondition(current ? info(current) : null, condition);
    const total = await sourceSize(source);
    const parent = await getItem(parentPath);
    const target = current ? `${drivePath}/items/${encodeURIComponent(current.id)}` : `${drivePath}/items/${encodeURIComponent(parent.id)}:/${encodeURIComponent(name)}:`;
    const conditional: Record<string, string> = condition.version ? { "If-Match": condition.version } : {};
    if (!total) {
      const targetUrl = new URL(`${target}/content`, api);
      targetUrl.searchParams.set("@microsoft.graph.conflictBehavior", condition.createOnly ? "fail" : "replace");
      await (await authorizedFetch(token, targetUrl, { method: "PUT", headers: { ...conditional, "Content-Type": type }, body: new Uint8Array() })).body?.cancel();
      return;
    }
    const session = await jsonResponse(await authorizedFetch(token, new URL(`${target}/createUploadSession`, api), {
      method: "POST", headers: { ...conditional, "Content-Type": "application/json" },
      // Microsoft requires OData annotations before ordinary properties.
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": condition.createOnly ? "fail" : "replace", name } }),
    }), z.object({ uploadUrl: z.string() }));
    const uploadUrl = transferUrl(session.uploadUrl);
    let offset = 0;
    try {
    for await (const bytes of chunks(source, 10 * 320 * 1024)) {
      const response = await checkResponse(await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length), "Content-Range": `bytes ${offset}-${offset + bytes.length - 1}/${total}` }, body: new Uint8Array(bytes), redirect: "error", signal: AbortSignal.timeout(120_000) }));
      offset += bytes.length;
      if (offset === total && response.status === 202) throw new ApiError(502, "storage_incomplete_upload", "The upload was not committed. Please try again.");
      await response.body?.cancel();
    }
    } catch (error) {
      await fetch(uploadUrl, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(10_000) }).then((response) => response.body?.cancel()).catch(() => undefined);
      throw error;
    }
  };
  const search: NonNullable<StorageAdapter["search"]> = async (input: StorageSearch) => {
    if (input.mode === "path_prefix") throw new ApiError(400, "storage_search_unsupported", "Use filename or content search for Microsoft storage.");
    const ancestor = await getItem(input.path);
    const query = encodeURIComponent(input.query.replace(/'/g, "''"));
    const result = await queryPage(`${drivePath}/items/${encodeURIComponent(ancestor.id)}/search(q='${query}')`, input.cursor);
    const entries: StorageEntry[] = [];
    for (const value of result.values) {
      if (input.mode === "name" && !value.name.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) continue;
      const path = await subtreePath(value, ancestor, input.path);
      if (path) entries.push(entry(value, path));
    }
    return { entries, nextCursor: result.nextCursor, scope: "subtree", path: input.path };
  };
  return {
    async list(path, cursor) { const folder = await getItem(path); const result = await queryPage(`${drivePath}/items/${encodeURIComponent(folder.id)}/children`, cursor); return { entries: result.values.map((value) => entry(value, [path, value.name].filter(Boolean).join("/"))), nextCursor: result.nextCursor }; },
    searchCapabilities: async () => ({ modes: ["name", "content"], pagination: true, scope: "subtree" }), search,
    async stat(path) { try { return info(await getItem(path)); } catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; } },
    async read(path) { const { file, body } = await download(path); return { ...info(file), data: await collectStream(body) }; },
    async download(path, destination) { const { file, body } = await download(path); return { ...info(file), ...await receiveFile(body, destination) }; },
    write: upload, upload,
    async mkdir(path) {
      storagePath(path, false); const parent = await getItem(path.split("/").slice(0, -1).join("/"));
      await (await authorizedFetch(token, new URL(`${drivePath}/items/${encodeURIComponent(parent.id)}/children`, api), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "@microsoft.graph.conflictBehavior": "fail", name: path.split("/").at(-1), folder: {} }) })).body?.cancel();
    },
  };
}
const clientId = process.env.LEGALWORK_STORAGE_MICROSOFT_CLIENT_ID ?? "b4bd8b6c-fbb6-459b-82ea-3fb52acb8c62";
const provider = (id: string, name: string, rootHint: string): OAuthProvider => ({
  id, name, rootHint, clientId,
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  authorizeParams: { prompt: "select_account" },
  scopes: (readOnly, config) => ["offline_access", "https://graph.microsoft.com/User.Read", `https://graph.microsoft.com/${readOnly ? "Files.Read.All" : "Files.ReadWrite.All"}`, ...(id === "sharepoint" || (config?.root && microsoftUrl(config.root).hostname.endsWith(".sharepoint.com")) ? ["https://graph.microsoft.com/Sites.Read.All"] : [])],
  adapter: microsoftAdapter,
});
export const microsoftProviders = [
  provider("onedrive", "OneDrive", "Leave empty for your OneDrive, or paste a folder sharing link."),
  provider("sharepoint", "SharePoint", "Paste the SharePoint site, document library or folder link."),
];
