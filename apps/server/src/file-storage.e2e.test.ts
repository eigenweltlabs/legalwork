import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { LegalWorkStorageTools } from "./opencode-plugins/legalwork-storage-tools.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { Storage } from "@google-cloud/storage";
import {
  STORAGE_MAX_FILE_BYTES,
  storageInputSchema,
  type StorageInput,
  type StoragePage,
} from "@legalwork/types/file-storage";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { withStorage } from "./file-storage/service.js";
import { StorageStore, mergeStorageSecrets } from "./file-storage/store.js";
import { storagePath, providerError } from "./file-storage/common.js";

let temporary: string;
let rootPath: string;
let config: ServerConfig;
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let viewerToken: string;
const priorEnv = { ...process.env };
const idSchema = z.object({ connection: z.object({ id: z.string() }) });
const fileSchema = z.object({ dataBase64: z.string(), version: z.string(), writable: z.boolean() });
const rootSchema = z.object({ roots: z.array(z.object({ id: z.string(), name: z.string(), writable: z.boolean() })) });
const tokenSchema = z.object({ token: z.string() });
const offlineInput = () =>
  storageInputSchema.parse({ name: "Firm WebDAV", config: { kind: "webdav", endpoint: "http://127.0.0.1:1" } });

async function api(
  method: string,
  suffix: string,
  body?: unknown,
  scope: "owner" | "collaborator" | "viewer" | "none" = "owner",
  workspaceId = "storage-test",
) {
  const response = await fetch(`${base}/workspace/${workspaceId}/storage${suffix}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(scope !== "none" ? { authorization: `Bearer ${scope === "viewer" ? viewerToken : config.token}` } : {}),
      ...(scope === "owner" ? { "x-legalwork-host-token": config.hostToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}
async function connect(input: StorageInput) {
  const response = await api("POST", "", input);
  expect(response.status).toBe(201);
  return idSchema.parse(await response.json()).connection.id;
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "legalwork-storage-tests-"));
  rootPath = join(temporary, "share");
  await mkdir(rootPath, { recursive: true });
  for (const key of [
    "LEGALWORK_STORAGE_STORE",
    "LEGALWORK_TOKEN_STORE",
    "LEGALWORK_RUNTIME_DB",
    "LEGALWORK_ENV_STORE",
    "LEGALWORK_DATA_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ])
    process.env[key] = join(temporary, key);
  config = {
    host: "127.0.0.1",
    port: 0,
    token: "storage-test-client",
    hostToken: "storage-test-owner",
    configPath: join(temporary, "config.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "storage-test", name: "Storage", path: temporary, preset: "default", workspaceType: "local" },
      { id: "other-workspace", name: "Other", path: rootPath, preset: "default", workspaceType: "local" },
    ],
    authorizedRoots: [temporary],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  server = await startServer(config);
  base = `http://127.0.0.1:${server.port}`;
  process.env.LEGALWORK_SERVER_URL = base;
  process.env.LEGALWORK_SERVER_TOKEN = config.token;
  const issued = await fetch(`${base}/tokens`, {
    method: "POST",
    headers: { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" },
    body: JSON.stringify({ scope: "viewer", label: "storage-test" }),
  });
  viewerToken = tokenSchema.parse(await issued.json()).token;
});
afterAll(async () => {
  await server?.stop();
  await rm(temporary, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
  Object.assign(process.env, priorEnv);
});

describe("storage API access and validation", () => {
  test("requires authentication and owner access for managing connections", async () => {
    expect((await api("POST", "/missing/filename-search", { query: "file" }, "none")).status).toBe(401);
    expect((await api("GET", "/roots", undefined, "none")).status).toBe(401);
    expect((await api("POST", "", offlineInput(), "collaborator")).status).toBe(401);
    expect((await api("GET", "", undefined, "viewer")).status).toBe(401);
  });
  test("keeps roots lazy even if a provider is offline, and scopes them to a workspace", async () => {
    const id = await connect(
      storageInputSchema.parse({
        name: "Offline WebDAV",
        config: { kind: "webdav", endpoint: "http://127.0.0.1:1" },
        secrets: { password: "never-return-this-secret" },
      }),
    );
    const roots = rootSchema.parse(await (await api("GET", "/roots")).json());
    expect(roots.roots.some((root) => root.id === id)).toBe(true);
    expect(
      rootSchema.parse(await (await api("GET", "/roots", undefined, "owner", "other-workspace")).json()).roots,
    ).toEqual([]);
    expect((await api("GET", `/${id}/children`, undefined, "owner", "other-workspace")).status).toBe(404);
    const list = await (await api("GET", "")).text();
    expect(list).not.toContain("never-return-this-secret");
    expect(list).toContain("configuredSecrets");
    const tested = await api(
      "POST",
      `/test?connectionId=${id}`,
      storageInputSchema.parse({ name: "Offline WebDAV", config: { kind: "webdav", endpoint: "http://127.0.0.1:1" } }),
    );
    expect(tested.status).toBe(502);
    expect(await tested.text()).not.toContain("never-return-this-secret");
    await api("DELETE", `/${id}`);
  });
  test("persists credentials with restricted permissions; merges and clears secrets", async () => {
    const input = storageInputSchema.parse({
      name: "Credentials",
      config: { kind: "s3", bucket: "test", region: "eu-central-1", accessKeyId: "test" },
      secrets: { secretAccessKey: "private" },
    });
    const id = await connect(input);
    const store = new StorageStore(config);
    const previous = await store.get("storage-test", id);
    expect(mergeStorageSecrets({ ...input, secrets: {} }, previous).secrets.secretAccessKey).toBe("private");
    expect(mergeStorageSecrets({ ...input, secrets: { secretAccessKey: "" } }, previous).secrets.secretAccessKey).toBe(
      "",
    );
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await new StorageStore(config).get("storage-test", id)).secrets.secretAccessKey).toBe("private");
    await api("DELETE", `/${id}`);
  });
  test("allows reading a WebDAV file with a weak ETag without offering unsafe edits", async () => {
    const dav = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.method === "PROPFIND")
          return new Response(
            `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/note.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>4</d:getcontentlength><d:getetag>W/"weak"</d:getetag><d:getcontenttype>text/plain</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
            { status: 207, headers: { "content-type": "application/xml" } },
          );
        return request.headers.has("if-match")
          ? new Response(null, { status: 412 })
          : new Response("read", { headers: { etag: 'W/"weak"' } });
      },
    });
    let id: string | undefined;
    try {
      id = await connect(
        storageInputSchema.parse({
          name: "Weak ETag server",
          config: { kind: "webdav", endpoint: `http://127.0.0.1:${dav.port}` },
        }),
      );
      const result = await api("GET", `/${id}/file?path=note.txt`);
      expect(result.status).toBe(200);
      const file = fileSchema.parse(await result.json());
      expect(Buffer.from(file.dataBase64, "base64").toString()).toBe("read");
      expect(file.writable).toBe(false);
      expect(
        (await api("PUT", `/${id}/file`, { path: "note.txt", dataBase64: "eA==", version: file.version })).status,
      ).toBe(409);
    } finally {
      if (id) await api("DELETE", `/${id}`);
      await dav.stop(true);
    }
  });
  test("rejects stale WebDAV edits even when the provider reuses a strong ETag", async () => {
    let content = "draft one";
    let writes = 0;
    const dav = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "PROPFIND")
          return new Response(
            `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/note.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${content.length}</d:getcontentlength><d:getetag>"fixed"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
            { status: 207 },
          );
        expect(request.headers.get("if-match")).toBe('"fixed"');
        if (request.method === "PUT") {
          content = await request.text();
          writes++;
          return new Response(null, { status: 204 });
        }
        return new Response(content, { headers: { etag: '"fixed"' } });
      },
    });
    let id: string | undefined;
    try {
      id = await connect(
        storageInputSchema.parse({
          name: "Coarse ETag fixture",
          config: { kind: "webdav", endpoint: `http://127.0.0.1:${dav.port}` },
        }),
      );
      const original = fileSchema.parse(await (await api("GET", `/${id}/file?path=note.txt`)).json());
      const body = {
        path: "note.txt",
        dataBase64: Buffer.from("draft two").toString("base64"),
        version: original.version,
      };
      expect((await api("PUT", `/${id}/file`, body)).status).toBe(200);
      expect(
        (await api("PUT", `/${id}/file`, { ...body, dataBase64: Buffer.from("old draft").toString("base64") })).status,
      ).toBe(409);
      expect(writes).toBe(1);
      expect(content).toBe("draft two");
    } finally {
      if (id) await api("DELETE", `/${id}`);
      await dav.stop(true);
    }
  });
  test("rejects local folder connections and ignores legacy records without breaking other storage", async () => {
    const input = offlineInput();
    const id = await connect(input);
    const local = { name: "Removed local folder", config: { kind: "local", rootPath } };
    expect(storageInputSchema.safeParse(local).success).toBe(false);
    expect((await api("POST", "", local)).status).toBe(400);
    expect((await api("POST", "/test", local)).status).toBe(400);
    expect((await api("PUT", `/${id}`, local)).status).toBe(400);
    const store = new StorageStore(config);
    const entries = z.array(z.unknown()).parse(JSON.parse(await readFile(store.path, "utf8")));
    const legacyId = "8d59f1d1-f435-4515-b0f1-06f50eeef487";
    await writeFile(
      store.path,
      JSON.stringify([
        ...entries,
        {
          ...local,
          id: legacyId,
          workspaceId: "storage-test",
          updatedAt: Date.now(),
          secrets: {},
          enabled: true,
          readOnly: false,
        },
      ]),
    );
    expect((await store.list("storage-test")).map((item) => item.id)).toEqual([id]);
    expect(rootSchema.parse(await (await api("GET", "/roots")).json()).roots.map((item) => item.id)).toEqual([id]);
    expect((await api("GET", `/${legacyId}/children`)).status).toBe(404);
    expect((await api("GET", `/${legacyId}/file?path=anything.txt`)).status).toBe(404);
    await api("PUT", `/${id}`, input);
    expect(await readFile(store.path, "utf8")).not.toContain(legacyId);
    await api("DELETE", `/${id}`);
  });
  test("rejects oversized WebDAV metadata before downloading the file", async () => {
    let downloads = 0;
    const dav = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.method === "PROPFIND")
          return new Response(
            `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/large.bin</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${STORAGE_MAX_FILE_BYTES + 1}</d:getcontentlength><d:getetag>"large"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
            { status: 207, headers: { "content-type": "application/xml" } },
          );
        downloads++;
        return new Response(null, { status: 500 });
      },
    });
    let id: string | undefined;
    try {
      id = await connect(
        storageInputSchema.parse({
          name: "Oversized response fixture",
          config: { kind: "webdav", endpoint: `http://127.0.0.1:${dav.port}` },
        }),
      );
      expect((await api("GET", `/${id}/file?path=large.bin`)).status).toBe(413);
      expect(downloads).toBe(0);
    } finally {
      if (id) await api("DELETE", `/${id}`);
      await dav.stop(true);
    }
  });
  test("enforces read-only and viewer permissions, disabled connections and removal", async () => {
    const input = offlineInput();
    const id = await connect(input);
    expect((await api("POST", `/${id}/folders`, { path: "forbidden" }, "viewer")).status).toBe(403);
    expect(
      rootSchema
        .parse(await (await api("GET", "/roots", undefined, "viewer")).json())
        .roots.find((root) => root.id === id)?.writable,
    ).toBe(false);
    await api("PUT", `/${id}`, { ...input, readOnly: true });
    expect((await api("POST", `/${id}/folders`, { path: "forbidden" })).status).toBe(403);
    config.readOnly = true;
    expect((await api("POST", "", input)).status).toBe(403);
    config.readOnly = false;
    await api("PUT", `/${id}`, { ...input, enabled: false });
    expect(rootSchema.parse(await (await api("GET", "/roots")).json()).roots.some((root) => root.id === id)).toBe(
      false,
    );
    expect((await api("POST", `/${id}/filename-search`, { query: "file" })).status).toBe(409);
    expect((await api("GET", `/${id}/children`)).status).toBe(409);
    await api("DELETE", `/${id}`);
    expect((await api("GET", `/${id}/children`)).status).toBe(404);
  });
  test("local copies honor manual workspace approval, including read-only connections", async () => {
    const id = await connect({ ...offlineInput(), readOnly: true });
    await writeFile(join(temporary, "approval-source.txt"), "kept locally");
    config.approval.mode = "manual";
    try {
      const pending = api("POST", `/${id}/local-copy`, {
        localPath: "approval-source.txt",
        targetPath: "approval-destination.txt",
      });
      const headers = { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" };
      let approvalId: string | undefined;
      for (let attempt = 0; attempt < 30 && !approvalId; attempt++) {
        const result = z
          .object({ items: z.array(z.object({ id: z.string() })) })
          .parse(await (await fetch(`${base}/approvals`, { headers })).json());
        approvalId = result.items[0]?.id;
        if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(approvalId).toBeDefined();
      await fetch(`${base}/approvals/${approvalId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reply: "deny" }),
      });
      expect((await pending).status).toBe(403);
      await expect(readFile(join(temporary, "approval-destination.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      config.approval.mode = "auto";
      expect(
        (
          await api("POST", `/${id}/local-copy`, {
            localPath: "approval-source.txt",
            targetPath: "approval-destination.txt",
          })
        ).status,
      ).toBe(201);
      expect(await readFile(join(temporary, "approval-destination.txt"), "utf8")).toBe("kept locally");
    } finally {
      config.approval.mode = "auto";
      await api("DELETE", `/${id}`);
    }
  });
  test("rejects traversal, malformed credentials and oversized uploads before provider access", async () => {
    const id = await connect(offlineInput());
    for (const path of ["../outside", "/absolute", "a/../b", "a\\b", "a//b", "a\nDELE x"]) {
      expect((await api("POST", `/${id}/filename-search`, { query: "file", path })).status).toBe(400);
      expect(() => storagePath(path)).toThrow();
      expect((await api("GET", `/${id}/children?${new URLSearchParams({ path })}`)).status).toBe(400);
    }
    expect((await api("POST", `/${id}/file`, { path: "broken.txt", dataBase64: "%%%" })).status).toBe(400);
    expect((await api("PUT", `/${id}/file`, { path: "broken.txt", dataBase64: "eA==" })).status).toBe(400);
    const rejected = await api("POST", "", {
      name: "Bad",
      config: { kind: "webdav", endpoint: "http://user:secret@localhost" },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain("user:secret");
    expect(providerError(new Error("https://secret-token@server")).message).not.toContain("secret-token");
    expect(
      (
        await api("POST", `/${id}/file`, {
          path: "large-upload.bin",
          dataBase64: Buffer.alloc(STORAGE_MAX_FILE_BYTES + 1).toString("base64"),
        })
      ).status,
    ).toBe(413);
    await api("DELETE", `/${id}`);
  });
});

async function roundTrip(input: StorageInput) {
  const id = await connect(input);
  const folder = `test-${input.config.kind}-${Date.now()}`;
  const checked = await api("POST", `/test?connectionId=${id}`, { ...input, secrets: {} });
  expect(await checked.text()).toContain('"ok":true');
  expect((await api("POST", `/${id}/folders`, { path: folder })).status).toBe(201);
  const path = `${folder}/Müller #1${input.config.kind === "smb" ? "" : "?"}.txt`;
  const initial = Buffer.from("Initial contract text");
  const uploaded = await api("POST", `/${id}/file`, {
    path,
    dataBase64: initial.toString("base64"),
    contentType: "text/plain",
  });
  expect(await uploaded.text()).toContain('"ok":true');
  expect((await api("POST", `/${id}/file`, { path, dataBase64: "eA==" })).status).toBe(409);
  const first = fileSchema.parse(await (await api("GET", `/${id}/file?${new URLSearchParams({ path })}`)).json());
  expect(Buffer.from(first.dataBase64, "base64").toString()).toBe(initial.toString());
  expect(first.writable).toBe(true);
  const updated = await api("PUT", `/${id}/file`, {
    path,
    dataBase64: Buffer.from("Updated by a partner").toString("base64"),
    version: first.version,
  });
  expect(await updated.text()).toContain('"ok":true');
  const conflict = await api("PUT", `/${id}/file`, { path, dataBase64: "eA==", version: first.version });
  expect(conflict.status).toBe(409);
  const read = fileSchema.parse(await (await api("GET", `/${id}/file?${new URLSearchParams({ path })}`)).json());
  expect(Buffer.from(read.dataBase64, "base64").toString()).toBe("Updated by a partner");
  const saves = await Promise.all(
    ["First writer", "Second writer"].map((text) =>
      api("PUT", `/${id}/file`, { path, version: read.version, dataBase64: Buffer.from(text).toString("base64") }),
    ),
  );
  expect(saves.map((result) => result.status).sort()).toEqual([200, 409]);
  const listing = await withStorage(input, async (adapter) => {
    await adapter.mkdir(`${folder}/nested`);
    await adapter.write(`${folder}/nested/hidden.txt`, Buffer.from("hidden"), "text/plain", { createOnly: true });
    // A folder-only page exercises continuation tokens even with zero files.
    for (let index = 0; index < 105; index++) {
      const path = `${folder}/page-${String(index).padStart(3, "0")}`;
      // fake-gcs-server paginates files but returns all common prefixes together.
      if (input.config.kind === "gcs")
        await adapter.write(path, Buffer.from("page"), "text/plain", { createOnly: true });
      else await adapter.mkdir(path);
    }
    let cursor: string | undefined;
    const pages: StoragePage[] = [];
    do {
      const page: StoragePage = await adapter.list(folder, cursor);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    return { pages, nested: await adapter.list(`${folder}/nested`) };
  });
  for (const page of listing.pages) {
    expect(page.entries.every((item) => !item.path.endsWith("hidden.txt"))).toBe(true);
    expect(page.entries.length).toBeLessThanOrEqual(100);
  }
  expect(
    new Set(listing.pages.flatMap((page) => page.entries.map((item) => item.path))).size,
    JSON.stringify({
      folder,
      pages: listing.pages.map((page) => ({
        length: page.entries.length,
        nextCursor: page.nextCursor,
        names: page.entries.map((item) => item.name),
      })),
    }),
  ).toBe(107);
  expect(listing.nested.entries.map((item) => item.name)).toEqual(["hidden.txt"]);
  // Filename lookup must reach unopened descendants, even on prefix-only S3.
  const filenameResults = await api("POST", `/${id}/filename-search`, { query: "IDDEN", path: folder }, "viewer");
  expect(filenameResults.status).toBe(200);
  const filenamePage = await filenameResults.json();
  expect(filenamePage.entries.map((item: { path: string }) => item.path)).toEqual([`${folder}/nested/hidden.txt`]);
  let filenameCursor = filenamePage.nextCursor;
  let checkedFiles = filenamePage.scanned;
  while (filenameCursor) {
    const next = await api("POST", `/${id}/filename-search`, { query: "IDDEN", path: folder, cursor: filenameCursor }, "viewer");
    expect(next.status).toBe(200);
    const page = await next.json();
    expect(page.entries).toEqual([]);
    checkedFiles += page.scanned;
    filenameCursor = page.nextCursor;
  }
  expect(checkedFiles).toBe(input.config.kind === "gcs" ? 107 : 2);
  const { tool: filenameTools } = await LegalWorkStorageTools();
  const filenameToolResults = JSON.parse(await filenameTools.storage_search_filenames.execute({ connection_ids: [id, "missing-connection"], query: "IDDEN", path: folder }, { directory: temporary }));
  expect(filenameToolResults.results[0].page.entries).toEqual(filenamePage.entries);
  expect(filenameToolResults.results[1].ok).toBe(false);
  const capabilities = await (await api("GET", `/${id}/capabilities`)).json();
  expect(capabilities.write).toBe(true);
  if (["s3", "azure", "gcs"].includes(input.config.kind)) {
    expect(capabilities.search.modes).toContain("path_prefix");
    const searchQuery = new URLSearchParams({ mode: "path_prefix", path: folder, query: "nested/" });
    const found = await (await api("GET", `/${id}/search?${searchQuery}`)).json();
    expect(found.entries.map((item: { path: string }) => item.path)).toEqual([`${folder}/nested/hidden.txt`]);
    expect(
      (await api("GET", `/${id}/search?${new URLSearchParams({ mode: "path_prefix", query: "../escape" })}`)).status,
    ).toBe(400);
    let cursor: string | undefined;
    const paths: string[] = [];
    do {
      const page = await (
        await api(
          "GET",
          `/${id}/search?${new URLSearchParams({ mode: "path_prefix", query: `${folder}/`, ...(cursor ? { cursor } : {}) })}`,
        )
      ).json();
      expect(page.entries.length).toBeLessThanOrEqual(100);
      paths.push(...page.entries.map((item: { path: string }) => item.path));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paths).toContain(`${folder}/nested/hidden.txt`);
    if (input.config.kind === "gcs") {
      const names = await (
        await api("GET", `/${id}/search?${new URLSearchParams({ mode: "name", path: folder, query: "hidden" })}`)
      ).json();
      expect(names.entries.map((item: { path: string }) => item.path)).toEqual([`${folder}/nested/hidden.txt`]);
      const literal = await (
        await api("GET", `/${id}/search?${new URLSearchParams({ mode: "name", path: folder, query: "#1?" })}`)
      ).json();
      expect(literal.entries.map((item: { path: string }) => item.path)).toEqual([path]);
      const noMatch = await (
        await api("GET", `/${id}/search?${new URLSearchParams({ mode: "name", path: folder, query: "no-such-file" })}`)
      ).json();
      expect(noMatch.entries).toEqual([]);
    }
  } else if (input.config.kind === "smb") {
    expect(capabilities.search).toMatchObject({ modes: ["name"], scope: "folder", pagination: true });
    const { tool } = await LegalWorkStorageTools();
    const search = async (query: string, cursor?: string) =>
      JSON.parse(
        await tool.storage_search.execute(
          {
            connection_ids: [id],
            mode: "name",
            path: folder,
            query,
            ...(cursor ? { cursors: { [id]: cursor } } : {}),
          },
          { directory: temporary },
        ),
      ).results[0];
    const first = await search("page-");
    expect(first.page.scope).toBe("folder");
    expect(first.page.path).toBe(folder);
    expect(first.page.entries).toHaveLength(100);
    const rest = await search("page-", first.page.nextCursor);
    expect(rest.page.entries).toHaveLength(5);
    expect((await search("hidden")).page.entries).toEqual([]);
    expect((await search("MÜLLER")).page.entries.map((item: { path: string }) => item.path)).toEqual([path]);
    expect((await search("does-not-exist")).page.entries).toEqual([]);
    expect((await search("*")).code).toBe("invalid_storage_search");
    expect((await api("GET", `/${id}/search?mode=content&query=contract`)).status).toBe(400);
  } else {
    expect(capabilities.search.modes).toEqual([]);
    expect((await api("GET", `/${id}/search?mode=content&query=contract`)).status).toBe(400);
  }
  // Real transfers exceed the old inline limit and preserve working copies on conflict.
  const large = Buffer.alloc(51 * 1024 * 1024, 0x5a);
  const largePath = `${folder}/large.bin`;
  const upload = await fetch(
    `${base}/workspace/storage-test/storage/${id}/content?${new URLSearchParams({ path: largePath })}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/octet-stream" },
      body: large,
    },
  );
  expect(await upload.text()).toContain('"ok":true');
  const copy = await (await api("POST", `/${id}/checkout`, { path: largePath })).json();
  expect(copy.size).toBe(large.length);
  expect(await readFile(join(temporary, copy.localPath))).toEqual(large);
  await writeFile(join(temporary, copy.localPath), "local edit");
  const localName = `${folder}-local.bin`;
  expect((await api("POST", `/${id}/local-copy`, { localPath: copy.localPath, targetPath: localName })).status).toBe(
    201,
  );
  expect(await readFile(join(temporary, localName), "utf8")).toBe("local edit");
  expect((await api("POST", `/${id}/local-copy`, { localPath: copy.localPath, targetPath: localName })).status).toBe(
    409,
  );
  expect((await withStorage(input, (adapter) => adapter.download(largePath))).size).toBe(large.length);
  const publish = { path: largePath, localPath: copy.localPath, version: copy.version, mode: "replace" };
  expect((await api("POST", `/${id}/from-workspace`, publish)).status).toBe(200);
  expect((await api("POST", `/${id}/from-workspace`, publish)).status).toBe(409);
  expect(await readFile(join(temporary, copy.localPath), "utf8")).toBe("local edit");
  expect((await api("POST", `/${id}/from-workspace`, { ...publish, localPath: process.execPath })).status).toBe(403);
  expect(
    (await api("POST", `/${id}/local-copy`, { localPath: copy.localPath, targetPath: "../escape.bin" })).status,
  ).toBe(400);
  expect(
    (await api("POST", `/${id}/local-copy`, { localPath: copy.localPath, targetPath: "viewer.bin" }, "viewer")).status,
  ).toBe(403);
  await agentRoundTrip(id, folder);
  await api("DELETE", `/${id}`);
}

async function agentRoundTrip(id: string, folder: string) {
  const { tool } = await LegalWorkStorageTools();
  const context = { directory: temporary };
  const source = { connection_id: id, path: `${folder}/agent.txt` };
  const roots = JSON.parse(await tool.storage_list_connections.execute({}, context)).connections;
  expect(roots).toContainEqual(expect.objectContaining({ connection_id: id }));
  const made = JSON.parse(
    await tool.storage_write_file.execute({ ...source, mode: "create", content: "Agent draft" }, context),
  );
  expect(made.result.ok).toBe(true);
  const read = JSON.parse(await tool.storage_read_file.execute({ ...source, max_chars: 5 }, context));
  expect(read.text).toBe("Agent");
  expect(read.next_offset).toBe(5);
  const rest = JSON.parse(await tool.storage_read_file.execute({ ...source, offset: read.next_offset }, context));
  expect(rest.text).toBe(" draft");
  const saved = JSON.parse(
    await tool.storage_write_file.execute(
      { ...source, mode: "replace", content: "Agent saved", version: read.version },
      context,
    ),
  );
  expect(saved.result.ok).toBe(true);
  expect(
    JSON.parse(
      await tool.storage_write_file.execute(
        { ...source, mode: "replace", content: "Stale", version: read.version },
        context,
      ),
    ).code,
  ).toBe("storage_conflict");
  expect(
    JSON.parse(
      await tool.storage_write_file.execute({ ...source, mode: "replace", content: "Missing version" }, context),
    ).code,
  ).toBe("storage_version_required");
  const downloaded = JSON.parse(await tool.storage_read_file.execute({ ...source, format: "download" }, context));
  expect(await readFile(join(temporary, downloaded.local_path), "utf8")).toBe("Agent saved");
  await writeFile(join(temporary, downloaded.local_path), "Edited local document");
  expect(
    JSON.parse(
      await tool.storage_write_file.execute(
        { ...source, mode: "replace", local_path: downloaded.local_path, version: downloaded.version },
        context,
      ),
    ).result.ok,
  ).toBe(true);
  expect(JSON.parse(await tool.storage_read_file.execute(source, context)).text).toBe("Edited local document");
  expect(
    JSON.parse(await tool.storage_create_folder.execute({ connection_id: id, path: `${folder}/agent-folder` }, context))
      .result.ok,
  ).toBe(true);
  expect(
    JSON.parse(await tool.storage_list_folder.execute({ connection_id: id, path: `${folder}/agent-folder` }, context))
      .page.entries,
  ).toEqual([]);
  const outside = JSON.parse(
    await tool.storage_write_file.execute({ ...source, mode: "create", local_path: process.execPath }, context),
  );
  expect(outside.code).toBe("storage_local_path_outside_workspace");
  const connection = await new StorageStore(config).get("storage-test", id);
  await api("PUT", `/${id}`, { ...connection, readOnly: true });
  expect(
    JSON.parse(await tool.storage_get_capabilities.execute({ connection_id: id }, context)).capabilities.write,
  ).toBe(false);
  expect(
    JSON.parse(await tool.storage_write_file.execute({ ...source, mode: "create", content: "Read only" }, context))
      .code,
  ).toBe("storage_read_only");
  await api("PUT", `/${id}`, { ...connection, readOnly: false });
  process.env.LEGALWORK_SERVER_TOKEN = viewerToken;
  expect(
    JSON.parse(await tool.storage_get_capabilities.execute({ connection_id: id }, context)).capabilities.write,
  ).toBe(false);
  expect(
    JSON.parse(await tool.storage_write_file.execute({ ...source, mode: "create", content: "Viewer" }, context)).ok,
  ).toBe(false);
  process.env.LEGALWORK_SERVER_TOKEN = config.token;
}

describe.skipIf(process.env.LEGALWORK_STORAGE_INTEGRATION !== "1")("real storage reference services", () => {
  const fixtures = process.env.LEGALWORK_STORAGE_FIXTURES ?? "/tmp/legalwork-storage-fixtures";
  const bucket = `legalwork-${Date.now()}`;
  const accountKey = Buffer.alloc(32, 7).toString("base64");
  beforeAll(async () => {
    const s3 = new S3Client({
      endpoint: "http://127.0.0.1:19290",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "legalwork", secretAccessKey: "fixture-password" },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    s3.destroy();
    const azure = new BlobServiceClient(
      "http://127.0.0.1:19000/legalwork",
      new StorageSharedKeyCredential("legalwork", accountKey),
    );
    await azure.createContainer(bucket);
    await new Storage({ apiEndpoint: "http://127.0.0.1:19444", projectId: "legalwork-test" }).createBucket(bucket);
  });
  test("SMB 3 / Samba with required encryption and agent filename search", async () => {
    const input = storageInputSchema.parse({
      name: "SMB fixture",
      config: {
        kind: "smb",
        host: "127.0.0.1",
        port: 19345,
        share: "documents",
        prefix: "Integration",
        username: "legalwork",
        encryption: "required",
      },
      secrets: { password: "fixture-password" },
    });
    await roundTrip(input);
    await expect(
      withStorage({ ...input, secrets: { password: "incorrect" } }, (adapter) => adapter.list("")),
    ).rejects.toMatchObject({ status: 403 });
    await expect(withStorage(input, (adapter) => adapter.list("../outside"))).rejects.toMatchObject({ status: 400 });
  }, 180_000);
  test(
    "S3 / MinIO",
    () =>
      roundTrip(
        storageInputSchema.parse({
          name: "S3 fixture",
          config: {
            kind: "s3",
            endpoint: "http://127.0.0.1:19290",
            bucket,
            region: "us-east-1",
            forcePathStyle: true,
            prefix: "lawfirm",
            accessKeyId: "legalwork",
          },
          secrets: { secretAccessKey: "fixture-password" },
        }),
      ),
    120_000,
  );
  test(
    "Azure / Azurite",
    () =>
      roundTrip(
        storageInputSchema.parse({
          name: "Azure fixture",
          config: {
            kind: "azure",
            endpoint: "http://127.0.0.1:19000/legalwork",
            accountName: "legalwork",
            container: bucket,
            prefix: "lawfirm",
          },
          secrets: { accountKey },
        }),
      ),
    120_000,
  );
  test(
    "Google Cloud Storage / fake-gcs-server",
    () =>
      roundTrip(
        storageInputSchema.parse({
          name: "GCS fixture",
          config: {
            kind: "gcs",
            endpoint: "http://127.0.0.1:19444",
            projectId: "legalwork-test",
            bucket,
            prefix: "lawfirm",
          },
        }),
      ),
    120_000,
  );
  test(
    "WebDAV / WsgiDAV",
    () =>
      roundTrip(
        storageInputSchema.parse({
          name: "WebDAV fixture",
          config: { kind: "webdav", endpoint: "http://127.0.0.1:19280", username: "legalwork" },
          secrets: { password: "fixture-password" },
        }),
      ),
    120_000,
  );
  test("SFTP / AsyncSSH and host key verification", async () => {
    const input = storageInputSchema.parse({
      name: "SFTP fixture",
      config: {
        kind: "sftp",
        host: "127.0.0.1",
        port: 19222,
        username: "legalwork",
        rootPath: "/",
        hostFingerprint: (await readFile(join(fixtures, "sftp-fingerprint.txt"), "utf8")).trim(),
      },
      secrets: { password: "fixture-password" },
    });
    await roundTrip(input);
    const wrong = storageInputSchema.parse({ ...input, config: { ...input.config, hostFingerprint: "0".repeat(64) } });
    await expect(withStorage(wrong, (adapter) => adapter.list(""))).rejects.toThrow();
  }, 120_000);
  test(
    "FTP / pyftpdlib",
    () =>
      roundTrip(
        storageInputSchema.parse({
          name: "FTP fixture",
          config: {
            kind: "ftp",
            host: "127.0.0.1",
            port: 19221,
            username: "legalwork",
            rootPath: "/",
            security: "none",
          },
          secrets: { password: "fixture-password" },
        }),
      ),
    120_000,
  );
  test(
    "FTPS / pyftpdlib with a trusted test CA",
    () =>
      roundTrip(
        storageInputSchema.parse({
          name: "FTPS fixture",
          config: {
            kind: "ftp",
            host: "127.0.0.1",
            port: 19243,
            username: "legalwork",
            rootPath: "/",
            security: "tls",
          },
          secrets: { password: "fixture-password" },
        }),
      ),
    120_000,
  );
});
