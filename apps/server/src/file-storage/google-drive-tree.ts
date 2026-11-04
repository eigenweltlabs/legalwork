import { createHash } from "node:crypto";
import { z } from "zod";
import type { StorageConfig, StoragePage, StorageSearch } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import { parseNative } from "../connectors/native.js";
import type { StreamingConnectorRequest } from "../connectors/request.js";
import { nativeSegment, type DriveItem } from "./native-drive.js";
import { conflict } from "./common.js";

export const googleFolder = "application/vnd.google-apps.folder";
export const googleExports = {
  "application/vnd.google-apps.document": { extension: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  "application/vnd.google-apps.spreadsheet": { extension: "xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  "application/vnd.google-apps.presentation": { extension: "pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  "application/vnd.google-apps.drawing": { extension: "pdf", type: "application/pdf" },
};
const googleFile = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), size: z.string().optional(), md5Checksum: z.string().optional(), modifiedTime: z.string().optional(), version: z.string().optional(), parents: z.array(z.string()).default([]), webViewLink: z.string().optional(), trashed: z.boolean().optional(), driveId: z.string().optional(), sharedWithMeTime: z.string().optional(), resourceKey: z.string().optional(), shortcutDetails: z.object({ targetId: z.string(), targetMimeType: z.string(), targetResourceKey: z.string().optional() }).optional() });
const googleFields = "id,name,mimeType,size,md5Checksum,modifiedTime,version,parents,webViewLink,trashed,driveId,sharedWithMeTime,resourceKey,shortcutDetails";
const filesPage = z.object({ files: z.array(googleFile).default([]), nextPageToken: z.string().optional(), incompleteSearch: z.boolean().optional() });
const conditionalMetadata = z.object({ id: z.string(), etag: z.string(), version: z.string() });
const driveSchema = z.object({ id: z.string(), name: z.string() });
const drivesPage = z.object({ drives: z.array(driveSchema), nextPageToken: z.string().optional() });
const cursorSchema = z.object({ scope: z.string(), phase: z.enum(["user", "drives"]), token: z.string().optional(), drivesToken: z.string().optional(), offset: z.number().int().min(0).max(100).default(0), driveId: z.string().optional() });
const literal = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
type GoogleItem = DriveItem & { revision?: string; driveId?: string; sharedWithMeTime?: string; resourceKey?: string; targetResourceKey?: string; checksum?: string };
function item(file: z.infer<typeof googleFile>, etag?: string | null): GoogleItem {
  if (file.trashed) throw new ApiError(404, "storage_not_found", "This file is in the trash.");
  const mime = file.shortcutDetails?.targetMimeType ?? file.mimeType;
  const format = Object.entries(googleExports).find(([key]) => key === mime)?.[1];
  return { id: file.id, name: format ? `${file.name}.${format.extension}` : file.name, folder: mime === googleFolder,
    parents: file.parents, size: Number(file.size ?? 0), version: etag ?? `sha256:${file.version ?? file.modifiedTime ?? file.id}`, revision: file.version,
    contentType: format?.type ?? mime, modifiedAt: file.modifiedTime, webUrl: file.webViewLink,
    exported: mime.startsWith("application/vnd.google-apps.") && mime !== googleFolder,
    driveId: file.driveId, sharedWithMeTime: file.sharedWithMeTime, resourceKey: file.resourceKey, checksum: file.md5Checksum,
    targetId: file.shortcutDetails?.targetId, targetResourceKey: file.shortcutDetails?.targetResourceKey,
    readOnly: Boolean(file.shortcutDetails) };
}
export async function listGoogleSharedDrives(request: StreamingConnectorRequest, pageToken?: string) {
  const query = new URLSearchParams({ pageSize: "100", fields: "nextPageToken,drives(id,name)" });
  if (pageToken) query.set("pageToken", pageToken);
  const page = parseNative(drivesPage, await request(`/drive/v3/drives?${query}`));
  if (pageToken && page.nextPageToken === pageToken) throw new ApiError(502, "storage_invalid_response", "Google repeated a shared drive page.");
  return { drives: page.drives, nextPageToken: page.nextPageToken ?? null };
}

/** Virtual locations reuse one account. Only provider-authorized metadata can become an ID path. */
export async function googleDriveTree(config: Extract<StorageConfig, { kind: "oauth" }>, request: StreamingConnectorRequest) {
  const accountWide = !config.root && !config.driveId;
  const metadata = new Map<string, GoogleItem>();
  const physical = async (id: string, resourceKey?: string): Promise<GoogleItem> => {
    const response = await request.response(`/drive/v3/files/${encodeURIComponent(id)}?${new URLSearchParams({ fields: googleFields, supportsAllDrives: "true" })}`,
      resourceKey ? { headers: { "X-Goog-Drive-Resource-Keys": `${id}/${resourceKey}` } } : {});
    const file = item(parseNative(googleFile, await response.json()), response.headers.get("etag"));
    metadata.set(file.id, file);
    return file;
  };
  let myDrive: GoogleItem | undefined;
  let rootLookup: Promise<GoogleItem> | undefined;
  const getMyDrive = () => rootLookup ??= physical(config.root || config.driveId || "root").then(file => {
    if (!file.folder) throw new ApiError(400, "invalid_storage_root", "Choose a Google Drive folder ID.");
    myDrive = file;
    return file;
  });
  const checkShortcutScope = async (target: GoogleItem) => {
    if (accountWide) return;
    const boundary = await getMyDrive();
    const seen = new Set<string>(); let current = target;
    while (current.id !== boundary.id) {
      if (seen.has(current.id) || current.parents.length !== 1 || seen.size >= 100) throw new ApiError(403, "storage_outside_root", "This shortcut points outside the selected folder view. Open it from the Google Drive account instead.");
      seen.add(current.id);
      try { current = await physical(current.parents[0]!); }
      catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) throw new ApiError(403, "storage_outside_root", "This shortcut points outside the selected folder view. Open it from the Google Drive account instead.");
        throw error;
      }
    }
  };
  const virtual = (id: string, name: string): GoogleItem => ({ id: `legalwork:google:${id}`, name, folder: true, parents: ["legalwork:google:account"], size: 0, version: `virtual:${id}`, contentType: googleFolder, readOnly: true });
  const root = accountWide ? virtual("account", "Google Drive") : await getMyDrive();
  const shared = virtual("shared", "Shared with me"), drives = virtual("drives", "Shared drives"), all = virtual("all", "All files");
  const locations = [shared, drives, all];
  const get = async (id: string): Promise<GoogleItem> => {
    if (accountWide) {
      if (id === root.id) return root;
      const location = locations.find((location) => location.id === id);
      if (location) return location;
    }
    const file = await physical(id, metadata.get(id)?.resourceKey);
    if (file.targetId && !file.folder) {
      const target = await physical(file.targetId, file.targetResourceKey);
      await checkShortcutScope(target);
      if (target.targetId || target.folder) throw new ApiError(404, "storage_not_found", "This shortcut target is unavailable.");
      return { ...target, id: file.id, name: file.name, parents: file.parents, targetId: file.targetId, targetResourceKey: file.targetResourceKey, sharedWithMeTime: file.sharedWithMeTime, readOnly: true };
    }
    if (accountWide && file.folder && !file.parents.length && !file.driveId && !myDrive) await getMyDrive();
    return accountWide && file.id === myDrive?.id ? { ...file, name: "My Drive" } : file;
  };
  const fileList = async (filters: string[], cursor?: string, driveId?: string, user = false, resource?: GoogleItem) => {
    const query = new URLSearchParams({ q: ["trashed = false", ...filters].join(" and "), pageSize: "100", spaces: "drive", fields: `nextPageToken,incompleteSearch,files(${googleFields})`, supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (driveId) { query.set("corpora", "drive"); query.set("driveId", driveId); }
    else if (user) query.set("corpora", "user");
    if (cursor) query.set("pageToken", cursor);
    const result = parseNative(filesPage, await request(`/drive/v3/files?${query}`, resource?.resourceKey ? { headers: { "X-Goog-Drive-Resource-Keys": `${resource.id}/${resource.resourceKey}` } } : {}));
    if (cursor && result.nextPageToken === cursor) throw new ApiError(502, "storage_invalid_response", "Google repeated a file page.");
    const items = result.files.filter((file) => !file.trashed).map((file) => item(file));
    for (const file of items) metadata.set(file.id, file);
    return { items, nextCursor: result.nextPageToken, truncated: result.incompleteSearch };
  };
  // User corpus includes individually shared items. Enumerate every member drive separately:
  // allDrives alone can omit unvisited company files or return incompleteSearch.
  const accountPage = async (filters: string[], cursor?: string) => {
    const scope = createHash("sha256").update(JSON.stringify([config.accountId, filters])).digest("hex");
    let state: z.infer<typeof cursorSchema> = { scope, phase: "user", offset: 0 };
    if (cursor) {
      try { state = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString())); }
      catch { throw new ApiError(400, "invalid_storage_cursor", "Start the Google Drive search again."); }
      if (state.scope !== scope) throw new ApiError(400, "invalid_storage_cursor", "This page belongs to another account or search.");
    }
    const encode = (state: z.infer<typeof cursorSchema>) => Buffer.from(JSON.stringify(state)).toString("base64url");
    if (state.phase === "user") {
      const page = await fileList(filters, state.token, undefined, true);
      return { ...page, nextCursor: encode(page.nextCursor ? { ...state, token: page.nextCursor } : { scope, phase: "drives", offset: 0 }) };
    }
    const page = await listGoogleSharedDrives(request, state.drivesToken);
    const drive = page.drives[state.offset];
    if (!drive) return { items: [], nextCursor: page.nextPageToken ? encode({ scope, phase: "drives", drivesToken: page.nextPageToken, offset: 0 }) : undefined, truncated: undefined };
    if (state.driveId && state.driveId !== drive.id) throw new ApiError(409, "storage_listing_changed", "Your shared drive list changed. Start this search again.");
    const files = await fileList(filters, state.token, drive.id);
    const next = files.nextCursor ? { ...state, driveId: drive.id, token: files.nextCursor }
      : state.offset + 1 < page.drives.length ? { scope, phase: state.phase, drivesToken: state.drivesToken, offset: state.offset + 1 }
      : page.nextPageToken ? { scope, phase: state.phase, drivesToken: page.nextPageToken, offset: 0 } : undefined;
    return { ...files, nextCursor: next ? encode(next) : undefined };
  };
  const shortcutTarget = async (folder: GoogleItem) => {
    if (!folder.targetId) return folder;
    const target = await physical(folder.targetId, folder.targetResourceKey);
    await checkShortcutScope(target);
    if (!target.folder || target.targetId) throw new ApiError(404, "storage_not_found", "This shortcut folder is unavailable.");
    return target;
  };
  const children = async (id: string, cursor?: string) => {
    if (accountWide && id === root.id) return { items: [{ ...await getMyDrive(), name: "My Drive" }, ...locations] };
    if (accountWide && id === shared.id) return fileList(["sharedWithMe"], cursor, undefined, true);
    if (accountWide && id === all.id) return accountPage([], cursor);
    if (accountWide && id === drives.id) {
      const page = await listGoogleSharedDrives(request, cursor);
      return { items: page.drives.map((drive) => ({ ...virtual(drive.id, drive.name), id: drive.id, parents: [drives.id] })), nextCursor: page.nextPageToken ?? undefined };
    }
    // resolve() just refreshed this folder. Reuse it for the child listing,
    // without caching get(): reads still need fresh versions before and after download.
    const folder = await shortcutTarget(metadata.get(id) ?? await get(id));
    return fileList([`'${literal(folder.id)}' in parents`], cursor, folder.driveId, false, folder);
  };
  const relativePath = async (file: DriveItem): Promise<string> => {
    if (file.id === root.id) return "";
    if (accountWide && locations.some((location) => location.id === file.id)) return nativeSegment(file);
    const parts: string[] = [], seen = new Set<string>(); let current = metadata.get(file.id) ?? await get(file.id);
    const boundaryId = accountWide && current.driveId ? current.driveId : (await getMyDrive()).id;
    while (current.id !== boundaryId) {
      if (seen.has(current.id) || seen.size >= 100) throw new ApiError(502, "storage_invalid_response", "Google returned a folder cycle.");
      seen.add(current.id); parts.unshift(nativeSegment(current));
      if (accountWide && current.driveId === current.id) return [nativeSegment(drives), ...parts].join("/");
      if (accountWide && !current.driveId && current.sharedWithMeTime) return [nativeSegment(shared), ...parts].join("/");
      if (current.parents.length !== 1) {
        if (accountWide) return `${nativeSegment(all)}/${nativeSegment(file)}`;
        throw new ApiError(404, "storage_not_found", "This file is outside the selected folder view.");
      }
      try { current = metadata.get(current.parents[0]!) ?? await get(current.parents[0]!); }
      catch (error) {
        if (accountWide && error instanceof ApiError && (error.status === 403 || error.status === 404)) return `${nativeSegment(all)}/${nativeSegment(file)}`;
        throw error;
      }
    }
    if (accountWide && current.driveId === current.id) return [nativeSegment(drives), nativeSegment(current), ...parts].join("/");
    return [accountWide ? nativeSegment({ ...await getMyDrive(), name: "My Drive" }) : "", ...parts].filter(Boolean).join("/");
  };
  const contains = async (current: GoogleItem, child: GoogleItem) => {
    // Both items were obtained while resolving this path. Fetching them again
    // adds two serial provider requests per segment without strengthening the check.
    if (accountWide) {
      if (current.id === root.id) {
        if (locations.some(location => location.id === child.id)) return true;
        const personalRoot = await getMyDrive();
        return child.id === personalRoot.id || child.parents.includes(personalRoot.id);
      }
      if (current.id === all.id) return !child.id.startsWith("legalwork:google:");
      if (current.id === shared.id) return Boolean(child.sharedWithMeTime);
      if (current.id === drives.id) return child.folder && child.driveId === child.id;
    }
    return child.parents.includes((await shortcutTarget(current)).id);
  };
  const search = async (parent: DriveItem, input: StorageSearch) => {
    const filter = `${input.mode === "name" ? "name" : "fullText"} contains '${literal(input.query)}'`;
    if (accountWide && (parent.id === root.id || parent.id === all.id || parent.id === drives.id)) return accountPage([filter], input.cursor);
    if (accountWide && parent.id === shared.id) return fileList(["sharedWithMe", filter], input.cursor, undefined, true);
    const folder = await shortcutTarget(await get(parent.id));
    return fileList([`'${literal(folder.id)}' in parents`, filter], input.cursor, folder.driveId, false, folder);
  };
  const searchPath = async (file: DriveItem, input: StorageSearch) => {
    if (!input.path || (accountWide && input.path === nativeSegment(drives))) return relativePath(file);
    return `${input.path}/${nativeSegment(file)}`;
  };
  const listFilesAtRoot = accountWide ? async (cursor?: string, signal?: AbortSignal): Promise<StoragePage> => {
    signal?.throwIfAborted(); const page = await accountPage([], cursor);
    const entries: StoragePage["entries"] = [];
    for (const file of page.items) {
      signal?.throwIfAborted();
      if (!file.folder) entries.push({ id: file.id, name: file.name, path: await relativePath(file), kind: "file", size: file.size, modifiedAt: file.modifiedAt ?? null, version: file.version, webUrl: file.webUrl, exported: file.exported });
    }
    return { entries, nextCursor: page.nextCursor, truncated: page.truncated };
  } : undefined;
  const writeParent = async (parent: DriveItem) => {
    if (accountWide && parent.id === root.id) return get((await getMyDrive()).id);
    if (parent.id.startsWith("legalwork:google:")) throw new ApiError(400, "storage_invalid_destination", "Choose a folder in My Drive or a shared drive to save files.");
    return shortcutTarget(await get(parent.id));
  };
  // Drive v3 omits the file ETag. Read and patch through v2 for a genuine
  // conditional rename or trash, rejecting any change since v3 resolved the source.
  const conditionalVersion = async (file: GoogleItem) => {
    if (!file.revision) throw new ApiError(409, "storage_conditional_write_unsupported", "The provider did not supply a safe file version. Refresh before changing this file.");
    const query = new URLSearchParams({ supportsAllDrives: "true", fields: "id,etag,version" });
    const current = parseNative(conditionalMetadata, await request(`/drive/v2/files/${encodeURIComponent(file.id)}?${query}`,
      file.resourceKey ? { headers: { "X-Goog-Drive-Resource-Keys": `${file.id}/${file.resourceKey}` } } : {}));
    if (current.id !== file.id) throw new ApiError(502, "storage_invalid_response", "Google returned a different file identity.");
    if (current.version !== file.revision) conflict();
    return current.etag;
  };
  const rename = async (file: GoogleItem, parent: DriveItem, name: string) => {
    parent = await writeParent(parent);
    const query = new URLSearchParams({ supportsAllDrives: "true", fields: "id" });
    if (!file.parents.includes(parent.id)) { query.set("addParents", parent.id); query.set("removeParents", file.parents.join(",")); }
    await request(`/drive/v2/files/${encodeURIComponent(file.id)}?${query}`, { method: "PATCH", body: { title: name }, headers: {
      "If-Match": file.version,
      ...(file.resourceKey ? { "X-Goog-Drive-Resource-Keys": `${file.id}/${file.resourceKey}` } : {}),
    } });
  };
  const remove = async (file: GoogleItem, version?: string) => {
    await request(`/drive/v2/files/${encodeURIComponent(file.id)}?supportsAllDrives=true&fields=id`, { method: "PATCH", body: { labels: { trashed: true } }, headers: {
      "If-Match": version ?? file.version,
      ...(file.resourceKey ? { "X-Goog-Drive-Resource-Keys": `${file.id}/${file.resourceKey}` } : {}),
    } });
  };
  const download = async (file: GoogleItem) => {
    if (file.exported && !Object.values(googleExports).some(format => format.type === file.contentType)) throw new ApiError(415, "storage_export_unsupported", "This Google file cannot be exported to a supported editor format. Open its provider link.");
    const target = file.targetId ?? file.id;
    const key = file.targetResourceKey ?? file.resourceKey;
    const path = `/drive/v3/files/${encodeURIComponent(target)}`;
    return request.response(file.exported ? `${path}/export?${new URLSearchParams({ mimeType: file.contentType })}` : `${path}?alt=media&supportsAllDrives=true`, { bytes: true, ...(key ? { headers: { "X-Goog-Drive-Resource-Keys": `${target}/${key}` } } : {}) });
  };
  const lookup = async (parent: DriveItem, name: string) => {
    if (!accountWide || parent.id !== root.id) return null;
    const personalRoot = await getMyDrive();
    let cursor: string | undefined, found: GoogleItem | null = null;
    const seen = new Set<string>();
    do {
      const page = await fileList([`'${literal(personalRoot.id)}' in parents`, `name = '${literal(name)}'`], cursor);
      for (const file of page.items) if (file.name === name) {
        if (found) throw new ApiError(409, "storage_ambiguous_path", "Several files have this name. Choose the file by its listed identity.");
        found = file;
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new ApiError(502, "storage_invalid_response", "Google repeated a file page.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return found;
  };
  const searchScope: "folder" | "subtree" = accountWide ? "subtree" : "folder";
  return { root, get, children, contains, lookup, search, searchPath, relativePath, listFilesAtRoot, writeParent, conditionalVersion, rename, remove, download, parallelMetadata: accountWide, readById: accountWide,
    namespace: async () => `google-drive:${config.accountId}:${(await getMyDrive()).id}`, searchScope };
}
