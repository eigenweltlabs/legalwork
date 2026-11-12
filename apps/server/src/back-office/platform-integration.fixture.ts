import { readProjectDetails, updateProjectDetails } from "../project-store.js";
import { backOfficeDirectoryKey } from "./principal.js";
import { backOfficeTestConfig } from "./config.test-support.js";
import { attachFile, cachedFile } from "./files.js";
import { loadAttachedFile } from "./file-sync.js";
import { BackOfficeFilesSchema, BackOfficeFieldSchema } from "./schema.js";
// Run by model-api's Back Office integration test against its disposable HTTP server.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  z,
  BackOfficeSnapshotSchema,
  BackOfficeViewSchema,
  type BackOfficeActor,
} from "./schema.js";
import { BackOfficeStore, backOfficeStore } from "./store.js";
import { platformBackOfficeHistory } from "./history.js";
import {
  BackOfficeHistoryPageSchema,
  BackOfficeHistoryExportSchema,
} from "./schema.js";
import { verifyBackOfficeHistoryExport } from "./history-export.js";
import {
  backOfficePlatform,
  syncBackOffice,
} from "./sync.js";
import {
  writeEigenweltConnection,
  closeEigenweltConnectionForTests,
} from "../eigenwelt-connection-store.js";
import {
  scheduleOrgPolicySync,
  resetOrgPolicyRuntimeForTests,
} from "../org-policy.js";
import { openSqlite, runtimeDbPath } from "../runtime-db.js";
import { projectSyncStore } from "../project-sync-store.js";
import { backOfficeAccess } from "./access.js";
import type { ServerConfig } from "../types.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const settings = z
  .object({
    url: z.string().url(),
    orgId: z.string(),
    projectId: z.string().uuid(),
    admin: z.string(),
    member: z.string(),
    tokens: z.record(z.string(), z.string()),
    scale: z.object({ size: z.number().int().positive(), id: z.uuid(), digest: z.string() }).optional(),
  })
  .parse(JSON.parse(input));
process.env.EIGENWELT_PLATFORM_URL = settings.url;
delete process.env.LEGALWORK_RUNTIME_DB;
const root = await mkdtemp(join(tmpdir(), "legalwork-bo-platform-"));
const configs: ServerConfig[] = [];
const stores: BackOfficeStore[] = [];
const deviceActors = new Map<ServerConfig, BackOfficeActor>();
async function device(userId: string) {
  const directory = join(root, userId);
  await mkdir(directory);
  const config = backOfficeTestConfig(directory, { token: "integration-only", hostToken: "integration-only-host" });
  configs.push(config);
  await writeEigenweltConnection(config, {
    account: {
      userId,
      orgId: settings.orgId,
      orgName: "Integration firm",
      userName: null,
      userEmail: null,
      orgRole: userId === settings.admin ? "org:admin" : "org:member",
    },
    platformURL: settings.url,
    platformToken: settings.tokens[userId],
    accessTokenExpiresAt: Date.now() + 3_600_000,
  });
  await scheduleOrgPolicySync(config, { force: true });
  (await projectSyncStore(config)).saveLink({
    workspaceId: `ws_${userId}`,
    projectId: settings.projectId,
    orgId: settings.orgId,
    origin: "local",
    role: userId === settings.admin ? "owner" : "member",
    ownerUserId: settings.admin,
    settings: {
      access: "org",
      memberIds: [],
      scope: {
        metadata: false,
        documents: false,
        notes: false,
        tasks: false,
        recordings: false,
        reviews: false,
        calendar: false,
      },
    },
    confirmed: true,
    remoteUpdatedAt: null,
    filesReconciledAt: null,
    state: "active",
    allowDeletions: false,
    lastSyncAt: null,
    lastError: null,
    report: null,
  });
  const access = await backOfficeAccess(config, true);
  const store = await backOfficeStore(config);
  stores.push(store);
  store.setSync(settings.orgId, true);
  deviceActors.set(config, access.actor);
  return { config, store, actor: access.actor };
}
async function refreshDeviceActor(config: ServerConfig) {
  const actor = deviceActors.get(config);
  if (actor) Object.assign(actor, (await backOfficeAccess(config, true)).actor);
}
async function syncDevice(config: ServerConfig) {
  await syncBackOffice(config);
  await refreshDeviceActor(config);
}

async function verifyLifecycle() {
  const a = await device(settings.admin),
    b = await device(settings.member),
    scope = settings.orgId;
  assert.equal((await backOfficeAccess(a.config)).scope, scope);
  assert.equal((await backOfficeAccess(b.config)).scope, scope);
  const localActor: BackOfficeActor = {
    userId: "local",
    model: true,
    edit: true,
    finance: true,
  };
  const client = a.store.saveRecord("local", localActor, {
    objectId: "clients",
    revision: 0,
    values: { name: "Mandant" },
  });
  const localMatter = a.store.saveRecord("local", localActor, {
    objectId: "matters",
    revision: 0,
    values: { name: "Local case", clients: [client.id] },
  });
  const projectPath = join(root, "metadata-test");
  await mkdir(projectPath);
  a.config.workspaces.push({ id: "metadata-test", name: "Local project", path: projectPath, preset: "starter", workspaceType: "local" });
  await updateProjectDetails(projectPath, { revision: 0, fields: [{ id: "matter", label: "Matter", type: "backoffice",
    objectId: "matters", multiple: false, value: { directoryId: "local:" + a.store.journal.storage.identity.deviceId, recordIds: [localMatter.id] } }] });
  const contacts = Array.from({ length: 22 }, (_, index) => a.store.saveRecord("local", localActor, {
    objectId: "people", revision: 0, values: { name: "Firm contact " + index },
  }).id);
  const link = a.store.saveRecord("local", localActor, {
    objectId: "projectLinks",
    revision: 0,
    values: {
      name: "Shared project",
      projectId: `ws_${settings.admin}`,
      matter: localMatter.id,
    },
  });
  // Local attachments are immutable and publish with a newly introduced file field.
  const fileModel = a.store.model("local");
  fileModel.objects
    .find((object) => object.id === "matters")!
    .fields.push(
      BackOfficeFieldSchema.parse({
        id: "caseFile",
        label: "Case file",
        type: "file",
      }),
    );
  a.store.saveModel("local", localActor, fileModel, fileModel.revision);
  const attachmentBytes = new TextEncoder().encode(
    "%PDF-1.7 signed agreement version one",
  );
  const attachment = await attachFile(
    a.config,
    a.store,
    "local",
    localActor,
    localMatter.id,
    "caseFile",
    "Agreement.pdf",
    attachmentBytes,
  );
  a.store.saveRecord("local", localActor, {
    id: localMatter.id,
    objectId: "matters",
    revision: localMatter.revision,
    values: { caseFile: [attachment] },
  });
  await syncDevice(a.config);
  await syncDevice(a.config);
  await syncDevice(b.config);
  assert.equal(a.store.syncState(scope).pending, 0);
  assert.deepEqual(b.store.raw(scope, localMatter.id)?.values.clients, [
    client.id,
  ]);
  assert.equal(
    b.store.raw(scope, link.id)?.values.projectId,
    `ws_${settings.member}`,
  );
  assert.ok(b.store.raw(scope, localMatter.id)?.values.caseFile, JSON.stringify({
    localFile: !!a.store.raw("local", localMatter.id)?.values.caseFile,
    stagedFile: !!a.store.raw(scope, localMatter.id)?.values.caseFile, sync: a.store.syncState(scope),
    pending: a.store.pending(scope, 10, a.actor).map(entry => entry.error),
  }));
  for (const id of contacts) assert.ok(b.store.raw(scope, id));
  const linkedField = (await readProjectDetails(projectPath)).fields[0];
  assert.deepEqual(linkedField.value, { directoryId: backOfficeDirectoryKey(settings.url, scope), recordIds: [localMatter.id] });
  const revision = (await readProjectDetails(projectPath)).revision;
  await syncDevice(a.config);
  assert.equal((await readProjectDetails(projectPath)).revision, revision);
  assert.equal(a.store.syncState(scope).pending, 0);
  const receivedFile = BackOfficeFilesSchema.parse(
    b.store.raw(scope, localMatter.id)?.values.caseFile,
  )[0];
  assert.equal(receivedFile.id, attachment.id);
  assert.equal(await cachedFile(b.config, receivedFile, b.store, scope, (await backOfficeAccess(b.config, true)).actor), null);
  assert.deepEqual(
    await loadAttachedFile(b.config, scope, receivedFile),
    attachmentBytes,
  );
  const created = a.store.saveRecord(scope, a.actor, {
    objectId: "people",
    revision: 0,
    values: { name: "Mara" },
  });
  await syncDevice(a.config);
  await syncDevice(b.config);
  assert.equal(a.store.syncState(scope).pending, 0);
  assert.equal(b.store.raw(scope, created.id)?.values.name, "Mara");

  // Two offline desktops edit one revision. The losing edit stays durable for review.
  a.store.saveRecord(scope, a.actor, {
    ...created,
    values: { name: "Mara Weber" },
  });
  b.store.saveRecord(scope, b.actor, {
    ...created,
    values: { email: "mara@example.test" },
  });
  await syncDevice(a.config);
  await syncDevice(b.config);
  assert.equal(b.store.syncState(scope).pending, 1);
  assert.match(
    b.store.syncState(scope).error ?? "",
    /changed on another device/,
  );
  const operation = b.store.pending(scope)[0].change.id;
  const intent = b.store.queuedRecordIntent(scope, operation);
  const latest = await backOfficePlatform(b.config);
  b.store.discardQueued(scope, operation);
  b.store.receive(scope, latest, b.actor);
  await refreshDeviceActor(b.config);
  const authoritative = b.store.raw(scope, created.id);
  assert.ok(authoritative);
  b.store.saveRecord(scope, b.actor, {
    ...authoritative,
    values: Object.fromEntries(
      intent.fields.map((key) => [key, intent.record.values[key]]),
    ),
  });
  await syncDevice(b.config);
  await syncDevice(a.config);
  assert.deepEqual(a.store.raw(scope, created.id)?.values, {
    name: "Mara Weber",
    email: "mara@example.test",
    active: true,
    personType: "External contact",
  });

  // More than one API batch must not delete unsent creations on a full-snapshot pull.
  for (let index = 0; index < 101; index++)
    a.store.saveRecord(scope, a.actor, {
      objectId: "people",
      revision: 0,
      values: { name: `Batch person ${index}` },
    });
  await syncDevice(a.config);
  await syncDevice(a.config);
  await syncDevice(b.config);
  assert.equal(a.store.syncState(scope).pending, 0);
  assert.equal(b.store.records(scope, b.actor, "people").length, contacts.length + 102);

  // One batch contains a model operation followed by a record using its new field.
  const model = a.store.model(scope);
  model.objects[0].fields.push({
    id: "firmReference",
    label: "Firm reference",
    type: "text",
    protected: false,
    required: false,
    multiple: false,
    options: [],
    visibility: "normal",
  });
  a.store.saveModel(scope, a.actor, model, model.revision);
  const matter = a.store.saveRecord(scope, a.actor, {
    objectId: "matters",
    revision: 0,
    values: { name: "Case", firmReference: "Preserve" },
  });
  await syncDevice(a.config);
  await syncDevice(b.config);
  assert.equal(a.store.syncState(scope).error, null);
  assert.equal(b.store.raw(scope, matter.id)?.values.firmReference, "Preserve");
  const laterLocal = a.store.saveRecord("local", localActor, {
    objectId: "people",
    revision: 0,
    values: { name: "Later local contact" },
  });
  await syncDevice(a.config);
  await syncDevice(a.config);
  await syncDevice(b.config);
  assert.equal(
    b.store.raw(scope, laterLocal.id)?.values.name,
    "Later local contact",
  );
  assert.equal(b.store.raw(scope, matter.id)?.values.firmReference, "Preserve");

  const savedViews = ["table", "kanban", "calendar", "list"].map((type) =>
    a.store.saveView(
      scope,
      a.actor,
      BackOfficeViewSchema.parse({
        id: crypto.randomUUID(),
        objectId: "matters",
        name: type,
        type,
        groupField: "status",
        dateField: "openedOn",
        columns: ["name", "status", "openedOn"],
      }),
    ),
  );
  const historyTarget = { type: "record", id: matter.id } satisfies {
    type: "record";
    id: string;
  };
  const remoteHistory = BackOfficeHistoryPageSchema.parse(
    await platformBackOfficeHistory(a.config, a.store, scope, historyTarget, {
      limit: 1,
      cursor: null,
      export: false,
    }),
  );
  assert.equal(remoteHistory.source, "platform");
  assert.ok(remoteHistory.items.length > 0);
  const remoteExport = BackOfficeHistoryExportSchema.parse(
    await platformBackOfficeHistory(a.config, a.store, scope, historyTarget, {
      limit: 1,
      cursor: null,
      export: true,
    }),
  );
  assert.equal(verifyBackOfficeHistoryExport(remoteExport).chainsValid, true);
  assert.equal(
    verifyBackOfficeHistoryExport(remoteExport).fullyAnchored,
    false,
  );
  await syncDevice(a.config);
  await syncDevice(b.config);
  assert.deepEqual(
    b.store
      .views(scope)
      .map((view) => view.type)
      .sort(),
    ["calendar", "kanban", "list", "table"],
    JSON.stringify({
      first: a.store.syncState(scope),
      second: b.store.syncState(scope),
    }),
  );
  a.store.saveView(scope, a.actor, {
    ...savedViews[1],
    expected: savedViews[1],
    name: "Renamed board",
    archived: true,
  });
  await syncDevice(a.config);
  await syncDevice(b.config);
  assert.equal(
    b.store.views(scope).find((view) => view.id === savedViews[1].id)?.archived,
    true,
  );

  // Reopening retains queued work, removes retired fields and keeps firm labels.
  const local = a.store.model("local");
  local.templateVersion = 2;
  const clientObject = local.objects.find((object) => object.id === "clients");
  assert.ok(clientObject);
  clientObject.fields.push({
    ...clientObject.fields[0],
    id: "actaportId",
    label: "Actaport ID",
    required: false,
  });
  clientObject.plural = "Firm clients";
  a.store.transaction(() =>
    a.store.db.run("UPDATE bo_models SET data=? WHERE scope='local'", [
      JSON.stringify(local),
    ]),
  );
  a.store.saveRecord(scope, a.actor, {
    objectId: "companies",
    revision: 0,
    values: { name: "Durable offline draft" },
  });
  const reopened = new BackOfficeStore(
    await openSqlite(runtimeDbPath(a.config)),
    a.store.journal.storage,
  );
  assert.equal(reopened.syncState(scope).pending, 1);
  assert.equal(reopened.db.get("SELECT count(*) AS n FROM bo_first_sync WHERE confirmed=1 AND principal=?", [a.actor.principalKey!])?.n, 26);

  assert.equal(
    reopened.model("local").objects.find((object) => object.id === "clients")
      ?.plural,
    "Firm clients",
  );
  assert.equal(
    reopened
      .model("local")
      .objects.find((object) => object.id === "clients")
      ?.fields.some((field) => field.id === "actaportId"),
    false,
  );
  reopened.close();

  // A real platform rejection removes the managed replica and retains the proposal.
  const revoked = await fetch(`${settings.url}/test/revoke`, {
    method: "POST",
  });
  assert.equal(revoked.status, 200);
  await syncBackOffice(a.config);
  assert.equal(a.store.syncState(scope).enabled, false);
  assert.equal(a.store.db.get("SELECT count(*) AS n FROM bo_records WHERE scope=?", [scope])?.n, 0);
  assert.equal(a.store.syncState(scope).pending, 1);
  assert.ok(a.store.pending(scope)[0].error);
  await scheduleOrgPolicySync(a.config, { force: true });
  assert.equal((await backOfficeAccess(a.config)).scope, "local");
  BackOfficeSnapshotSchema.parse(latest);
  console.log(
    "BACK_OFFICE_INTEGRATION_OK: two devices, conflicts, model ordering, persisted migration, revocation",
  );
}

async function verifyScale(scale: NonNullable<typeof settings.scale>) {
  const writer = await device(settings.admin);
  const peer = await device(settings.member);
  const scope = settings.orgId;
  const timed = async (task: () => Promise<void>) => {
    const start = performance.now();
    await task();
    return Math.round(performance.now() - start);
  };
  const firstSyncMs: number[] = [];
  for (const replica of [writer, peer]) {
    firstSyncMs.push(await timed(() => syncDevice(replica.config)));
    const rows = replica.store.db.all(
      "SELECT id,json_extract(data,'$.values.name') AS name FROM bo_records WHERE scope=? ORDER BY id", [scope],
    ).map(({id, name}) => [id, name]);
    assert.equal(rows.length, scale.size);
    assert.equal(createHash("sha256").update(JSON.stringify(rows)).digest("hex"), scale.digest);
  }
  const idleMs = await timed(() => syncDevice(peer.config));
  const record = writer.store.raw(scope, scale.id);
  assert.ok(record);
  const start = performance.now();
  writer.store.saveRecord(scope, writer.actor, {
    id: scale.id, objectId: record.objectId, revision: record.revision, values: {name: "Edited on first device"},
  });
  const localSaveMs = Math.round(performance.now() - start);
  const uploadMs = await timed(() => syncDevice(writer.config));
  assert.equal(writer.store.pending(scope, 1, writer.actor).length, 0);
  const peerMs = await timed(() => syncDevice(peer.config));
  assert.equal(peer.store.raw(scope, scale.id)?.values.name, "Edited on first device");
  console.log("BACK_OFFICE_INTEGRATION_OK", JSON.stringify({ records: scale.size, firstSyncMs, idleMs, localSaveMs, uploadMs, peerMs }));
}

try {
  if (settings.scale) await verifyScale(settings.scale);
  else await verifyLifecycle();
} finally {
  for (const config of configs) {
    await resetOrgPolicyRuntimeForTests(config);
    await closeEigenweltConnectionForTests(config);
  }
  for (const store of stores) store.close();
  await rm(root, { recursive: true, force: true });
}
