import { attachFile, cachedFile } from "./files.js";
import { loadAttachedFile } from "./file-sync.js";
import { BackOfficeFilesSchema, BackOfficeFieldSchema } from "./schema.js";
// Run by model-api's Back Office integration test against its disposable HTTP server.
import assert from "node:assert/strict";
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
import {
  backOfficePlatform,
  syncBackOffice,
  previewBackOfficePublish,
  publishBackOffice,
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
  })
  .parse(JSON.parse(input));
process.env.EIGENWELT_PLATFORM_URL = settings.url;
delete process.env.LEGALWORK_RUNTIME_DB;
const root = await mkdtemp(join(tmpdir(), "legalwork-bo-platform-"));
const configs: ServerConfig[] = [];
const stores: BackOfficeStore[] = [];
const actor = (userId: string): BackOfficeActor => ({
  userId,
  model: userId === settings.admin,
  edit: true,
  finance: false,
});
async function device(userId: string) {
  const directory = join(root, userId);
  await mkdir(directory);
  const config: ServerConfig = {
    configPath: join(directory, "server.json"),
    host: "127.0.0.1",
    port: 0,
    token: "integration-only",
    hostToken: "integration-only-host",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
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
  const store = await backOfficeStore(config);
  stores.push(store);
  store.setSync(settings.orgId, true);
  return { config, store, actor: actor(userId) };
}
try {
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
  const preview = await previewBackOfficePublish(a.config);
  assert.equal(preview.count, 3);
  await publishBackOffice(a.config, preview.planId);
  await syncBackOffice(b.config);
  assert.equal(a.store.syncState(scope).pending, 0);
  assert.deepEqual(b.store.raw(scope, localMatter.id)?.values.clients, [
    client.id,
  ]);
  assert.equal(
    b.store.raw(scope, link.id)?.values.projectId,
    `ws_${settings.member}`,
  );
  const receivedFile = BackOfficeFilesSchema.parse(
    b.store.raw(scope, localMatter.id)?.values.caseFile,
  )[0];
  assert.equal(receivedFile.id, attachment.id);
  assert.equal(await cachedFile(b.config, receivedFile), null);
  assert.deepEqual(
    await loadAttachedFile(b.config, scope, receivedFile),
    attachmentBytes,
  );
  const created = a.store.saveRecord(scope, a.actor, {
    objectId: "people",
    revision: 0,
    values: { name: "Mara" },
  });
  await syncBackOffice(a.config);
  await syncBackOffice(b.config);
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
  await syncBackOffice(a.config);
  await syncBackOffice(b.config);
  assert.equal(b.store.syncState(scope).pending, 1);
  assert.match(
    b.store.syncState(scope).error ?? "",
    /changed on another device/,
  );
  const operation = b.store.pending(scope)[0].change.id;
  const intent = b.store.queuedRecordIntent(scope, operation);
  const latest = await backOfficePlatform(b.config);
  b.store.discardQueued(scope, operation);
  b.store.receive(scope, latest);
  const authoritative = b.store.raw(scope, created.id);
  assert.ok(authoritative);
  b.store.saveRecord(scope, b.actor, {
    ...authoritative,
    values: Object.fromEntries(
      intent.fields.map((key) => [key, intent.record.values[key]]),
    ),
  });
  await syncBackOffice(b.config);
  await syncBackOffice(a.config);
  assert.deepEqual(a.store.raw(scope, created.id)?.values, {
    name: "Mara Weber",
    email: "mara@example.test",
  });

  // More than one API batch must not delete unsent creations on a full-snapshot pull.
  for (let index = 0; index < 101; index++)
    a.store.saveRecord(scope, a.actor, {
      objectId: "people",
      revision: 0,
      values: { name: `Batch person ${index}` },
    });
  await syncBackOffice(a.config);
  await syncBackOffice(a.config);
  await syncBackOffice(b.config);
  assert.equal(a.store.syncState(scope).pending, 0);
  assert.equal(b.store.records(scope, b.actor, "people").length, 102);

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
  await syncBackOffice(a.config);
  await syncBackOffice(b.config);
  assert.equal(a.store.syncState(scope).error, null);
  assert.equal(b.store.raw(scope, matter.id)?.values.firmReference, "Preserve");
  const laterLocal = a.store.saveRecord("local", localActor, {
    objectId: "people",
    revision: 0,
    values: { name: "Later local contact" },
  });
  const laterPreview = await previewBackOfficePublish(a.config);
  await publishBackOffice(a.config, laterPreview.planId);
  await syncBackOffice(b.config);
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
  await syncBackOffice(a.config);
  await syncBackOffice(b.config);
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
    name: "Renamed board",
    archived: true,
  });
  await syncBackOffice(a.config);
  await syncBackOffice(b.config);
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
  assert.equal(a.store.records(scope, a.actor).length, 0);
  assert.equal(a.store.syncState(scope).pending, 1);
  assert.ok(a.store.pending(scope)[0].error);
  await scheduleOrgPolicySync(a.config, { force: true });
  assert.equal((await backOfficeAccess(a.config)).scope, "local");
  BackOfficeSnapshotSchema.parse(latest);
  console.log(
    "BACK_OFFICE_INTEGRATION_OK: two devices, conflicts, model ordering, persisted migration, revocation",
  );
} finally {
  for (const config of configs) {
    await resetOrgPolicyRuntimeForTests(config);
    await closeEigenweltConnectionForTests(config);
  }
  for (const store of stores) store.close();
  await rm(root, { recursive: true, force: true });
}
