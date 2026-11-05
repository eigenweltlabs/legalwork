import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolImageOriginalStore } from "./tool-image-original-store.js";
import { openSqlite } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-original-store-"))); roots.push(root);
  const project = join(root, "project"), storage = join(root, "private"); await mkdir(project); await mkdir(storage);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(storage, "server.json"), managedEngineStorageDirectory: storage,
    token: "fixture", hostToken: "fixture-host", workspaces: [{ id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [project], approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], readOnly: false, startedAt: 0,
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const source = { directory: project, projectID: "native-project", workspaceID: "matter", linkage: "observed-child-of-native-call", storageNamespace: "managed-history:first" } satisfies Parameters<ReturnType<typeof toolImageOriginalStore>["capture"]>[3];
  const input = { messageID: "message", callID: "outer", tool: "office.preview", contentIndex: 0, mime: "image/png" };
  const store = toolImageOriginalStore(config), signal = new AbortController().signal;
  const capture = (bytes = Buffer.from("opaque exact bytes"), namespace = source.storageNamespace) => store.capture("chat", input, bytes, { ...source, storageNamespace: namespace }, signal, async () => {});
  return { root, storage, project, config, source, input, store, signal, capture };
}

test("opaque large originals survive restart byte-for-byte with private permissions and no project copy", async () => {
  const f = await fixture(), bytes = Buffer.alloc(5 * 1024 * 1024 + 17, 0x91);
  const image = await f.capture(bytes); expect(image.bytes).toBe(bytes.length); expect(image.reference.sha256).toBe(hash(bytes));
  expect(image.header.status).toBe("unavailable"); expect(image.source.captureOrdinal).toBe(1);
  const restarted = toolImageOriginalStore(f.config), read = await restarted.read(image.reference, f.signal);
  expect(Buffer.compare(read.bytes, bytes)).toBe(0); expect(read.image).toEqual(image);
  expect((await restarted.page("chat")).images).toEqual([image]);
  const path = join(f.storage, "tool-image-originals", hash(f.source.storageNamespace), hash("chat"), image.reference.id + ".bin");
  expect((await lstat(path)).mode & 0o777).toBe(0o600); expect((await lstat(join(f.storage, "tool-image-originals"))).mode & 0o777).toBe(0o700);
  expect(await readFile(path)).toEqual(bytes);
  await expect(restarted.read({ ...image.reference, sha256: "0".repeat(64) }, f.signal)).rejects.toMatchObject({ status: 404 });
});

test("metadata paging continues beyond100, binds cursor to the exact chat and rejects malformed cursor", async () => {
  const f = await fixture(); for (let i = 0; i < 101; i++) await f.capture(Buffer.from([i]));
  const first = await f.store.page("chat"); expect(first.images).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
  if (!first.nextCursor) throw new Error("Missing explicit continuation");
  const last = await f.store.page("chat", first.nextCursor); expect(last.images).toHaveLength(1); expect(last.nextCursor).toBeNull();
  expect(new Set([...first.images, ...last.images].map(image => image.reference.id)).size).toBe(101);
  await expect(f.store.page("other", first.nextCursor)).rejects.toMatchObject({ status: 400, code: "invalid_original_image_cursor" });
  await expect(f.store.page("chat", "malformed-json")).rejects.toMatchObject({ status: 400 });
});

test("managed namespaces isolate colliding session IDs, deletion tombstones and late capture", async () => {
  const f = await fixture(), a = await f.capture(), b = await f.capture(Buffer.from("B"), "managed-history:second"), manual = await f.capture(Buffer.from("manual"), "unverified");
  await f.store.removeSessions(f.source.storageNamespace, ["chat"]);
  await expect(f.store.read(a.reference, f.signal)).rejects.toMatchObject({ status: 404 });
  await expect(f.capture()).rejects.toMatchObject({ status: 404 });
  expect((await f.store.read(b.reference, f.signal)).bytes.toString()).toBe("B");
  expect((await f.store.read(manual.reference, f.signal)).bytes.toString()).toBe("manual");
  expect(await f.store.indexedSessionIDs("managed-history:second")).toEqual(["chat"]);
  expect(await f.store.deletedSessionIDs(f.source.storageNamespace)).toEqual(["chat"]);
  await expect(f.store.removeSessions("unverified", ["chat"])).rejects.toThrow("verified managed");
});

test("exact manual reference deletion is durable across unlink failure and retried without native authority", async () => {
  const f = await fixture(), image = await f.capture(Buffer.from("manual"), "unverified"), peer = await f.capture(Buffer.from("peer"), "unverified");
  const path = join(f.storage, "tool-image-originals", hash("unverified"), hash("chat"), image.reference.id + ".bin");
  await rm(path); await mkdir(path); await writeFile(join(path, "block"), "owned fixture");
  await expect(f.store.removeReferences([image.reference])).rejects.toBeDefined();
  await expect(f.store.metadata(image.reference)).rejects.toMatchObject({ status: 404 });
  expect((await f.store.page("chat")).images).toEqual([peer]);
  await rm(path, { recursive: true }); await toolImageOriginalStore(f.config).retryReferenceDeletions();
  const db = await openSqlite(join(f.storage, "tool-image-originals", "index.sqlite"));
  try { expect(db.all("SELECT * FROM tool_image_reference_deletions")).toEqual([]); expect(db.all("SELECT * FROM tool_image_originals")).toHaveLength(1); } finally { db.close(); }
  expect((await f.store.read(peer.reference, f.signal)).bytes.toString()).toBe("peer");
});

test("capture cancellation and deletion during commit cannot publish bytes or an available reference", async () => {
  const f = await fixture(), stopped = new AbortController();
  await expect(f.store.capture("chat", f.input, Buffer.from("canceled"), f.source, stopped.signal, async () => { stopped.abort(); })).rejects.toBeDefined();
  expect((await f.store.page("chat")).images).toEqual([]);
  await expect(f.store.capture("chat", f.input, Buffer.from("deleted"), f.source, f.signal, async () => { await f.store.removeSessions(f.source.storageNamespace, ["chat"]); })).rejects.toBeDefined();
  expect((await f.store.page("chat")).images).toEqual([]);
});

test("fixed root, namespace directory and SQLite symlinks are rejected before any image write", async () => {
  for (const target of ["root", "namespace", "index"]) {
    const f = await fixture(), outside = join(f.root, "outside"); await mkdir(outside);
    const root = join(f.storage, "tool-image-originals");
    if (target === "root") await symlink(outside, root);
    else { await mkdir(root); if (target === "namespace") await symlink(outside, join(root, hash(f.source.storageNamespace))); else { const file = join(outside, "foreign.sqlite"); await writeFile(file, "unchanged"); await symlink(file, join(root, "index.sqlite")); } }
    await expect(f.capture()).rejects.toBeDefined();
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(outside)).toEqual(target === "index" ? ["foreign.sqlite"] : []);
    if (target === "index") expect(await readFile(join(outside, "foreign.sqlite"), "utf8")).toBe("unchanged");
  }
});


test("empty or never-used cleanup creates no index while active captures still receive tombstones",async()=>{
  const f=await fixture();await f.store.removeReferences([]);await f.store.removeSessions(f.source.storageNamespace,[]);await f.store.removeSessions(f.source.storageNamespace,["never-captured"]);
  expect(await f.store.hasIndex()).toBe(false);
  const image=await f.capture();await f.store.removeSessions(f.source.storageNamespace,["chat"]);
  await expect(f.store.metadata(image.reference)).rejects.toMatchObject({status:404});
});
