import { afterEach, expect, test } from "bun:test";
import type { ConnectorRequestOptions, StreamingConnectorRequest } from "../connectors/request.js";
import { ApiError } from "../errors.js";
import { googleStorageAdapter, microsoftStorageAdapter } from "./cloud-drives.js";
import { googleFolder } from "./google-drive-tree.js";
import { nativeSegment } from "./native-drive.js";
import { transferEntry } from "./transfer.js";
import { microsoftCopy } from "./microsoft-copy.js";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
function transport(handler: (url: URL, options: ConnectorRequestOptions) => Promise<Response> | Response, origin = "https://www.googleapis.com") {
  const calls: { url: URL; options: ConnectorRequestOptions }[] = [];
  const response = async (path: string, options: ConnectorRequestOptions = {}) => {
    const url = new URL(path, origin); calls.push({ url, options });
    if (url.searchParams.get("alt") === "media" || url.pathname.includes("/upload/") || url.pathname.endsWith("/content") || url.pathname.endsWith("/export")) throw new Error("Native copies must never transfer file bytes");
    return handler(url, options);
  };
  const request: StreamingConnectorRequest = Object.assign(async (path: string, options?: ConnectorRequestOptions) => (await response(path, options)).json(), {
    response, assertWrite: async () => {}, apiOrigin: origin,
  });
  return { request, calls };
}
type GoogleFile = { id: string; name: string; mimeType: string; parents: string[]; size?: string; md5Checksum?: string };
function googleFixture(nativeDocument = false) {
  const root: GoogleFile = { id: "root-id", name: "Drive", mimeType: googleFolder, parents: [] };
  const folder = (id: string, name: string, parent: string): GoogleFile => ({ id, name, mimeType: googleFolder, parents: [parent] });
  const file: GoogleFile = { id: "file", name: nativeDocument ? "Report.docx" : "Large.bin", mimeType: nativeDocument ? "application/vnd.google-apps.document" : "application/octet-stream",
    parents: ["source"], ...(nativeDocument ? {} : { size: String(4 * 1024 ** 3), md5Checksum: "original-hash" }) };
  const source = folder("source", "Source", root.id), archive = folder("archive", "Archive", root.id);
  const files = new Map([root, source, archive, file, folder("empty", "Empty", source.id)].map(item => [item.id, item]));
  let copies = 0, corrupt = false;
  const { request, calls } = transport((url, options) => {
    if (url.pathname.endsWith("/copy")) {
      const body = options.body;
      if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string" || !("parents" in body) || !Array.isArray(body.parents) || typeof body.parents[0] !== "string") throw new Error("Invalid copy metadata");
      const original = files.get(decodeURIComponent(url.pathname.split("/").at(-2)!))!;
      const copy = { ...original, id: `copy-${++copies}`, name: body.name, parents: [body.parents[0]], ...(corrupt ? { md5Checksum: "corrupt-hash" } : {}) };
      files.set(copy.id, copy); return Response.json({ id: copy.id });
    }
    if (options.method === "POST") {
      const body = options.body;
      if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string" || !("parents" in body) || !Array.isArray(body.parents) || typeof body.parents[0] !== "string") throw new Error("Invalid folder metadata");
      const created = folder(`folder-${files.size}`, body.name, body.parents[0]); files.set(created.id, created);
      return Response.json({ id: created.id });
    }
    if (url.pathname === "/drive/v3/files") {
      const query = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      const name = /name = '([^']+)'/.exec(query)?.[1];
      const children = [...files.values()].filter(item => item.parents.includes(parent ?? "") && (!name || item.name === name));
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      return Response.json({ files: children.slice(offset, offset + 1), ...(offset + 1 < children.length ? { nextPageToken: String(offset + 1) } : {}) });
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const item = files.get(id === "root" ? root.id : id);
    if (!item) throw new ApiError(404, "storage_not_found", "Missing fixture item");
    return Response.json(item, { headers: { etag: '"version-1"' } });
  });
  return { request, calls, files, root, source, archive, file, corrupt: () => { corrupt = true; } };
}

test("Google sidebar folder copies use provider RPCs, preserving a large file and empty folders with zero content transfers", async () => {
  const fixture = googleFixture();
  const adapter = await googleStorageAdapter({ kind: "oauth", provider: "google-drive", root: fixture.root.id, accountId: "account" }, fixture.request);
  const path = await transferEntry(adapter, adapter, { path: nativeSegment(fixture.source), kind: "folder", destinationId: "same", destinationPath: nativeSegment(fixture.archive), mode: "copy" }, true);
  expect(path).toEndWith("/Source");
  const copied = [...fixture.files.values()].find(item => item.id.startsWith("copy-"))!;
  expect(copied.size).toBe(String(4 * 1024 ** 3)); expect(copied.md5Checksum).toBe(fixture.file.md5Checksum);
  const copiedRoot = [...fixture.files.values()].find(item => item.name === "Source" && item.parents.includes(fixture.archive.id))!;
  expect([...fixture.files.values()].some(item => item.name === "Empty" && item.parents.includes(copiedRoot.id))).toBe(true);
  expect(fixture.files.get(fixture.file.id)).toEqual(fixture.file);
  expect(fixture.calls.filter(call => call.url.pathname.endsWith("/copy"))).toHaveLength(1);
  expect(fixture.calls.every(call => !["DELETE", "PATCH", "PUT"].includes(call.options.method ?? "GET"))).toBe(true);
});

test("Google copies native documents without exporting or doubling their display extension", async () => {
  const fixture = googleFixture(true);
  const adapter = await googleStorageAdapter({ kind: "oauth", provider: "google-drive", root: fixture.root.id, accountId: "account" }, fixture.request);
  await transferEntry(adapter, adapter, { path: `${nativeSegment(fixture.source)}/${nativeSegment({ id: fixture.file.id, name: "Report.docx.docx" })}`, kind: "file", destinationId: "same", destinationPath: nativeSegment(fixture.archive), mode: "copy" }, true);
  const copied = [...fixture.files.values()].find(item => item.id.startsWith("copy-"))!;
  expect(copied).toMatchObject({ name: "Report.docx", mimeType: "application/vnd.google-apps.document", parents: [fixture.archive.id] });
  expect(fixture.calls.find(call => call.url.pathname.endsWith("/copy"))?.options.body).toEqual({ name: "Report.docx", parents: [fixture.archive.id] });
});

test("Google native copies reject mismatched checksums without downloading or deleting originals", async () => {
  const fixture = googleFixture(); fixture.corrupt();
  const adapter = await googleStorageAdapter({ kind: "oauth", provider: "google-drive", root: fixture.root.id, accountId: "account" }, fixture.request);
  await expect(transferEntry(adapter, adapter, { path: `${nativeSegment(fixture.source)}/${nativeSegment(fixture.file)}`, kind: "file", destinationId: "same", destinationPath: nativeSegment(fixture.archive), mode: "copy" }, true)).rejects.toMatchObject({ code: "storage_transfer_incomplete" });
  expect(fixture.files.has(fixture.file.id)).toBe(true);
  expect(fixture.calls.filter(call => call.url.pathname.endsWith("/copy"))).toHaveLength(1);
});

test("Microsoft sidebar copies wait for provider completion and monitor without forwarding OAuth tokens", async () => {
  const root = { id: "root", name: "Drive", folder: {}, eTag: '"root-version"' };
  const archive = { ...root, id: "archive", name: "Archive", parentReference: { id: root.id, driveId: "drive" } };
  const file = { id: "source", name: "Large.bin", size: 4 * 1024 ** 3, eTag: '"file-version"', file: { mimeType: "application/octet-stream" }, parentReference: { id: root.id, driveId: "drive" } };
  const copied = { ...file, id: "copy", parentReference: { id: archive.id, driveId: "drive" } };
  const monitor = "https://fixture.sharepoint.com/_api/v2.0/monitor/copy-job";
  const { request, calls } = transport((url, options) => {
    if (url.pathname.endsWith("/copy") && options.method === "POST") return new Response(null, { status: 202, headers: { location: monitor } });
    if (url.pathname.endsWith("/children")) return Response.json({ value: url.pathname.includes("/archive/") ? [] : [archive, file] });
    if (url.pathname.endsWith("/drive")) return Response.json({ id: "drive" });
    return Response.json(url.pathname.endsWith("/source") ? file : url.pathname.endsWith("/archive") ? archive : url.pathname.endsWith("/copy") && options.method !== "POST" ? copied : root);
  }, "https://graph.microsoft.com");
  // The job completes only on the second poll; metadata reads then expose its new identity.
  let polls = 0;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(input)).toBe(monitor); expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.redirect).toBe("manual");
    return Response.json(++polls === 1 ? { status: "inProgress" } : { status: "completed", resourceId: copied.id }, { status: 202 });
  }, { preconnect: nativeFetch.preconnect });
  const adapter = await microsoftStorageAdapter({ kind: "oauth", provider: "onedrive", root: "", accountId: "account" }, request);
  await transferEntry(adapter, adapter, { path: nativeSegment(file), kind: "file", destinationId: "same", destinationPath: nativeSegment(archive), mode: "copy" }, true);
  expect(polls).toBe(2);
  const submission = calls.find(call => call.options.method === "POST")!;
  expect(submission.url.searchParams.get("@microsoft.graph.conflictBehavior")).toBe("fail");
  expect(submission.options.body).toEqual({ name: file.name, parentReference: { id: archive.id, driveId: "drive" } });
});

test("Microsoft copy monitoring rejects hostile URLs and permission changes without leaking credentials", async () => {
  let external = 0;
  globalThis.fetch = Object.assign(async () => { external++; throw new Error("Unexpected external fetch"); }, { preconnect: nativeFetch.preconnect });
  for (const location of ["http://127.0.0.1/monitor/job", "https://attacker.test/monitor/job", "https://fixture.sharepoint.com/content", "https://USER:PASSWORD@fixture.sharepoint.com/monitor/job"]) {
    const { request } = transport(() => new Response(null, { status: 202, headers: { location } }));
    await expect(microsoftCopy(request, "/copy", "target", "drive", "Report.docx", "https://graph.microsoft.com", false)).rejects.toMatchObject({ code: "storage_invalid_response" });
  }
  const { request } = transport(() => new Response(null, { status: 202, headers: { location: "https://fixture.sharepoint.com/monitor/job" } }));
  request.assertWrite = async () => { throw new ApiError(403, "storage_read_only", "Write permission changed"); };
  await expect(microsoftCopy(request, "/copy", "target", "drive", "Report.docx", "https://graph.microsoft.com", false)).rejects.toMatchObject({ code: "storage_read_only" });
  expect(external).toBe(0);
});

test("Microsoft asynchronous conflicts fail instead of reporting success or overwriting the destination", async () => {
  const { request, calls } = transport(() => new Response(null, { status: 202, headers: { location: "https://fixture.sharepoint.com/monitor/job" } }));
  globalThis.fetch = Object.assign(async () => Response.json({ status: "failed", error: { code: "nameAlreadyExists" } }), { preconnect: nativeFetch.preconnect });
  await expect(microsoftCopy(request, "/copy", "target", "drive", "Report.docx", "https://graph.microsoft.com", true)).rejects.toMatchObject({ code: "storage_conflict" });
  expect(calls[0]?.url.searchParams.has("@microsoft.graph.conflictBehavior")).toBe(false);
});

test("Microsoft completion redirects return only an item identity without following the URL", async () => {
  const { request } = transport(() => new Response(null, { status: 202, headers: { location: "https://api.onedrive.com/monitor/job" } }));
  let polls = 0;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(input)).toBe("https://api.onedrive.com/monitor/job");
    expect(init?.redirect).toBe("manual"); polls++;
    return new Response(null, { status: 303, headers: { location: "https://graph.microsoft.com/v1.0/drives/drive/items/copied%21item" } });
  }, { preconnect: nativeFetch.preconnect });
  expect(await microsoftCopy(request, "/copy", "target", "drive", "Report.docx", "https://graph.microsoft.com", true)).toBe("copied!item");
  expect(polls).toBe(1);
});
