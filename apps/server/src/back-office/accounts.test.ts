import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../types.js";
import { openSqlite, runtimeDbPath } from "../runtime-db.js";
import { writeEigenweltConnection, writeEigenweltConnectionIfCurrent, closeEigenweltConnectionForTests, claimEigenweltRefreshRequest } from "../eigenwelt-connection-store.js";
import { scheduleOrgPolicySync, resetOrgPolicyRuntimeForTests } from "../org-policy.js";
import { BackOfficeRecordSchema, defaultBackOfficeModel, type BackOfficeActor, type BackOfficeRecord, type BackOfficeSnapshot } from "./schema.js";
import { BackOfficeStore, backOfficeStore, closeBackOfficeStoreForTests } from "./store.js";
import { backOfficeAccess } from "./access.js";
import { backOfficePlatform, signOutBackOffice, syncBackOffice } from "./sync.js";
import { backOfficePrincipalKey } from "./principal.js";
import { platformBackOfficeHistory } from "./history.js";

const fixtures: { root: string; config: ServerConfig }[] = [];
const fetchSpies: ReturnType<typeof spyOn<typeof globalThis, "fetch">>[] = [];
const originalURL = process.env.EIGENWELT_PLATFORM_URL;
afterEach(async () => {
  for (const spy of fetchSpies.splice(0)) spy.mockRestore();
  for (const { root, config } of fixtures.splice(0)) {
    await resetOrgPolicyRuntimeForTests(config);
    await closeEigenweltConnectionForTests(config);
    await closeBackOfficeStoreForTests(config);
    await rm(root, { recursive: true, force: true });
  }
  if (originalURL === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = originalURL;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-bo-accounts-"));
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  fixtures.push({ root, config });
  if (runtimeDbPath(config) !== join(root, "runtime.sqlite"))
    throw new Error("Account fixtures must use their temporary runtime database, never an environment override.");
  const platformURL = "http://127.0.0.1:55499";
  process.env.EIGENWELT_PLATFORM_URL = platformURL;
  const snapshot = (records: BackOfficeRecord[] = [], accepted: string[] = []): BackOfficeSnapshot => ({ protocol: 1, model: defaultBackOfficeModel(), records, accepted, conflicts: [], views: [], cursor: 1 });
  const backend: { enabled: boolean; revision: number; finance: string[]; respond: (() => Promise<Response>) | null } = { enabled: true, revision: 1, finance: ["alice"], respond: null };
  const requests: { url: string; authorization: string | null }[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/api/desktop/policy")) return Response.json({ schemaVersion: 1, orgId: "firm", orgName: "Fixture firm", revision: backend.revision, role: "member", updatedAt: null, entries: { "backOffice.sync": { mode: "enforced", value: { enabled: backend.enabled, modelEditors: ["alice"], directoryEditors: ["alice", "bob"], billingMembers: backend.finance } } } });
    if (url.endsWith("/api/desktop/policy/secrets")) return Response.json({ schemaVersion: 1, revision: backend.revision, secrets: {} });
    if (backend.respond && url.includes("/api/back-office")) return backend.respond();
    if (url.endsWith("/api/back-office")) return Response.json(snapshot());
    return new Response(null, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect }));
  fetchSpies.push(network);
  const signIn = (userId: string, url = platformURL) => writeEigenweltConnection(config, { platformURL: url, platformToken: `token-${userId}`, refreshToken: `refresh-${userId}`, refreshRequestId: null, accessTokenExpiresAt: Date.now() + 3_600_000, account: { userId, orgId: "firm", orgName: "Fixture firm", orgRole: userId === "alice" ? "org:admin" : "org:member", userName: userId, userEmail: null } });
  await signIn("alice");
  await scheduleOrgPolicySync(config, { force: true });
  const access = await backOfficeAccess(config, true);
  const store = await backOfficeStore(config);
  store.setSync("firm", true);
  const original = store.saveRecord("firm", access.actor, { objectId: "companies", revision: 0, values: { name: "Copied confidential client", vatId: "Private financial value" } });
  store.receive("firm", snapshot([original], [store.pending("firm", 100, access.actor)[0].change.id]), access.actor);
  const oldHead = store.journal.storage.heads().at(-1)!;
  return { config, store, alice: access.actor, original, snapshot, signIn, backend, requests, oldHead, platformURL };
}

test("account switch erases the old readable cache and keeps remaining proposals scoped to their author", async () => {
  const { store, config, alice, original, signIn, oldHead } = await fixture();
  store.saveRecord("firm", alice, { id: original.id, objectId: original.objectId, revision: original.revision, values: { email: "alice-authored@example.test" } });
  const operation = store.pending("firm", 100, alice)[0].change.id;
  await signIn("bob");
  expect(store.raw("firm", original.id)).toBeNull();
  expect(store.journal.storage.key(oldHead.streamId)).toBeNull();
  const bob = (await backOfficeAccess(config, true)).actor;
  expect(store.pending("firm", 100, bob)).toEqual([]);
  expect(store.syncState("firm", bob).pending).toBe(0);
  expect(() => store.queuedRecordIntent("firm", operation, bob)).toThrow("unavailable");
  expect(() => store.discardQueued("firm", operation, bob)).toThrow("unavailable");
  expect(() => store.saveRecord("firm", alice, { objectId: "people", revision: 0, values: { name: "Wrong account" } })).toThrow("connected account changed");
  const retained = store.pending("firm")[0];
  expect(BackOfficeRecordSchema.parse(retained.change.data).values).toEqual({ email: "alice-authored@example.test" });
  expect(JSON.stringify(retained)).not.toContain("Copied confidential client");
  expect(JSON.stringify(retained)).not.toContain("Private financial value");
  await signIn("alice");
  const returning = (await backOfficeAccess(config, true)).actor;
  expect(store.pending("firm", 100, returning)).toHaveLength(1);
  expect(store.queuedRecordIntent("firm", operation, returning).record.values.email).toBe("alice-authored@example.test");
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("sign-out prunes managed data without requiring another sync or touching local records", async () => {
  const { store, config, oldHead, original } = await fixture();
  store.saveRecord("local", { userId: "local", model: true, edit: true, finance: true }, { objectId: "people", revision: 0, values: { name: "Local work" } });
  await writeEigenweltConnection(config, { account: null, platformToken: null, refreshToken: null, platformURL: null });
  expect(store.raw("firm", original.id)).toBeNull();
  expect(store.journal.storage.key(oldHead.streamId)).toBeNull();
  expect((await backOfficeAccess(config)).scope).toBe("local");
  expect(store.records("local", { userId: "local", model: true, edit: true, finance: true })[0].values.name).toBe("Local work");
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("ordinary token refresh and a stale conditional refresh cannot erase another account's current cache", async () => {
  const { store, config, signIn, original, oldHead } = await fixture();
  await writeEigenweltConnection(config, { platformToken: "renewed-alice", accessTokenExpiresAt: Date.now() + 3_600_000 });
  expect(store.raw("firm", original.id)).not.toBeNull();
  expect(store.journal.storage.key(oldHead.streamId)).not.toBeNull();
  const staleRequestId = await claimEigenweltRefreshRequest(config, "refresh-alice");
  expect(staleRequestId).not.toBeNull();
  await signIn("bob");
  const bob = (await backOfficeAccess(config, true)).actor;
  const current = store.saveRecord("firm", bob, { objectId: "people", revision: 0, values: { name: "Bob current" } });
  const heads = store.journal.storage.heads();
  if (!staleRequestId) throw new Error("Fixture failed to claim its refresh request");
  const changed = await writeEigenweltConnectionIfCurrent(config, { account: null, platformToken: null }, { refreshToken: "refresh-alice", refreshRequestId: staleRequestId });
  expect(changed).toBe(false);
  expect(store.raw("firm", current.id)?.values.name).toBe("Bob current");
  expect(store.journal.storage.heads()).toEqual(heads);
});

test("a known policy denial cleans the cache on access while local use remains available", async () => {
  const { store, config, backend, oldHead, original } = await fixture();
  backend.enabled = false; backend.revision++;
  await scheduleOrgPolicySync(config, { force: true });
  expect(store.raw("firm", original.id)).toBeNull();
  expect(store.journal.storage.key(oldHead.streamId)).toBeNull();
  await expect(backOfficeAccess(config, true)).rejects.toMatchObject({ code: "back_office_sync_disabled" });
  expect(store.raw("firm", original.id)).toBeNull();
  expect(store.journal.storage.key(oldHead.streamId)).toBeNull();
  expect((await backOfficeAccess(config)).scope).toBe("local");
});

test("an actor captured before a policy change cannot commit with its old cached finance rights", async () => {
  const { store, config, alice, original, backend } = await fixture();
  backend.finance = []; backend.revision++;
  await scheduleOrgPolicySync(config, { force: true });
  expect(() => store.saveRecord("firm", alice, { id: original.id, objectId: original.objectId, revision: original.revision, values: { vatId: "Rejected stale edit" } })).toThrow("Refresh Back Office");
  expect(store.raw("firm", original.id)?.values.vatId).toBeUndefined();
  expect(store.accountPendingCount("firm", (await backOfficeAccess(config, true)).actor)).toBe(0);
  expect(await signOutBackOffice(config, { force: true, apply: true })).toBe(0);
  expect(store.raw("firm", original.id)).toBeNull();
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("startup applies a committed policy denial after an interrupted cleanup without waiting for a UI request", async () => {
  const { store, config, original, oldHead } = await fixture();
  const external = await openSqlite(runtimeDbPath(config));
  try {
    external.run("UPDATE org_policy SET snapshot_json=json_set(snapshot_json,'$.entries.\"backOffice.sync\".value.enabled',json('false')) WHERE id='current'");
  } finally { external.close(); }
  const restarted = new BackOfficeStore(await openSqlite(runtimeDbPath(config)), store.journal.storage);
  try {
    expect(restarted.raw("firm", original.id)).toBeNull();
    expect(restarted.journal.storage.key(oldHead.streamId)).toBeNull();
    expect(restarted.checkIntegrity().locallyVerified).toBe(true);
  } finally { restarted.close(); }
});

test("a late sync response from the previous principal cannot restore records or consume the new user's drafts", async () => {
  const { store, config, alice, original, backend, signIn, snapshot } = await fixture();
  store.saveRecord("firm", alice, { objectId: "people", revision: 0, values: { name: "Alice private draft" } });
  const operation = store.pending("firm", 100, alice)[0].change.id;
  let bobRecord: BackOfficeRecord | null = null;
  let bob: BackOfficeActor | null = null;
  backend.respond = async () => {
    backend.respond = null;
    await signIn("bob");
    bob = (await backOfficeAccess(config, true)).actor;
    bobRecord = store.saveRecord("firm", bob, { objectId: "people", revision: 0, values: { name: "Bob draft" } });
    return Response.json(snapshot([original], [operation]));
  };
  await syncBackOffice(config);
  expect(bobRecord).not.toBeNull();
  expect(store.raw("firm", original.id)).toBeNull();
  const pending = store.pending("firm");
  expect(pending).toHaveLength(2);
  expect(pending.some(entry => entry.change.id === operation)).toBe(true);
  const current = await backOfficeAccess(config, true);
  expect(store.pending("firm", 100, current.actor)).toHaveLength(1);
  expect(store.records("firm", current.actor)[0].values.name).toBe("Bob draft");
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("a captured principal cannot post changes after a platform or account switch", async () => {
  const { config, alice, signIn, requests, platformURL } = await fixture();
  expect(alice.principalKey).toBe(backOfficePrincipalKey(platformURL + "/", "firm", "alice"));
  await signIn("bob");
  const before = requests.filter(request => request.url.endsWith("/api/back-office")).length;
  await expect(backOfficePlatform(config, [], alice.principalKey)).rejects.toMatchObject({ code: "back_office_account_changed" });
  expect(requests.filter(request => request.url.endsWith("/api/back-office"))).toHaveLength(before);
  expect(backOfficePrincipalKey("http://127.0.0.1:55498", "firm", "alice")).not.toBe(alice.principalKey);
});

test("a late response cannot restore a cache after the same principal reconnects", async () => {
  const { store, config, alice, original, backend, snapshot } = await fixture();
  backend.respond = async () => {
    backend.respond = null;
    store.suspendAccount("firm", alice.principalKey!, "Fixture reconnect", alice.principalKey!);
    const current = (await backOfficeAccess(config, true)).actor;
    expect(current.replicaId).not.toBe(alice.replicaId);
    store.setSync("firm", true);
    store.syncError("firm", "New connection state");
    store.saveRecord("firm", current, { objectId: "people", revision: 0, values: { name: "New connection draft" } });
    return Response.json(snapshot([original]));
  };
  await syncBackOffice(config);
  const current = (await backOfficeAccess(config, true)).actor;
  expect(store.raw("firm", original.id)).toBeNull();
  expect(store.records("firm", current).map(record => record.values.name)).toEqual(["New connection draft"]);
  expect(store.pending("firm", 100, current)).toHaveLength(1);
  expect(store.syncState("firm", current).error).toBe("New connection state");
});

test("permission shrink at an unchanged cursor fences earlier responses and older cursors cannot roll back state", async () => {
  const { store, config, alice, original, snapshot } = await fixture();
  const { vatId: _hidden, ...values } = original.values;
  store.receive("firm", snapshot([{ ...original, values }]), alice);
  expect(() => store.receive("firm", snapshot([original]), alice)).toThrow("directory reconnected");
  const current = (await backOfficeAccess(config, true)).actor;
  store.receive("firm", { ...snapshot([{ ...original, values: { name: "Newest" } }]), cursor: 20 }, current);
  expect(() => store.receive("firm", { ...snapshot([original]), cursor: 19 }, current)).toThrow("newer team snapshot");
  expect(store.raw("firm", original.id)?.values).toEqual({ name: "Newest" });
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("identical user and firm IDs on a different platform cannot adopt the previous origin's cache or drafts", async () => {
  const { store, config, alice, original, oldHead, signIn, snapshot } = await fixture();
  store.saveRecord("firm", alice, { id: original.id, objectId: original.objectId, revision: original.revision, values: { email: "old-origin@example.test" } });
  const nextURL = "http://127.0.0.1:55498";
  process.env.EIGENWELT_PLATFORM_URL = nextURL;
  await signIn("alice", nextURL);
  expect(store.raw("firm", original.id)).toBeNull();
  expect(store.journal.storage.key(oldHead.streamId)).toBeNull();
  const current = (await backOfficeAccess(config, true)).actor;
  expect(current.principalKey).not.toBe(alice.principalKey);
  expect(store.pending("firm", 100, current)).toEqual([]);
  expect(store.pending("firm")).toHaveLength(1);
  store.receive("firm", { ...snapshot(), cursor: 0 }, current);
  expect(store.syncState("firm", current).cursor).toBe(0);
  await expect(backOfficePlatform(config, [], alice.principalKey)).rejects.toMatchObject({ code: "back_office_account_changed" });
});

test("another principal's draft cannot be acknowledged or discarded through the current user's queue", async () => {
  const { store, config, alice, original, snapshot, signIn } = await fixture();
  store.saveRecord("firm", alice, { id: original.id, objectId: original.objectId, revision: original.revision, values: { email: "alice-remains@example.test" } });
  const originalOperation = store.pending("firm", 100, alice)[0].change.id;
  await signIn("bob");
  const bob = (await backOfficeAccess(config, true)).actor;
  const own = store.saveRecord("firm", bob, { objectId: "people", revision: 0, values: { name: "Bob own" } });
  const replicaId = store.receive("firm", snapshot([], [originalOperation]), bob);
  if (replicaId) bob.replicaId = replicaId;
  expect(store.pending("firm").some(entry => entry.change.id === originalOperation)).toBe(true);
  expect(store.pending("firm", 100, bob)).toHaveLength(1);
  store.clearTeam("firm", bob);
  expect(store.pending("firm").some(entry => entry.change.authorKey === bob.principalKey)).toBe(false);
  expect(store.raw("firm", own.id)).toBeNull();
  expect(store.pending("firm").map(entry => entry.change.id)).toEqual([originalOperation]);
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("a late unauthorized history response does not erase a newly connected account", async () => {
  const { config, store, alice, backend, signIn } = await fixture();
  backend.respond = async () => {
    backend.respond = null;
    await signIn("bob");
    const bob = (await backOfficeAccess(config, true)).actor;
    store.saveRecord("firm", bob, { objectId: "people", revision: 0, values: { name: "Bob retained" } });
    return Response.json({ error: { code: "unauthorized", message: "Old request" } }, { status: 401 });
  };
  await expect(platformBackOfficeHistory(config, store, "firm", { type: "model", id: "model" }, { limit: 10, cursor: null, export: false }, alice.principalKey)).rejects.toBeDefined();
  const bob = (await backOfficeAccess(config, true)).actor;
  expect(store.records("firm", bob)[0].values.name).toBe("Bob retained");
  expect(store.pending("firm", 100, bob)).toHaveLength(1);
});

test("the Back Office sign-out step cannot clear a new principal after waiting for its old final sync", async () => {
  const { config, store, alice, backend, signIn, snapshot } = await fixture();
  store.saveRecord("firm", alice, { objectId: "people", revision: 0, values: { name: "Alice draft" } });
  backend.respond = async () => {
    backend.respond = null;
    await signIn("bob");
    const bob = (await backOfficeAccess(config, true)).actor;
    store.saveRecord("firm", bob, { objectId: "people", revision: 0, values: { name: "Bob retained" } });
    return Response.json(snapshot());
  };
  expect(await signOutBackOffice(config, { force: true, apply: true })).toBe(0);
  const bob = (await backOfficeAccess(config, true)).actor;
  expect(store.records("firm", bob)[0].values.name).toBe("Bob retained");
  expect(store.pending("firm", 100, bob)).toHaveLength(1);
});
