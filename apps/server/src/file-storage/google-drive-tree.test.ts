import { expect, test } from "bun:test";
import type { StoragePage } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import type { ConnectorRequestOptions, StreamingConnectorRequest } from "../connectors/request.js";
import { googleStorageAdapter } from "./cloud-drives.js";
import { googleFolder } from "./google-drive-tree.js";
import { searchFilenames } from "./filename-search.js";
import { nativeSegment } from "./native-drive.js";
import { scopedFolderAdapter } from "./project-folders.js";

type File = { id: string; name: string; mimeType: string; parents: string[]; version: string; driveId?: string; sharedWithMeTime?: string; shortcutDetails?: { targetId: string; targetMimeType: string; targetResourceKey?: string } };
function fixture() {
  const folder = (id: string, name: string, parents: string[] = [], driveId?: string): File => ({ id, name, parents, driveId, mimeType: googleFolder, version: "1" });
  const file = (id: string, name: string, parent: string, driveId?: string): File => ({ ...folder(id, name, [parent], driveId), mimeType: "text/plain" });
  const my = folder("my-root", "My Drive");
  const company = folder("company", "Company", [], "company"), other = folder("other-drive", "Company", [], "other-drive");
  const shared = { ...folder("shared-folder", "Shared client", ["unavailable-parent"]), sharedWithMeTime: "2026-10-01T00:00:00Z" };
  const files = [my, company, other, shared, file("my-file", "Personal.txt", my.id), file("shared-file", "Shared contract.txt", shared.id),
    folder("matter", "Matter 42", [company.id], company.id), file("company-file", "Contract.txt", "matter", company.id), file("company-file-2", "Contract.txt", "matter", company.id), file("other-file", "Other.txt", other.id, other.id),
    { ...folder("shortcut", "Client shortcut", [my.id]), mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: shared.id, targetMimeType: googleFolder, targetResourceKey: "fixture-resource" } },
    { ...folder("file-shortcut", "Contract shortcut.txt", [my.id]), mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "shared-file", targetMimeType: "text/plain", targetResourceKey: "fixture-resource" } },
    { ...file("direct-shared", "Direct.txt", "unavailable-parent"), sharedWithMeTime: "2026-10-01T00:00:00Z" }];
  const calls: { url: URL; options: ConnectorRequestOptions }[] = [];
  let incomplete = false;
  const response = async (path: string, options: ConnectorRequestOptions = {}) => {
    const url = new URL(path, "https://www.googleapis.com"); calls.push({ url, options });
    if (options.method && options.method !== "GET") return Response.json({ id: "created" });
    if (url.pathname === "/drive/v3/drives") return Response.json(url.searchParams.has("pageToken") ? { drives: [{ id: other.id, name: other.name }] } : { drives: [{ id: company.id, name: company.name }], nextPageToken: "drive-next" });
    if (url.pathname === "/drive/v3/files") {
      const query = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      const name = /(?:name|fullText) contains '([^']+)'/.exec(query)?.[1];
      const exactName = /name = '([^']+)'/.exec(query)?.[1];
      let values = files.filter((value) => value.id !== my.id && value.id !== company.id && value.id !== other.id);
      if (parent) values = values.filter((value) => value.parents.includes(parent));
      if (query.includes("sharedWithMe")) values = values.filter((value) => value.sharedWithMeTime);
      if (url.searchParams.get("corpora") === "drive") values = values.filter((value) => value.driveId === url.searchParams.get("driveId"));
      else if (url.searchParams.get("corpora") === "user") values = values.filter((value) => !value.driveId);
      if (name) values = values.filter((value) => value.name.toLowerCase().includes(name.toLowerCase()));
      if (exactName) values = values.filter((value) => value.name === exactName);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      return Response.json({ files: values.slice(offset, offset + 2), ...(offset + 2 < values.length ? { nextPageToken: String(offset + 2) } : {}), incompleteSearch: incomplete });
    }
    const id = url.pathname.split("/").at(-1);
    const value = id === "root" ? my : files.find((value) => value.id === id);
    if (!value) throw new ApiError(404, "storage_not_found", "Missing fixture file");
    return url.searchParams.get("alt") === "media" ? new Response(`bytes:${value.id}`) : Response.json(value, { headers: { etag: `"fixture-v${value.version}"` } });
  };
  const request: StreamingConnectorRequest = Object.assign(async (path: string, options?: ConnectorRequestOptions) => (await response(path, options)).json(), { response, assertWrite: async () => {} });
  return { request, calls, my, company, shared, files, markIncomplete: () => { incomplete = true; } };
}
async function pages(load: (cursor?: string) => Promise<StoragePage>) {
  const entries: StoragePage["entries"] = []; let cursor: string | undefined;
  const seen = new Set<string>();
  do { const page = await load(cursor); entries.push(...page.entries); cursor = page.nextCursor; if (cursor) { expect(seen.has(cursor)).toBe(false); seen.add(cursor); } } while (cursor);
  return entries;
}
const config = { kind: "oauth", provider: "google-drive", root: "", accountId: "fixture-account" } satisfies import("@legalwork/types/file-storage").StorageConfig;

test("folder expansion fetches each path item's metadata once and performs one child listing", async () => {
  const { request, calls, my, company, files } = fixture();
  const adapter = await googleStorageAdapter(config, request);
  await adapter.list("");
  expect(calls.map(({ url }) => url.pathname)).toEqual(["/drive/v3/files/root"]);
  for (const path of [nativeSegment(my), `${nativeSegment({ id: "legalwork:google:drives", name: "Shared drives" })}/${nativeSegment(company)}/${nativeSegment(files.find(file => file.id === "matter")!)}`]) {
    calls.length = 0;
    await adapter.list(path);
    const metadata = calls.filter(({ url }) => url.pathname.startsWith("/drive/v3/files/"));
    expect(metadata.length).toBe(new Set(metadata.map(({ url }) => url.pathname)).size);
    expect(calls.filter(({ url }) => url.pathname === "/drive/v3/files")).toHaveLength(1);
  }
});

test("account paths fetch independent metadata concurrently before validating their parent links", async () => {
  const { request, company, files } = fixture();
  const adapter = await googleStorageAdapter(config, request);
  const response = request.response;
  let active = 0, maximum = 0;
  request.response = async (path, options) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise<void>(resolve => setImmediate(resolve)); return await response(path, options); }
    finally { active--; }
  };
  const path = `${nativeSegment({ id: "legalwork:google:drives", name: "Shared drives" })}/${nativeSegment(company)}/${nativeSegment(files.find(file => file.id === "matter")!)}`;
  expect((await adapter.list(path)).entries.map(entry => entry.id)).toEqual(["company-file", "company-file-2"]);
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(8);
});

test("opening a Google file fetches its metadata only once before and once after transferring content", async () => {
  for (const streaming of [false, true]) {
    const { request, calls, my, files } = fixture();
    const adapter = await googleStorageAdapter(config, request);
    const file = files.find(file => file.id === "my-file")!;
    const path = `${nativeSegment(my)}/${nativeSegment(file)}`;
    calls.length = 0;
    if (streaming) await adapter.download(path); else await adapter.read(path);
    expect(calls.filter(call => call.url.pathname.endsWith(`/files/${file.id}`) && !call.url.searchParams.has("alt"))).toHaveLength(2);
    expect(calls.filter(call => call.url.searchParams.get("alt") === "media")).toHaveLength(1);
  }
});

test("whole-account ID reads use exactly two metadata requests including adapter setup, even with stale display ancestors", async () => {
  for (const streaming of [false, true]) {
    const { request, calls, files } = fixture();
    const file = files.find(file => file.id === "company-file")!;
    const adapter = await googleStorageAdapter(config, request);
    const path = `${nativeSegment({ id: "stale-parent", name: "Old location" })}/${nativeSegment(file)}`;
    const result = streaming ? await adapter.download(path) : await adapter.read(path);
    expect(result.size).toBe(`bytes:${file.id}`.length);
    const metadata = calls.filter(call => call.url.pathname.startsWith("/drive/v3/files/") && !call.url.searchParams.has("alt"));
    expect(metadata.map(call => call.url.pathname)).toEqual([`/drive/v3/files/${file.id}`, `/drive/v3/files/${file.id}`]);
    expect(calls.filter(call => call.url.searchParams.get("alt") === "media")).toHaveLength(1);
  }
});

test("whole-account reads still stop when provider access is lost before or during the download", async () => {
  for (const duringDownload of [false, true]) {
    const { request, calls, files } = fixture();
    const file = files.find(file => file.id === "company-file")!;
    const response = request.response;
    let downloaded = false;
    request.response = async (path, options) => {
      const url = new URL(path, "https://www.googleapis.com");
      if (url.pathname.endsWith(`/files/${file.id}`) && !url.searchParams.has("alt") && (!duringDownload || downloaded))
        throw new ApiError(403, "connector_access_denied", "Provider access was revoked.");
      const result = await response(path, options);
      if (url.searchParams.get("alt") === "media") downloaded = true;
      return result;
    };
    const adapter = await googleStorageAdapter(config, request);
    await expect(adapter.read(nativeSegment(file))).rejects.toMatchObject({ code: "connector_access_denied" });
    expect(calls.filter(call => call.url.searchParams.get("alt") === "media")).toHaveLength(duringDownload ? 1 : 0);
  }
});

test("whole-account reads keep name-based resolution and syntax validation when no file identity is supplied", async () => {
  const { request, my } = fixture();
  const adapter = await googleStorageAdapter(config, request);
  expect((await adapter.read(`${nativeSegment(my)}/Personal.txt`)).data.toString()).toBe("bytes:my-file");
  await expect(adapter.read(`../${nativeSegment({ id: "my-file", name: "Personal.txt" })}`)).rejects.toMatchObject({ code: "invalid_storage_path" });
});

test("a folder moved outside a restricted location during download is still rejected", async () => {
  const { request, company, files } = fixture();
  const matter = files.find(file => file.id === "matter")!, file = files.find(file => file.id === "company-file")!;
  const path = `${nativeSegment(matter)}/${nativeSegment(file)}`;
  const response = request.response;
  request.response = async (path, options) => {
    const result = await response(path, options);
    if (new URL(path, "https://www.googleapis.com").searchParams.get("alt") === "media") matter.parents = ["outside"];
    return result;
  };
  const adapter = await googleStorageAdapter({ ...config, root: company.id }, request);
  await expect(adapter.download(path)).rejects.toMatchObject({ status: 404 });
});

test("explicit folder views reject an outside ancestor before fetching descendant metadata", async () => {
  const { request, calls, my, files } = fixture();
  const matter = files.find(file => file.id === "matter")!, file = files.find(file => file.id === "company-file")!;
  const adapter = await googleStorageAdapter({ ...config, root: my.id }, request);
  calls.length = 0;
  await expect(adapter.read(`${nativeSegment(matter)}/${nativeSegment(file)}`)).rejects.toMatchObject({ status: 404 });
  expect(calls.some(call => call.url.pathname.endsWith(`/files/${file.id}`))).toBe(false);
});

test("retargeting a shortcut during download is detected even when both targets have the same version", async () => {
  const { request, my, files } = fixture();
  const shortcut = files.find(file => file.id === "file-shortcut")!;
  const response = request.response;
  request.response = async (path, options) => {
    const result = await response(path, options);
    if (new URL(path, "https://www.googleapis.com").searchParams.get("alt") === "media" && shortcut.shortcutDetails) shortcut.shortcutDetails.targetId = "my-file";
    return result;
  };
  const adapter = await googleStorageAdapter(config, request);
  await expect(adapter.read(`${nativeSegment(my)}/${nativeSegment(shortcut)}`)).rejects.toMatchObject({ code: "storage_conflict" });
});

test("metadata reuse preserves fresh versions, parent checks and changes during download", async () => {
  const { request, my, files } = fixture();
  const adapter = await googleStorageAdapter(config, request);
  const file = files.find(file => file.id === "my-file")!;
  const path = `${nativeSegment(my)}/${nativeSegment(file)}`;
  expect((await adapter.stat(path))?.version).toBe('"fixture-v1"');
  file.version = "2";
  expect((await adapter.stat(path))?.version).toBe('"fixture-v2"');
  file.parents = ["another-folder"];
  expect(await adapter.stat(path)).toBeNull();
  file.parents = [my.id];
  const response = request.response;
  request.response = async (path, options) => {
    const result = await response(path, options);
    if (new URL(path, "https://www.googleapis.com").searchParams.get("alt") === "media") file.version = "3";
    return result;
  };
  await expect(adapter.read(path)).rejects.toMatchObject({ code: "storage_conflict" });
});

test("default Google account exposes My Drive, Shared with me and paginated company drives", async () => {
  const { request, shared, calls } = fixture(); const adapter = await googleStorageAdapter(config, request);
  const root = await adapter.list(""); expect(root.entries.map((entry) => entry.name)).toEqual(["My Drive", "Shared with me", "Shared drives", "All files"]);
  const sharedLocation = root.entries.find((entry) => entry.name === "Shared with me")!;
  const sharedEntries = await pages((cursor) => adapter.list(sharedLocation.path, cursor));
  expect(sharedEntries.map((entry) => entry.id)).toEqual([shared.id, "direct-shared"]);
  const sharedChild = (await adapter.list(sharedEntries[0]!.path)).entries[0]!;
  expect((await adapter.read(sharedChild.path)).data.toString()).toBe("bytes:shared-file");
  const driveLocation = root.entries.find((entry) => entry.name === "Shared drives")!;
  const drives = await pages((cursor) => adapter.list(driveLocation.path, cursor));
  expect(drives.map((entry) => entry.name)).toEqual(["Company", "Company"]); expect(drives[0]!.path).not.toBe(drives[1]!.path);
  const matter = (await adapter.list(drives[0]!.path)).entries[0]!;
  const contracts = await pages((cursor) => adapter.list(matter.path, cursor));
  expect(contracts.map((entry) => entry.name)).toEqual(["Contract.txt", "Contract.txt"]);
  expect(contracts[0]!.path).not.toBe(contracts[1]!.path); expect((await adapter.read(contracts[1]!.path)).data.toString()).toBe("bytes:company-file-2");
  expect(calls.some(({ url }) => url.searchParams.get("corpora") === "drive" && url.searchParams.get("driveId") === "company")).toBe(true);
});

test("agent native search and default recursive path search find shared-only company files", async () => {
  const { request, calls } = fixture(); const adapter = await googleStorageAdapter(config, request);
  expect((await adapter.searchCapabilities!()).scope).toBe("subtree");
  const native = await pages((cursor) => adapter.search!({ mode: "content", query: "Contract", path: "", cursor }));
  expect(native.some((entry) => entry.id === "company-file")).toBe(true);
  for (const result of native) expect((await adapter.read(result.path)).data.length).toBeGreaterThan(0);
  const byPath = await pages(async (cursor) => searchFilenames(adapter, { query: "Matter 42", path: "", match: "path", cursor }, "fixture-revision"));
  expect(byPath.map((entry) => entry.id)).toEqual(["company-file", "company-file-2"]);
  expect(calls.filter(({ url }) => url.pathname === "/drive/v3/files" && /fullText/.test(url.search)).every(({ url }) => !url.searchParams.get("q")?.includes(" in parents"))).toBe(true);
});

test("explicit folder views and linked project scopes do not expand to the account", async () => {
  const { request, company, my, files } = fixture();
  const adapter = await googleStorageAdapter({ ...config, root: company.id }, request);
  expect(adapter.listFilesAtRoot).toBeUndefined();
  expect((await adapter.list("")).entries.map((entry) => entry.name)).toEqual(["Matter 42"]);
  const found = await pages((cursor) => searchFilenames(adapter, { query: "Contract", path: "", cursor }, "folder"));
  expect(found.map((entry) => entry.id)).toEqual(["company-file", "company-file-2"]);
  expect(await pages((cursor) => adapter.search!({ mode: "name", query: "Direct", path: "", cursor }))).toEqual([]);
  await expect(adapter.read(nativeSegment(files.find((value) => value.id === "direct-shared")!))).rejects.toMatchObject({ status: 404 });
  const accountAdapter = await googleStorageAdapter(config, request);
  const project = await scopedFolderAdapter(accountAdapter, await accountAdapter.folderReference!(nativeSegment(my)));
  expect(project.listFilesAtRoot).toBeUndefined();
  await expect(project.read(`${nativeSegment(company)}/${nativeSegment(files.find((value) => value.id === "matter")!)}`)).rejects.toMatchObject({ status: 404 });
  await expect(project.write("new.txt", Buffer.from("x"), "text/plain", { createOnly: true })).rejects.toMatchObject({ code: "storage_read_only" });
  await expect(project.list(nativeSegment(files.find((value) => value.id === "shortcut")!))).rejects.toMatchObject({ code: "storage_outside_root" });
});

test("account browsing follows accessible folder/file shortcuts and restricted views reject outside targets", async () => {
  const { request, my, files, calls } = fixture(); const adapter = await googleStorageAdapter(config, request);
  const folder = files.find((value) => value.id === "shortcut")!, file = files.find((value) => value.id === "file-shortcut")!;
  const path = `${nativeSegment({ ...my, name: "My Drive" })}/${nativeSegment(folder)}`;
  const child = (await adapter.list(path)).entries[0]!;
  expect((await adapter.read(child.path)).data.toString()).toBe("bytes:shared-file");
  const shortcutPath = `${nativeSegment(my)}/${nativeSegment(file)}`;
  expect((await adapter.read(shortcutPath)).data.toString()).toBe("bytes:shared-file");
  expect((await adapter.stat(shortcutPath))?.writable).toBe(false);
  expect(calls.some(({ options }) => options.headers?.["X-Goog-Drive-Resource-Keys"] === "shared-file/fixture-resource")).toBe(true);
  await expect(adapter.deleteFile!(shortcutPath)).rejects.toMatchObject({ code: "storage_read_only" });
  const scoped = await googleStorageAdapter({ ...config, root: my.id }, request);
  await expect(scoped.list(nativeSegment(folder))).rejects.toMatchObject({ code: "storage_outside_root" });
  await expect(scoped.read(nativeSegment(file))).rejects.toMatchObject({ code: "storage_outside_root" });
});

test("virtual locations and mutations still require valid parent membership even though account reads use IDs", async () => {
  const { request, calls, files } = fixture(); const adapter = await googleStorageAdapter(config, request);
  const root = await adapter.list(""); const shared = root.entries.find((entry) => entry.name === "Shared with me")!, drives = root.entries.find((entry) => entry.name === "Shared drives")!;
  const personal = files.find((value) => value.id === "my-file")!;
  for (const location of [shared, drives]) {
    const path = `${location.path}/${nativeSegment(personal)}`;
    expect(await adapter.stat(path)).toBeNull();
    await expect(adapter.deleteFile!(path)).rejects.toMatchObject({ status: 404 });
    await expect(adapter.copyFile!(path, "Copy.txt")).rejects.toMatchObject({ status: 404 });
  }
  await expect(adapter.mkdir(`${shared.path}/Unsafe`)).rejects.toMatchObject({ code: "storage_invalid_destination" });
  await expect(adapter.deleteFolder!(shared.path, true)).rejects.toMatchObject({ code: "storage_read_only" });
  expect(calls.some(({ options }) => options.method)).toBe(false);
});

test("continuation pages are scoped to the account/query and incomplete results stay explicit", async () => {
  const { request, markIncomplete } = fixture(); const adapter = await googleStorageAdapter(config, request);
  const page = await adapter.search!({ mode: "name", query: "Contract", path: "" }); expect(page.nextCursor).toBeDefined();
  await expect(adapter.search!({ mode: "name", query: "Other", path: "", cursor: page.nextCursor })).rejects.toMatchObject({ code: "invalid_storage_cursor" });
  const other = await googleStorageAdapter({ ...config, accountId: "other-account" }, request);
  await expect(other.search!({ mode: "name", query: "Contract", path: "", cursor: page.nextCursor })).rejects.toMatchObject({ code: "invalid_storage_cursor" });
  markIncomplete(); expect((await adapter.search!({ mode: "name", query: "Contract", path: "" })).truncated).toBe(true);
  expect((await searchFilenames(adapter, { query: "Contract", path: "" }, "revision")).complete).toBe(false);
});

test("existing My Drive ID paths and project references survive the account root expansion", async () => {
  const { request, files, my } = fixture(); const adapter = await googleStorageAdapter(config, request);
  const personal = files.find((value) => value.id === "my-file")!;
  expect((await adapter.read(nativeSegment(personal))).data.toString()).toBe("bytes:my-file");
  const old = { id: my.id, name: "Drive", path: "", namespace: `google-drive:${config.accountId}:${my.id}` };
  expect(await adapter.resolveFolder!(old)).toBe(nativeSegment({ ...my, name: "My Drive" }));
});

test("lazy account setup preserves My Drive labels and existing folder-reference namespaces", async () => {
  const { request, my } = fixture(); my.name = "Provider root name";
  const adapter = await googleStorageAdapter(config, request);
  expect(await adapter.folderReference!(nativeSegment(my))).toMatchObject({ name: "My Drive", id: my.id, namespace: `google-drive:${config.accountId}:${my.id}` });
});

test("shortcut cycles cannot recursively walk the account indefinitely", async () => {
  const { request, files, my } = fixture();
  const loop = { id: "loop", name: "Loop", mimeType: "application/vnd.google-apps.shortcut", parents: [my.id], version: "1", shortcutDetails: { targetId: my.id, targetMimeType: googleFolder } };
  files.push(loop);
  const adapter = await googleStorageAdapter(config, request);
  await expect(adapter.list(`${nativeSegment(my)}/${nativeSegment(loop)}/${nativeSegment(loop)}`)).rejects.toMatchObject({ code: "storage_invalid_response" });
});


test("team location folder links resolve to a scoped physical Google folder", async () => {
  const { request } = fixture();
  const adapter = await googleStorageAdapter({ ...config, root: "https://drive.google.com/drive/folders/matter?usp=sharing" }, request);
  const entries = await pages(cursor => adapter.list("", cursor));
  expect(entries.map(entry => entry.id)).toEqual(["company-file", "company-file-2"]);
  await expect(googleStorageAdapter({ ...config, root: "https://drive.google.com/file/d/matter" }, request)).rejects.toMatchObject({ code: "invalid_storage_root" });
});
