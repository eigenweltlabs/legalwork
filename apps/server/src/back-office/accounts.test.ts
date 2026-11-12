import { changeNativeLinks, nativeSources, syncNativeLinks, visibleNativeLinks } from "./native-links.js";
import { assignLocalRecords, firstSyncStatus, firstSyncBatch, editLocalCopy, createLocalRelated, pendingLocalRows, stageFirstSync } from "./first-sync.js";
import { backOfficeTestConfig } from "./config.test-support.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../types.js";
import { openSqlite, runtimeDbPath } from "../runtime-db.js";
import { readEigenweltConnection, writeEigenweltConnection, writeEigenweltConnectionIfCurrent, closeEigenweltConnectionForTests, claimEigenweltRefreshRequest } from "../eigenwelt-connection-store.js";
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
  const config = backOfficeTestConfig(root, { hostToken: "fixture-host" });
  fixtures.push({ root, config });
  if (runtimeDbPath(config) !== join(root, "runtime.sqlite"))
    throw new Error("Account fixtures must use their temporary runtime database, never an environment override.");
  const platformURL = "http://127.0.0.1:55499";
  process.env.EIGENWELT_PLATFORM_URL = platformURL;
  const snapshot = (records: BackOfficeRecord[] = [], accepted: string[] = []): BackOfficeSnapshot => ({ protocol: 1, model: defaultBackOfficeModel(), records, accepted, conflicts: [], views: [], cursor: 1 });
  const backend: { enabled: boolean; revision: number; finance: string[]; respond: ((init?: RequestInit) => Promise<Response>) | null } = { enabled: true, revision: 1, finance: ["alice"], respond: null };
  const requests: { url: string; authorization: string | null }[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/api/desktop/policy")) return Response.json({ schemaVersion: 1, orgId: "firm", orgName: "Fixture firm", revision: backend.revision, role: "member", updatedAt: null, entries: { "backOffice.sync": { mode: "enforced", value: { enabled: backend.enabled, modelEditors: ["alice"], directoryEditors: ["alice", "bob"], billingMembers: backend.finance } } } });
    if (url.endsWith("/api/desktop/policy/secrets")) return Response.json({ schemaVersion: 1, revision: backend.revision, secrets: {} });
    if (backend.respond && url.includes("/api/back-office")) return backend.respond(init);
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

test("receiving a snapshot while an authored field is queued does not retire the picker's replica", async () => {
  const { store, alice, original, snapshot } = await fixture();
  store.saveRecord("firm", alice, { id: original.id, objectId: original.objectId, revision: original.revision, values: { email: "office@example.test" } });
  if (!alice.replicaId) throw new Error("Missing test replica");
  expect(store.receive("firm", snapshot([original]), alice)).toBe(alice.replicaId);
  expect(store.raw("firm", original.id)?.values.email).toBe("office@example.test");
  expect(store.receive("firm", snapshot([]), alice)).not.toBe(alice.replicaId);
  expect(store.raw("firm", original.id)).toBeNull();
});

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
  expect(() => store.saveRecord("firm", alice, { id: original.id, objectId: original.objectId, revision: original.revision, values: { vatId: "Rejected stale edit" } })).toThrow(expect.objectContaining({ code: expect.stringMatching(/^back_office_(replica|permissions)_changed$/) }));
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

test("broken Back Office history blocks Back Office without preventing the app's account and policy updates", async () => {
  const { store, config, backend, signIn } = await fixture();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    store.db.exec("CREATE TABLE unrelated_app_data(id TEXT PRIMARY KEY,value TEXT); INSERT INTO unrelated_app_data VALUES('ordinary','before')");
    const heads = store.journal.storage.heads();
    store.db.run("UPDATE unrelated_app_data SET value='after'");
    expect(store.checkIntegrity().locallyVerified).toBe(true);
    expect(store.journal.storage.heads()).toEqual(heads);
    store.db.exec("DROP TRIGGER bo_records_journal_guard_UPDATE");
    expect(await signOutBackOffice(config, { force: true, apply: true })).toBe(0);
    await signIn("bob");
    expect((await readEigenweltConnection(config)).account?.userId).toBe("bob");
    backend.enabled = false; backend.revision++;
    await scheduleOrgPolicySync(config, { force: true });
    store.db.run("UPDATE unrelated_app_data SET value='still works'");
    expect(store.db.get("SELECT value FROM unrelated_app_data")?.value).toBe("still works");
    expect(() => store.checkIntegrity()).toThrow("security triggers");
    expect(warning).toHaveBeenCalled();
  } finally { warning.mockRestore(); }
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
  const pending = store.pending("firm", 100, current);
  expect(pending).toHaveLength(1);
  expect(pending[0].error).toBeNull();
  expect(BackOfficeRecordSchema.parse(pending[0].change.data).values).toEqual({
    name: "New connection draft", active: true, personType: "External contact",
  });
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

test("first sync keeps account ownership across sign-ins and queues independent records beside a held edit", async () => {
  const { config, store, alice, signIn } = await fixture();
  const local = { userId: "local", edit: true, model: true, finance: true };
  const save = (name: string) => store.saveRecord("local", local, { objectId: "people", revision: 0, values: { name } });
  const original = save("Alice's private source");
  await writeEigenweltConnection(config, { account: null, platformToken: null });
  const unassigned = save("Before sign-in");
  await signIn("bob");
  await scheduleOrgPolicySync(config, { force: true });
  const bob = (await backOfficeAccess(config, true)).actor;
  const status = firstSyncStatus(store, bob);
  expect(status.unassigned).toBe(1);
  expect(status.waiting).toBe(0);
  expect(pendingLocalRows(store, "firm", bob, "people").map(record => record.id)).toEqual([unassigned.id]);
  save("Bob's own contact");
  expect(() => assignLocalRecords(store, "firm", bob, "stale")).toThrow("changed");
  assignLocalRecords(store, "firm", bob, status.selection!);
  expect(firstSyncStatus(store, bob).unassigned).toBe(0);
  const billing = store.saveRecord("local", local, { objectId: "invoices", revision: 0, values: { name: "Local invoice" } });
  stageFirstSync(store, "firm", bob, new Set());
  expect(store.raw("firm", original.id)).toBeNull();
  expect(pendingLocalRows(store, "firm", bob, "people")).toEqual([]);
  expect(pendingLocalRows(store, "firm", bob, "invoices")).toEqual([]);
  expect(store.raw("firm", billing.id)).toBeNull();
  expect(store.raw("firm", unassigned.id)?.values.name).toBe("Before sign-in");
  const held = store.pending("firm", 0, bob).find(entry => BackOfficeRecordSchema.parse(entry.change.data).id === unassigned.id)!;
  store.db.run("UPDATE bo_outbox SET error='Record changed' WHERE id=?", [held.change.id]);
  const later = save("Unaffected contact");
  stageFirstSync(store, "firm", bob, new Set());
  expect(firstSyncBatch(store, "firm", bob).map(change => BackOfficeRecordSchema.parse(change.data).id)).toContain(later.id);
  expect(firstSyncStatus(store, bob).waiting).toBe(1);
  expect(alice.principalKey).not.toBe(bob.principalKey);
});

test("unassigned rows can be edited and linked on their source device without publishing them", async () => {
  const { config, store, signIn } = await fixture();
  await writeEigenweltConnection(config, { account: null, platformToken: null });
  const matter = store.saveRecord("local", { userId: "local", edit: true, model: true, finance: true }, {
    objectId: "matters", revision: 0, values: { name: "Device matter" },
  });
  await signIn("bob");
  await scheduleOrgPolicySync(config, { force: true });
  const bob = (await backOfficeAccess(config, true)).actor;
  const client = createLocalRelated(store, "firm", bob, { id: matter.id, objectId: "matters", fields: ["clients"] }, {
    id: crypto.randomUUID(), objectId: "clients", values: { name: "Device client" },
  }).record;
  const change = editLocalCopy(store, "firm", bob, { id: matter.id, objectId: "matters", revision: matter.revision,
    values: { fileNumber: "DEV-1", clients: [client.id] }, expectedValues: { fileNumber: null, clients: null } });
  expect(change.record.values.clients).toEqual([client.id]);
  expect(store.raw("local", matter.id)?.values.fileNumber).toBe("DEV-1");
  expect(store.raw("firm", matter.id)).toBeNull();
  expect(store.raw("firm", client.id)).toBeNull();
  expect(firstSyncStatus(store, bob).unassigned).toBe(2);
  expect(() => editLocalCopy(store, "firm", bob, { id: matter.id, objectId: "matters", revision: change.record.revision, values: { clients: [crypto.randomUUID()] } })).toThrow("available record");
});

test("native links survive an unavailable platform, wait for both shared endpoints and ignore a late response after account switch", async () => {
  const { config, store, alice, original, backend, signIn } = await fixture();
  const access = { scope: "firm", actor: alice };
  const sources = await nativeSources(config);
  const task = sources.tasks.createTask({ title: "Locally drafted work" }, { userId: "alice", name: null, email: null });
  const source = { kind: "task" as const, sourceId: task.id, projectKey: "" };
  const edge = { ...source, recordId: original.id };
  changeNativeLinks(store, access, sources, source, [original.id], []);
  const pending = () => store.db.get("SELECT stamp FROM native_directory_links WHERE account=? AND sourceId=?", [alice.principalKey!, task.id])?.stamp;
  const stamp = pending();
  const read = () => visibleNativeLinks(store, access, sources);
  expect(read()).toEqual([edge]);
  // Old platforms do not implement this endpoint. Preserve the local intent.
  expect(await syncNativeLinks(config, store, "firm", alice)).toBe(false);
  expect(pending()).toBe(stamp);
  const sent: { stamp: string; recordId: string }[][] = [];
  backend.respond = async init => {
    const body = JSON.parse(String(init?.body));
    sent.push(body.changes);
    return Response.json({ links: body.changes.length ? [edge] : [], states: body.changes.length ? [{...edge, present:true, generation:null}] : [], accepted: body.changes.map((c:{stamp:string})=>c.stamp) });
  };
  await syncNativeLinks(config, store, "firm", alice);
  expect(sent.at(-1)).toEqual([]);
  sources.tasks.markSynced(task.id, "firm", new Date().toISOString());
  await syncNativeLinks(config, store, "firm", alice);
  expect(sent.at(-1)?.map(c=>c.stamp)).toEqual([String(stamp)]);
  expect(pending()).toBeNull();
  expect(read()).toEqual([edge]);
  backend.respond = async () => {
    backend.respond = null;
    await signIn("bob");
    return Response.json({ links:[edge], accepted:[] });
  };
  await expect(syncNativeLinks(config, store, "firm", alice)).rejects.toMatchObject({code:"back_office_account_changed"});
  const bob = (await backOfficeAccess(config, true)).actor;
  expect(visibleNativeLinks(store,{scope:"firm",actor:bob},await nativeSources(config))).toEqual([]);
  expect(store.db.get("SELECT 1 FROM native_directory_links WHERE account=? AND stamp IS NULL",[alice.principalKey!])).toBeUndefined();
});

test.each(["source first", "directory first"])("a local link publishes once both endpoints are shared, %s", async order => {
  const { config, store, alice, snapshot, original, backend } = await fixture();
  const local = {scope:"local", actor:{userId:"local",edit:true,model:true,finance:true}};
  const sources = await nativeSources(config);
  const task = sources.tasks.createTask({title:"Initially local task"}, {userId:"alice",name:null,email:null});
  const source = {kind:"task" as const, projectKey:"", sourceId:task.id};
  const record = store.saveRecord("local",local.actor,{objectId:"people",revision:0,values:{name:"Initially local contact"}});
  const edge = {...source,recordId:record.id};
  changeNativeLinks(store,local,sources,source,[record.id],[]);
  const sent: string[] = [];
  backend.respond = async init => {
    const changes = JSON.parse(String(init?.body)).changes as {stamp:string}[];
    sent.push(...changes.map(c=>c.stamp));
    return Response.json({links:sent.length ? [edge] : [],accepted:changes.map(c=>c.stamp)});
  };
  const shareDirectory = () => {
    store.receive("firm",snapshot([original,{...record,ownerId:"alice",revision:1}]),alice);
    store.db.run("UPDATE bo_first_sync SET confirmed=1 WHERE id=? AND principal=?", [record.id,alice.principalKey!]);
  };
  const shareTask = () => sources.tasks.markSynced(task.id,"firm",new Date().toISOString());
  if(order==="source first") shareTask(); else shareDirectory();
  await syncNativeLinks(config,store,"firm",alice);
  expect(sent).toEqual([]);
  if(order==="source first") shareDirectory(); else shareTask();
  await syncNativeLinks(config,store,"firm",alice);
  await syncNativeLinks(config,store,"firm",alice);
  expect(sent).toHaveLength(1);
  expect(visibleNativeLinks(store,{scope:"firm",actor:alice},sources)).toEqual([edge]);
});
