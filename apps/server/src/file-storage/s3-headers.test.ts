import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageInputSchema, storageRequestHeadersSchema } from "./schema.js";
import { s3Adapter } from "./object-storage.js";

describe("S3 request headers", () => {
  test("parses optional headers without exposing values in validation errors", () => {
    expect(storageRequestHeadersSchema.parse("")).toEqual({});
    expect(
      storageRequestHeadersSchema.parse("X-Return-Missing-Metadata: true\r\n\nX-Api-Key: key:with:colons"),
    ).toEqual({
      "x-return-missing-metadata": "true",
      "x-api-key": "key:with:colons",
    });
    for (const value of [
      "Missing-colon",
      "X-Key:",
      "Bad Name: secret",
      "X-Key: one\nx-key: two",
      "X-Key: secret\rInjected: true",
      "X-Key: secret\0",
      "X-Key: secret\x7f",
      "Authorization: secret",
      "Host: secret",
      "Content-Length: 0",
      "If-Match: secret",
      "X-Amz-Security-Token: secret",
      "Transfer-Encoding: secret",
      "X-Key: " + "s".repeat(16_384),
      Array.from({ length: 21 }, (_, i) => `X-Key-${i}: secret`).join("\n"),
    ]) {
      const parsed = storageInputSchema.safeParse({
        name: "S3",
        config: { kind: "s3", bucket: "test", region: "us-east-1" },
        secrets: { requestHeaders: value },
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].path).toEqual(["secrets", "requestHeaders"]);
        expect(parsed.error.message).not.toContain(value);
      }
    }
  });

  test("signs headers on listing, search, reads, streamed uploads, saves and retries", async () => {
    const requests: { method: string; url: URL; headers: Headers; body: string }[] = [];
    let retried = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({ method: request.method, url, headers: request.headers, body: await request.text() });
        if (!retried) {
          retried = true;
          return new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 });
        }
        const headers = { etag: '"version"', "content-type": "text/plain" };
        if (url.searchParams.has("list-type"))
          return new Response(
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListBucketResult>',
            { headers: { "content-type": "application/xml" } },
          );
        return new Response(request.method === "GET" ? "draft" : null, { headers });
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "s3-headers-"));
    const adapter = s3Adapter(
      storageInputSchema.parse({
        name: "S3",
        config: {
          kind: "s3",
          endpoint: `http://127.0.0.1:${server.port}`,
          bucket: "test",
          region: "us-east-1",
          forcePathStyle: true,
          accessKeyId: "fixture-id",
        },
        secrets: {
          secretAccessKey: "fixture-secret",
          requestHeaders: "X-Return-Missing-Metadata: true\nX-Api-Key: fixture-key",
        },
      }),
    );
    try {
      if (!adapter.search || !adapter.listFiles) throw new Error("S3 must support metadata search");
      await adapter.list("folder", "page-2");
      await adapter.search({ mode: "path_prefix", query: "note", path: "folder" });
      await adapter.listFiles("folder");
      await adapter.stat("folder/note.txt");
      expect((await adapter.read("folder/note.txt")).data.toString()).toBe("draft");
      await adapter.download("folder/note.txt", join(directory, "download.txt"));
      expect(await readFile(join(directory, "download.txt"), "utf8")).toBe("draft");
      await adapter.write("folder/note.txt", Buffer.from("saved"), "text/plain", { version: '"version"' });
      await writeFile(join(directory, "upload.txt"), "uploaded");
      await adapter.upload("folder/new.txt", join(directory, "upload.txt"), "text/plain", { createOnly: true });
      await adapter.mkdir("folder/new");
      expect(requests).toHaveLength(10);
      for (const { headers } of requests) {
        expect(headers.get("x-return-missing-metadata")).toBe("true");
        expect(headers.get("x-api-key")).toBe("fixture-key");
        const signed = headers
          .get("authorization")
          ?.match(/SignedHeaders=([^,]+)/)?.[1]
          .split(";");
        expect(signed).toContain("x-return-missing-metadata");
        expect(signed).toContain("x-api-key");
      }
      expect(requests[0].url.searchParams.get("prefix")).toBe("folder/");
      expect(requests[0].url.searchParams.get("delimiter")).toBe("/");
      expect(requests[0].url.searchParams.get("continuation-token")).toBe("page-2");
      const saved = requests.find(({ method, url }) => method === "PUT" && url.pathname.endsWith("/note.txt"));
      expect(saved?.headers.get("if-match")).toBe('"version"');
      expect(saved?.body).toContain("saved");
      expect(requests.find(({ url }) => url.pathname.endsWith("/new.txt"))?.headers.get("if-none-match")).toBe("*");
    } finally {
      await adapter.close?.();
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
