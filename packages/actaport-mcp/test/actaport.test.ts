import { describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActaportClient } from "../src/client.js";
import { createTokenProvider, type Credentials } from "../src/auth.js";
import { buildOperations, isRecord, specification } from "../src/spec.js";
import { createActaportServer } from "../src/server.js";

const credentials: Credentials = { realm: "test-firm", clientId: "client", clientSecret: "private-secret", username: "api-user", password: "private-password" };
const token = async () => ({ accessToken: "private-token", expiresAt: Date.now() + 300_000 });
const operations = buildOperations();
function operation(id: string) {
  const item = operations.find((entry) => entry.operationId === id);
  if (!item) throw new Error(`Missing operation ${id}`);
  return item;
}
function mockFetch(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
  return Object.assign(async (input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), { preconnect() {} });
}

describe("official API contract", () => {
  test("every documented API operation has one MCP tool; authentication stays internal", () => {
    const count = Object.entries(specification.paths).filter(([path]) => path.startsWith("/v1/"))
      .flatMap(([, methods]) => Object.values(methods).filter((item) => isRecord(item) && typeof item.operationId === "string")).length;
    expect(operations).toHaveLength(count);
    expect(operations.some((item) => item.operationId === "authenticate")).toBe(false);
    expect(new Set(operations.map((item) => item.name)).size).toBe(count);
  });
  test("missing numeric/UUID ids are supplied and validated", () => {
    expect(operation("getKontakt").validate({ id: "12" })).toBe(true);
    expect(operation("getKontakt").validate({ id: "../me" })).toBe(false);
    expect(operation("downloadDocument").validate({ id: "bad", saveTo: "doc.pdf" })).toBe(false);
    expect(operation("getDocument").validate({ laufendeNummer: "42", bezugsJahr: 26, id: "a887d131-5b45-486f-beee-123c55f81745" })).toBe(true);
  });
  test("validates recursive discriminator schemas without recursive validation", () => {
    const item = operation("updateBeteiligteHonorar");
    expect(item.validate({ laufendeNummer: "42", bezugsJahr: 26, beteiligteId: "12", body: { typ: "PAUSCHAL", pauschal: 100 } })).toBe(true);
    expect(item.validate({ laufendeNummer: "42", bezugsJahr: 26, beteiligteId: "12", body: { typ: "INVALID" } })).toBe(false);
  });
});

describe("authentication lifecycle", () => {
  test("uses the documented password grant, caches and renews without a refresh token", async () => {
    let now = 0;
    let calls = 0;
    const provider = createTokenProvider(credentials, { now: () => now, fetch: mockFetch(async (request) => {
      calls++;
      expect(new URL(request.url).pathname).toBe("/auth/realms/test-firm/protocol/openid-connect/token");
      expect(request.redirect).toBe("error");
      expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({ client_id: "client", client_secret: "private-secret", grant_type: "password", username: "api-user", password: "private-password" });
      return Response.json({ access_token: `token-${calls}`, expires_in: 300 });
    }) });
    expect((await Promise.all([provider(), provider(), provider()])).map((value) => value.accessToken)).toEqual(["token-1", "token-1", "token-1"]);
    now = 275_000;
    expect((await provider()).accessToken).toBe("token-2");
    expect((await provider(true)).accessToken).toBe("token-3");
    expect(calls).toBe(3);
  });
  test("auth errors never include response bodies or credentials", async () => {
    const provider = createTokenProvider(credentials, { fetch: mockFetch(() => new Response("private-secret private-password", { status: 401 })) });
    await expect(provider()).rejects.toMatchObject({ code: "auth_failed", status: 401 });
    await expect(provider()).rejects.not.toThrow("private-secret");
  });
});

describe("API execution", () => {
  test("serializes filters, pagination, ids and bearer auth according to the spec", async () => {
    const client = new ActaportClient(token, { fetch: mockFetch((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/v1/akten");
      expect(url.searchParams.get("page")).toBe("1");
      expect(url.searchParams.getAll("filter")).toEqual(["contains(aktenbezeichnung,'Example')", "eq(status,'AKTIV')"]);
      expect(request.headers.get("Authorization")).toBe("Bearer private-token");
      expect(request.redirect).toBe("manual");
      return Response.json({ content: [{ id: 42 }], next: 2 });
    }) });
    expect(await client.execute(operation("getAkten"), { page: 1, filter: ["contains(aktenbezeichnung,'Example')", "eq(status,'AKTIV')"] })).toMatchObject({ status: 200, data: { next: 2 } });
  });
  test("invalid arguments and read-only writes fail before any HTTP request", async () => {
    let calls = 0;
    const client = new ActaportClient(token, { fetch: mockFetch(() => { calls++; return Response.json({}); }) });
    await expect(client.execute(operation("getAkte"), { laufendeNummer: "1", bezugsJahr: "26" })).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(client.execute(operation("createKontakt"), {})).rejects.toMatchObject({ code: "read_only" });
    expect(calls).toBe(0);
  });
  test("retries rejected auth once, but never retries an ambiguous write", async () => {
    let calls = 0;
    let renewed = 0;
    const client = new ActaportClient(async (force) => { if (force) renewed++; return token(); }, { fetch: mockFetch(() => {
      calls++;
      return calls === 1 ? new Response(null, { status: 401 }) : Response.json({ id: 42 });
    }) });
    await client.execute(operation("getUserInfo"), {});
    expect([calls, renewed]).toEqual([2, 1]);
    calls = 0;
    const writer = new ActaportClient(token, { allowWrites: true, fetch: mockFetch(() => { calls++; return new Response("private-token", { status: 500 }); }) });
    await expect(writer.execute(operation("createKostenstelle"), {})).rejects.toMatchObject({ code: "api_failed" });
    expect(calls).toBe(1);
  });
  test("returns retry delay and permission errors without leaking upstream data", async () => {
    const client = new ActaportClient(token, { fetch: mockFetch(() => new Response("private-token", { status: 429, headers: { "Retry-After": "60" } })) });
    await expect(client.execute(operation("getUserInfo"), {})).rejects.toMatchObject({ code: "rate_limited", retryAfter: 60 });
    const denied = new ActaportClient(token, { fetch: mockFetch(() => new Response("private-token", { status: 403 })) });
    await expect(denied.execute(operation("getUserInfo"), {})).rejects.toMatchObject({ code: "permission_denied" });
  });
  test("does not forward bearer credentials to a redirect", async () => {
    let calls = 0;
    const client = new ActaportClient(token, { fetch: mockFetch(() => { calls++; return new Response(null, { status: 302, headers: { Location: "https://other.example/" } }); }) });
    await expect(client.execute(operation("getUserInfo"), {})).rejects.toMatchObject({ code: "api_failed", status: 302 });
    expect(calls).toBe(1);
  });
  test("supports multipart upload, TUS binary chunks, and HEAD offsets", async () => {
    const root = await mkdtemp(join(tmpdir(), "actaport-files-"));
    try {
      await writeFile(join(root, "example.pdf"), "PDF bytes");
      const uploader = new ActaportClient(token, { allowWrites: true, fileRoot: root, fetch: mockFetch(async (request) => {
        expect(request.headers.get("Content-Type")).toContain("multipart/form-data; boundary=");
        const form = await request.formData();
        const file = form.get("file");
        expect(file instanceof File && await file.text()).toBe("PDF bytes");
        expect(form.get("ordner")).toBe("Folder");
        return Response.json({ id: "document" });
      }) });
      await uploader.execute(operation("uploadDocument"), { laufendeNummer: "1", bezugsJahr: 26, body: { file: "example.pdf", ordner: "Folder" } });
      const tus = new ActaportClient(token, { allowWrites: true, fetch: mockFetch(async (request) => {
        expect(request.headers.get("Tus-Resumable")).toBe("1.0.0");
        expect(request.headers.get("Upload-Offset")).toBe("0");
        expect(request.headers.get("Content-Type")).toBe("application/offset+octet-stream");
        expect(await request.text()).toBe("chunk");
        return new Response(null, { status: 204, headers: { "Upload-Offset": "5" } });
      }) });
      expect(await tus.execute(operation("processTusUpload"), { id: "a887d131-5b45-486f-beee-123c55f81745", "Tus-Resumable": "1.0.0", "Upload-Offset": 0, body: Buffer.from("chunk").toString("base64") })).toMatchObject({ headers: { "upload-offset": "5" } });
      const head = new ActaportClient(token, { fetch: mockFetch((request) => {
        expect(request.method).toBe("HEAD");
        return new Response(null, { headers: { "Upload-Offset": "5" } });
      }) });
      const item = operations.find((entry) => entry.method === "HEAD");
      if (!item) throw new Error("Missing HEAD operation");
      expect(await head.execute(item, { id: "a887d131-5b45-486f-beee-123c55f81745" })).toMatchObject({ headers: { "upload-offset": "5" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("enforces Actaport's 50 MB multipart limit before authentication or upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "actaport-upload-limit-"));
    let tokenCalls = 0;
    let uploads = 0;
    const client = new ActaportClient(async () => { tokenCalls++; return token(); }, {
      allowWrites: true, fileRoot: root,
      fetch: mockFetch(() => { uploads++; return Response.json({ id: "document" }); }),
    });
    const args = { laufendeNummer: "1", bezugsJahr: 26, body: { file: "large.pdf" } };
    try {
      const file = await open(join(root, "large.pdf"), "w");
      try { await file.truncate(50 * 1024 * 1024); } finally { await file.close(); }
      await client.execute(operation("uploadDocument"), args);
      expect([tokenCalls, uploads]).toEqual([1, 1]);
      const larger = await open(join(root, "large.pdf"), "r+");
      try { await larger.truncate(50 * 1024 * 1024 + 1); } finally { await larger.close(); }
      await expect(client.execute(operation("uploadDocument"), args)).rejects.toMatchObject({ code: "file_too_large" });
      expect([tokenCalls, uploads]).toEqual([1, 1]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("downloads files without overwriting, rejects symlink escapes, and handles async download creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "actaport-download-"));
    const outside = await mkdtemp(join(tmpdir(), "actaport-outside-"));
    const args = { id: "a887d131-5b45-486f-beee-123c55f81745", saveTo: "example.pdf" };
    try {
      const client = new ActaportClient(token, { fileRoot: root, fetch: mockFetch(() => new Response("PDF", { headers: { "Content-Type": "application/octet-stream" } })) });
      await client.execute(operation("downloadDocument"), args);
      expect(await readFile(join(root, "example.pdf"), "utf8")).toBe("PDF");
      await expect(client.execute(operation("downloadDocument"), args)).rejects.toMatchObject({ code: "EEXIST" });
      await symlink(outside, join(root, "escape"));
      await expect(client.execute(operation("downloadDocument"), { ...args, saveTo: "escape/doc.pdf" })).rejects.toMatchObject({ code: "invalid_file_path" });
      const asyncDownload = new ActaportClient(token, { fileRoot: root, fetch: mockFetch(() => new Response(null, { status: 201, headers: { Location: "/v1/documents/id/download-status" } })) });
      expect(await asyncDownload.execute(operation("downloadDocument"), { ...args, saveTo: "later.pdf" })).toMatchObject({ status: 201 });
      await expect(readFile(join(root, "later.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});

test("real MCP handshake, tool discovery and calls respect write mode and redact errors", async () => {
  const api = new ActaportClient(token, { fetch: mockFetch(() => new Response("private-token private-secret", { status: 500 })) });
  const server = createActaportServer(api, { toolsets: ["administration"] });
  const client = new Client({ name: "test-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(28);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    const result = await client.callTool({ name: "actaport_get_user_info", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect((await client.callTool({ name: "actaport_create_kontakt", arguments: {} })).isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});
