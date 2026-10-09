import { hashVersion } from "../common.js";

/** Local reference service for exercising the real WebDAV adapter without external accounts. */
export function webdavFixture(delayMs = 0) {
  const folders = new Set(["", "first", "second", "readonly", "first/matter", "first/matter/nested", "first/matter/empty", "first/archive"]);
  const files = new Map([
    ["first/matter/a.txt", Buffer.from("alpha")],
    ["first/matter/nested/b.txt", Buffer.from("beta")],
    ["first/note.txt", Buffer.from("note")],
    ["readonly/reference.txt", Buffer.from("reference")],
  ]);
  const parent = (path: string) => path.split("/").slice(0, -1).join("/");
  const etag = (path: string) => `"${hashVersion(files.get(path) ?? Buffer.alloc(0))}"`;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (delayMs && ["GET", "PUT"].includes(request.method)) await Bun.sleep(delayMs);
      const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/|\/$/g, "");
      const exists = folders.has(path) || files.has(path);
      if (request.method === "PROPFIND") {
        if (!exists) return new Response(null, { status: 404 });
        const paths = [path, ...(request.headers.get("depth") !== "0" && folders.has(path)
          ? [...folders, ...files.keys()].filter((item) => item !== path && parent(item) === path) : [])];
        const xml = paths.map((item) => `<d:response><d:href>/${item.split("/").map(encodeURIComponent).join("/")}${folders.has(item) && item ? "/" : ""}</d:href><d:propstat><d:prop><d:resourcetype>${folders.has(item) ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${files.get(item)?.length ?? 0}</d:getcontentlength><d:getetag>${etag(item)}</d:getetag><d:getcontenttype>text/plain</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
        return new Response(`<d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`, { status: 207, headers: { "content-type": "application/xml" } });
      }
      const match = request.headers.get("if-match");
      if ((match && match !== etag(path)) || (request.headers.get("if-none-match") === "*" && exists))
        return new Response(null, { status: 412 });
      if (request.method === "GET") {
        const data = files.get(path);
        return data ? new Response(data, { headers: { etag: etag(path), "content-type": "text/plain" } }) : new Response(null, { status: 404 });
      }
      if (request.method === "PUT") {
        if (!folders.has(parent(path))) return new Response(null, { status: 409 });
        files.set(path, Buffer.from(await request.arrayBuffer()));
        return new Response(null, { status: 201 });
      }
      if (request.method === "MKCOL") {
        if (exists) return new Response(null, { status: 405 });
        if (!folders.has(parent(path))) return new Response(null, { status: 409 });
        folders.add(path); return new Response(null, { status: 201 });
      }
      if (request.method === "MOVE") {
        if (!exists) return new Response(null, { status: 404 });
        const destination = decodeURIComponent(new URL(request.headers.get("destination")!).pathname).replace(/^\/|\/$/g, "");
        if (!folders.has(parent(destination))) return new Response(null, { status: 409 });
        if (folders.has(destination) || files.has(destination)) return new Response(null, { status: 412 });
        for (const item of [...folders]) if (item === path || item.startsWith(`${path}/`)) { folders.delete(item); folders.add(destination + item.slice(path.length)); }
        for (const [item, data] of [...files]) if (item === path || item.startsWith(`${path}/`)) { files.delete(item); files.set(destination + item.slice(path.length), data); }
        return new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        if (!exists) return new Response(null, { status: 404 });
        for (const item of [...folders]) if (item === path || item.startsWith(`${path}/`)) folders.delete(item);
        for (const item of [...files.keys()]) if (item === path || item.startsWith(`${path}/`)) files.delete(item);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  });
  return { server, files, folders, endpoint: `http://127.0.0.1:${server.port}` };
}
