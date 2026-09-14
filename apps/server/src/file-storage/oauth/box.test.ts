import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { boxAdapter, boxProvider } from "./box.js";

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function requests(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (...[input, init]: Parameters<typeof fetch>) => handler(new URL(input instanceof Request ? input.url : input), init), globalThis.fetch));
  restore = () => mock.mockRestore();
}
const root = { id: "10", type: "folder", name: "Firm" };
const file = { id: "20", type: "file", name: "matter.txt", etag: "2", size: 4 };
test("Box browses marker pages and scopes native search to the connected folder", async () => {
  requests((url) => {
    if (url.pathname === "/2.0/folders/10") return Response.json(root);
    if (url.pathname.endsWith("/items")) {
      if (url.searchParams.has("marker")) { expect(url.searchParams.get("marker")).toBe("next"); return Response.json({ entries: [file] }); }
      return Response.json({ entries: [], next_marker: "next" });
    }
    expect(url.searchParams.get("ancestor_folder_ids")).toBe("10");
    expect(url.searchParams.get("content_types")).toBe("name,file_content");
    return Response.json({ entries: [
      { ...file, path_collection: { entries: [{ id: "0", name: "All files" }, root, { id: "11", name: "Matter" }] } },
      { ...file, id: "21", path_collection: { entries: [{ id: "0", name: "All files" }, { id: "99", name: "Outside" }] } },
    ], offset: 0, limit: 100, total_count: 101 });
  });
  const adapter = await boxAdapter({ kind: "oauth", provider: "box", root: "https://app.box.com/folder/10" }, async () => "token");
  expect((await adapter.list("")).nextCursor).toBe("next");
  expect((await adapter.list("", "next")).entries[0]?.path).toBe("matter.txt");
  const found = await adapter.search!({ path: "", query: "matter", mode: "content" });
  expect(found.entries.map((entry) => entry.path)).toEqual(["Matter/matter.txt"]);
  expect(found.nextCursor).toBe("100");
  expect((await adapter.searchCapabilities!()).modes).toEqual(["name", "content"]);
});
test("Box refuses stale saves and conflicting create-only uploads", async () => {
  let writes = 0;
  requests((url, init) => {
    if (init?.method === "POST") { writes++; return Response.json({ entries: [file] }, { status: 201 }); }
    if (url.pathname.endsWith("/10")) return Response.json(root);
    return Response.json({ entries: [file] });
  });
  const adapter = await boxAdapter({ kind: "oauth", provider: "box", root: "10" }, async () => "token");
  await expect(adapter.write("matter.txt", Buffer.from("test"), "text/plain", { version: "1" })).rejects.toThrow();
  await expect(adapter.write("matter.txt", Buffer.from("test"), "text/plain", { createOnly: true })).rejects.toThrow();
  expect(writes).toBe(0);
  await adapter.write("matter.txt", Buffer.from("test"), "text/plain", { version: "2" });
  expect(writes).toBe(1);
});
test("Box download follows signed links without forwarding credentials and rejects foreign hosts", async () => {
  let foreign = false;
  requests((url, init) => {
    if (url.hostname === "dl.boxcloud.com") { expect(new Headers(init?.headers).has("authorization")).toBe(false); return new Response("test"); }
    if (url.pathname.endsWith("/10")) return Response.json(root);
    if (url.pathname.endsWith("/items")) return Response.json({ entries: [file] });
    return new Response(null, { status: 302, headers: { location: foreign ? "https://evil.example/download" : "https://dl.boxcloud.com/download" } });
  });
  const adapter = await boxAdapter({ kind: "oauth", provider: "box", root: "10" }, async () => "private-token");
  expect((await adapter.read("matter.txt")).data.toString()).toBe("test");
  foreign = true;
  await expect(adapter.read("matter.txt")).rejects.toThrow("unexpected response");
});
test("Box large uploads commit bounded parts with checksums and conditional versions", async () => {
  let parts = 0;
  let committed = false;
  requests((url, init) => {
    if (url.pathname.endsWith("/10")) return Response.json(root);
    if (url.pathname.endsWith("/items")) return Response.json({ entries: [file] });
    if (url.pathname.endsWith("/20/upload_sessions")) return Response.json({ id: "session", part_size: 8 * 1024 * 1024 }, { status: 201 });
    if (init?.method === "PUT") {
      const body = init.body;
      if (!(body instanceof Uint8Array)) throw new Error("Expected a binary chunk");
      expect(body.length).toBeLessThanOrEqual(8 * 1024 * 1024);
      const digest = createHash("sha1").update(body);
      expect(new Headers(init.headers).get("digest")).toBe(`sha=${digest.digest("base64")}`);
      const offset = parts++ * 8 * 1024 * 1024;
      return Response.json({ part: { part_id: String(parts), offset, size: body.length, sha1: createHash("sha1").update(body).digest("hex") } });
    }
    expect(url.pathname.endsWith("/commit")).toBe(true);
    expect(new Headers(init?.headers).get("If-Match")).toBe("2");
    committed = true;
    return Response.json({ entries: [file] }, { status: 201 });
  });
  const adapter = await boxAdapter({ kind: "oauth", provider: "box", root: "10" }, async () => "token");
  await adapter.write("matter.txt", Buffer.alloc(24 * 1024 * 1024, 3), "text/plain", { version: "2" });
  expect(parts).toBe(3); expect(committed).toBe(true);
});
test("Box provider exposes least-privilege scopes and no embedded application secret", () => {
  expect(boxProvider.scopes(true)).toEqual(["root_readonly"]);
  expect(boxProvider.scopes(false)).toEqual(["root_readwrite"]);
  expect(boxProvider.clientSecret).toBeUndefined();
});
test("Box renames files and folders with version guards and deletes only files", async () => {
  const folder = { id: "30", type: "folder", name: "Matter", etag: "4" };
  const mutations: { path: string; method: string; version: string | null; body: unknown }[] = [];
  requests((url, init) => {
    if (init?.method === "PUT" || init?.method === "DELETE") {
      mutations.push({ path: url.pathname, method: init.method, version: new Headers(init.headers).get("If-Match"), body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(file);
    }
    if (url.pathname === "/2.0/folders/10") return Response.json(root);
    return Response.json({ entries: [file, folder] });
  });
  const adapter = await boxAdapter({ kind: "oauth", provider: "box", root: "10" }, async () => "token");
  await adapter.rename!("matter.txt", "Renamed.txt", "file");
  await adapter.rename!("Matter", "Renamed folder", "folder");
  await adapter.deleteFile!("matter.txt");
  await expect(adapter.deleteFile!("Matter")).rejects.toMatchObject({ code: "storage_not_a_file" });
  await expect(adapter.rename!("matter.txt", "Matter", "file")).rejects.toMatchObject({ code: "storage_conflict" });
  expect(mutations).toEqual([
    { path: "/2.0/files/20", method: "PUT", version: "2", body: { name: "Renamed.txt" } },
    { path: "/2.0/folders/30", method: "PUT", version: "4", body: { name: "Renamed folder" } },
    { path: "/2.0/files/20", method: "DELETE", version: "2", body: null },
  ]);
});
test("Box folder deletion is recursive, version guarded, and cannot delete the connection root", async () => {
  let deleted = false;
  requests((url, init) => {
    if (init?.method === "DELETE") {
      expect(url.pathname).toBe("/2.0/folders/30");
      expect(url.searchParams.get("recursive")).toBe("true");
      expect(new Headers(init.headers).get("If-Match")).toBe("4");
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/2.0/folders/10") return Response.json(root);
    return Response.json({ entries: [file, { id: "30", type: "folder", name: "Matter", etag: "4" }] });
  });
  const adapter = await boxAdapter({ kind: "oauth", provider: "box", root: "10" }, async () => "token");
  await expect(adapter.deleteFolder!("")).rejects.toThrow();
  await expect(adapter.deleteFolder!("matter.txt")).rejects.toMatchObject({ code: "storage_not_a_folder" });
  expect(deleted).toBe(false);
  await adapter.deleteFolder!("Matter");
  expect(deleted).toBe(true);
});
