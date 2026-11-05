import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as httpAdapter from "./serve-node.js";
import { startServer } from "./server.js";
import { openSqlite } from "./runtime-db.js";
import { toolImageOriginalStore } from "./tool-image-original-store.js";
import { TOOL_IMAGE_METADATA_KEY } from "./tool-image-original-schema.js";
import type { ServerConfig } from "./types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const endpoint = "/workspace/matter/sessions/chat";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { linkedNamespace?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-original-delete-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"), storage = join(root, "private");
  await mkdir(project); await mkdir(storage);
  const state: { deleted: number; messageReads: number; reviewHook?: () => Promise<void> } = { deleted: 0, messageReads: 0 };
  const committed: Array<Awaited<ReturnType<ReturnType<typeof toolImageOriginalStore>["capture"]>>> = [];
  const session = { id: "chat", projectID: "native-project", location: { directory: project }, title: "Chat", time: { created: 1, updated: 1 } };
  const message = () => ({ id: "message", type: "assistant", agent: "legalwork", model: { providerID: "fixture", id: "fixture" },
    time: { created: 2, completed: 3 }, content: [{ type: "tool", id: "outer", name: "execute", time: { created: 2, ran: 2, completed: 3 },
      state: { status: "completed", input: {}, content: [{ type: "text", text: "Preview finished" }], metadata: {
        [TOOL_IMAGE_METADATA_KEY]: { status: "retained-pending-native-commit", originals: committed },
        toolCalls: [{ tool: "office.preview", status: "completed" }],
      } } }] });
  const native = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === "/api/session") return Response.json({ data: [], cursor: {} });
    if (path === "/api/session/chat" && request.method === "DELETE") { state.deleted++; return new Response(null, { status: 204 }); }
    if (path === "/api/session/chat") return state.deleted ? Response.json({ message: "Deleted" }, { status: 404 }) : Response.json({ data: session });
    if (path === "/api/session/chat/message") { await state.reviewHook?.(); return Response.json({ data: [message()], cursor: {} }); }
    if (path === "/api/session/chat/message/message") { state.messageReads++; return Response.json({ data: message() }); }
    return Response.json({ message: "No such fixture endpoint" }, { status: 404 });
  } });
  cleanup.push(() => native.stop(true));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(storage, "server.json"), managedEngineStorageDirectory: storage,
    token: "fixture", hostToken: "fixture-host", opencodeBaseUrl: native.url.origin,
    workspaces: [{ id: "matter", name: "Matter", path: project, workspaceType: "local", preset: "starter" }], authorizedRoots: [project],
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0,
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const store = toolImageOriginalStore(config), signal = new AbortController().signal;
  const bytes = Buffer.from("exact synthetic image bytes; no raster operation");
  const capture = (storageNamespace = "unverified") => store.capture("chat", { messageID: "message", callID: "outer", tool: "office.preview", contentIndex: 0, mime: "image/png" }, bytes,
    { directory: project, projectID: "native-project", workspaceID: "matter", linkage: "observed-child-of-native-call", storageNamespace }, signal, async () => {});
  const linked = await capture(options.linkedNamespace), peer = await capture(); committed.push(linked);

  // Observe the real adapter's Request.signal and completed route response.
  // The original HTTP adapter, router, authentication and handler are unchanged.
  const inbound = deferred<AbortSignal>(), handled = deferred<number>(), serve = httpAdapter.serve;
  const observation = spyOn(httpAdapter, "serve").mockImplementation(options => serve({ ...options, async fetch(request) {
    const deleting = request.method === "DELETE" && new URL(request.url).pathname === endpoint;
    if (deleting) inbound.resolve(request.signal);
    const response = await options.fetch(request);
    if (deleting) handled.resolve(response.status);
    return response;
  } }));
  cleanup.push(() => { observation.mockRestore(); });
  const server = await startServer(config); cleanup.push(() => server.stop());
  const remove = (abort?: AbortSignal) => fetch(`http://127.0.0.1:${server.port}${endpoint}`, { method: "DELETE",
    headers: { Authorization: "Bearer fixture", "x-legalwork-host-token": "fixture-host" }, signal: abort });
  const imagePath = (id: string) => join(storage, "tool-image-originals", hash("unverified"), hash("chat"), `${id}.bin`);
  async function expectBothPresent() {
    expect((await store.read(linked.reference, signal)).bytes).toEqual(bytes);
    expect((await store.read(peer.reference, signal)).bytes).toEqual(bytes);
    expect((await store.page("chat")).images).toEqual([linked, peer]);
  }
  async function expectOnlyLinkedDeleted() {
    await expect(store.metadata(linked.reference)).rejects.toMatchObject({ status: 404 });
    await expect(lstat(imagePath(linked.reference.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.read(peer.reference, signal)).bytes).toEqual(bytes);
    expect((await lstat(imagePath(peer.reference.id))).isFile()).toBe(true);
    expect((await store.page("chat")).images).toEqual([peer]);
    expect(await store.deletedSessionIDs("unverified")).toEqual([]);
    const index = await openSqlite(join(storage, "tool-image-originals", "index.sqlite"));
    try {
      expect(index.all("SELECT id FROM tool_image_originals ORDER BY seq")).toEqual([{ id: peer.reference.id }]);
      expect(index.all("SELECT id FROM tool_image_reference_deletions")).toEqual([]);
    } finally { index.close(); }
  }
  return { config, state, store, linked, peer, remove, inbound, handled, expectBothPresent, expectOnlyLinkedDeleted };
}

test("normal DELETE removes only exact native-committed UUIDs and preserves another unverified record with the same session ID", async () => {
  const f = await fixture();
  expect(f.linked.reference.id).not.toBe(f.peer.reference.id);
  expect(f.linked.reference.sessionID).toBe(f.peer.reference.sessionID);
  expect((await f.remove()).status).toBe(200);
  expect(f.state.deleted).toBe(1);
  expect(f.state.messageReads).toBe(2);
  await f.expectOnlyLinkedDeleted();
});

test("manual DELETE preserves an exact copied native UUID from another verified managed history", async () => {
  const namespace = `managed-history:${hash("a different host-owned database history")}`;
  const f = await fixture({ linkedNamespace: namespace });
  expect(f.config.managedImageAffinity).toBeUndefined();
  expect(f.linked.source.storageNamespace).toBe(namespace);
  expect((await f.remove()).status).toBe(200);
  expect(f.state.deleted).toBe(1);
  await f.expectBothPresent();
  expect(await f.store.deletedSessionIDs(namespace)).toEqual([]);
});

for (const change of ["effective credentials", "replacement workspace object"]) {
  test(`a mid-review change to ${change} refuses native deletion and image purge`, async () => {
    const f = await fixture(), reviewing = deferred<void>(), release = deferred<void>();
    f.state.reviewHook = async () => { reviewing.resolve(); await release.promise; };
    const deleting = f.remove();
    try {
      await reviewing.promise;
      if (change === "effective credentials") {
        const workspace = f.config.workspaces[0]; if (!workspace) throw new Error("Missing owned fixture workspace");
        workspace.opencodeUsername = "different-user"; workspace.opencodePassword = "different-generation";
      } else f.config.workspaces = f.config.workspaces.map(workspace => ({ ...workspace, baseUrl: "http://127.0.0.1:1" }));
    } finally { release.resolve(); }
    const response = await deleting;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "original_delete_connection_changed" });
    expect(f.state.deleted).toBe(0);
    await f.expectBothPresent();
  });
}

test("an actually observed client abort after native deletion cannot skip exact-reference cleanup", async () => {
  const f = await fixture(), nativeSucceeded = deferred<void>(), releaseResponse = deferred<void>();
  f.config.observeManagedEngineResponse = async (request, response) => {
    if (request.method === "DELETE" && request.path === "/api/session/chat" && response.status === 204) {
      nativeSucceeded.resolve(); await releaseResponse.promise;
    }
  };
  const controller = new AbortController(), result = f.remove(controller.signal).then(response => ({ response }), error => ({ error }));
  try {
    const signal = await f.inbound.promise;
    await nativeSucceeded.promise;
    expect(f.state.deleted).toBe(1);
    const serverObservedAbort = signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    controller.abort();
    expect(await result).toHaveProperty("error");
    await serverObservedAbort;
    expect(signal.aborted).toBe(true);
  } finally { releaseResponse.resolve(); }
  expect(await f.handled.promise).toBe(200);
  expect(f.state.deleted).toBe(1);
  await f.expectOnlyLinkedDeleted();
});
