import { describe, expect, test } from "bun:test";
import { createClient } from "webdav";
import { webdavSearch } from "./webdav-search.js";

const multi = (body: string) => `<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;
const schema = multi(
  `<d:response><d:href>/root/</d:href><d:status>HTTP/1.1 200 OK</d:status><d:query-schema><d:basicsearchschema><d:properties><d:propdesc><d:prop><d:displayname/></d:prop><d:searchable/></d:propdesc></d:properties><d:operators><d:opdesc><d:like/></d:opdesc><d:opdesc><d:contains/></d:opdesc></d:operators></d:basicsearchschema></d:query-schema></d:response>`,
);
const item = (href: string, status = "200 OK") =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>note.txt</d:displayname><d:resourcetype/><d:getcontentlength>12</d:getcontentlength></d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat></d:response>`;

async function fixture(
  run: (adapter: ReturnType<typeof webdavSearch>, requests: string[]) => Promise<void>,
  options: { dasl?: boolean; qsdStatus?: number; search?: string; searchStatus?: number } = {},
) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/root/");
      if (request.method === "OPTIONS")
        return new Response(null, { headers: options.dasl === false ? {} : { DASL: "<DAV:basicsearch>" } });
      const body = await request.text();
      requests.push(body);
      if (body.includes("query-schema-discovery")) return new Response(schema, { status: options.qsdStatus ?? 207 });
      return new Response(options.search ?? multi(item("/root/nested/note.txt")), {
        status: options.searchStatus ?? 207,
      });
    },
  });
  try {
    const endpoint = `http://127.0.0.1:${server.port}/root`;
    await run(webdavSearch(createClient(endpoint), endpoint), requests);
  } finally {
    await server.stop(true);
  }
}

describe("WebDAV native SEARCH contract", () => {
  test("discovers advertised operators and emits scoped, escaped literal queries", async () => {
    await fixture(async (adapter, requests) => {
      expect(await adapter.searchCapabilities()).toEqual({ modes: ["name", "content"], pagination: false });
      const page = await adapter.search({ mode: "name", query: '50%_&<"', path: "nested" });
      expect(page.entries.map((entry) => entry.path)).toEqual(["nested/note.txt"]);
      expect(requests.at(-1)).toContain("/root/nested/</d:href>");
      expect(requests.at(-1)).toContain("50\\%\\_&amp;&lt;&quot;");
      expect(requests.at(-1)).toContain("<d:nresults>100</d:nresults>");
      await adapter.search({ mode: "content", query: "a & b", path: "nested" });
      expect(requests.at(-1)).toContain("<d:contains>a &amp; b</d:contains>");
      await expect(adapter.search({ mode: "name", query: "note", path: "", cursor: "next" })).rejects.toMatchObject({
        code: "storage_search_cursor_unsupported",
      });
    });
  });
  test("does not guess search support or fall back to recursive folder scans", async () => {
    await fixture(
      async (adapter, requests) => {
        expect((await adapter.searchCapabilities()).modes).toEqual([]);
        await expect(adapter.search({ mode: "content", query: "note", path: "" })).rejects.toMatchObject({
          code: "storage_search_unsupported",
        });
        expect(requests).toEqual([]);
      },
      { dasl: false },
    );
  });
  test("probes optional operators when query schema discovery is unavailable", async () => {
    await fixture(
      async (adapter, requests) => {
        expect((await adapter.searchCapabilities()).modes).toEqual(["name", "content"]);
        expect(requests).toHaveLength(3);
        expect(requests[1]).toContain("<d:nresults>1</d:nresults>");
      },
      { qsdStatus: 501, search: multi("") },
    );
    await fixture(
      async (adapter) => {
        expect((await adapter.searchCapabilities()).modes).toEqual([]);
      },
      { qsdStatus: 405, searchStatus: 422 },
    );
  });
  test("filters denied files, foreign URLs and sibling roots; reports partial results", async () => {
    const search = multi(
      item("/root/nested/note.txt") +
        item("/root/nested/secret.txt", "403 Forbidden") +
        item("/root-other/note.txt") +
        item("/root/sibling/note.txt") +
        item("https://foreign.invalid/root/nested/note.txt") +
        `<d:response><d:href>/root/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>`,
    );
    await fixture(
      async (adapter) => {
        const result = await adapter.search({ mode: "name", query: "note", path: "nested" });
        expect(result.entries.map((entry) => entry.path)).toEqual(["nested/note.txt"]);
        expect(result.truncated).toBe(true);
      },
      { search },
    );
  });
  test("rejects hostile XML and oversized responses", async () => {
    for (const search of [
      '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]>' + multi(""),
      multi("x".repeat(2 * 1024 * 1024)),
    ]) {
      await fixture(
        async (adapter) => {
          await expect(adapter.search({ mode: "name", query: "note", path: "" })).rejects.toMatchObject({
            code: "storage_search_invalid_response",
          });
        },
        { search },
      );
    }
  });
  test("marks failed subrequests as incomplete even without a 507 status", async () => {
    await fixture(
      async (adapter) => {
        const result = await adapter.search({ mode: "name", query: "note", path: "" });
        expect(result.entries).toEqual([]);
        expect(result.truncated).toBe(true);
      },
      { search: multi(item("/root/note.txt", "403 Forbidden")) },
    );
  });
});
