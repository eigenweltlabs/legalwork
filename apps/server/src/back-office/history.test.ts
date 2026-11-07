import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeStore } from "./store.js";
import {
  localBackOfficeHistoryExport,
  localBackOfficeHistoryPage,
} from "./history.js";
import {
  signBackOfficeHistoryExport,
  verifyBackOfficeHistoryExport,
} from "./history-export.js";
import {
  BackOfficeObjectSchema,
  BackOfficeStoredRecordSchema,
  defaultBackOfficeModel,
  z,
  type BackOfficeActor,
} from "./schema.js";
import { registerBackOfficeRoutes } from "./routes.js";
import {
  matchRoute,
  type Route,
  type RequestContext,
} from "../routes/registry.js";
import { ApiError } from "../errors.js";
import { backOfficeAuditStateHash } from "./audit-integrity.js";
import type { ServerConfig } from "../types.js";

const owner: BackOfficeActor = {
  userId: "lawyer",
  edit: true,
  model: true,
  finance: true,
};
const reviewer: BackOfficeActor = {
  userId: "reviewer",
  edit: true,
  model: true,
  finance: false,
};

test("redacted exports resist guessing hidden rates even using a later fully disclosed state nonce", async () => {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  try {
    const model = store.model("local");
    model.objects.push(BackOfficeObjectSchema.parse({ id: "rates", label: "Rate", plural: "Rates", fields: [
      { id: "name", label: "Name", type: "text", required: true },
      { id: "rate", label: "Rate", type: "currency", visibility: "finance" },
    ] }));
    store.saveModel("local", owner, model, model.revision);
    let record = store.saveRecord("local", owner, { objectId: "rates", revision: 0, values: { name: "Synthetic review", rate: { amountMinor: 37500, currency: "EUR" } } });
    const target = { type: "record", id: record.id } satisfies Parameters<typeof localBackOfficeHistoryExport>[3];
    const hidden = localBackOfficeHistoryExport(store, "local", reviewer, target).body.items[0];
    expect(hidden.payload).toBeNull();
    const values = { ...record.values };
    delete values.rate;
    record = { ...record, values, revision: record.revision + 1 };
    store.transaction(() => store.db.run("UPDATE bo_records SET data=? WHERE scope='local' AND id=?", [JSON.stringify(record), record.id]));
    store.saveRecord("local", owner, { id: record.id, objectId: "rates", revision: record.revision, values: { name: "Public review" } });
    const exported = localBackOfficeHistoryExport(store, "local", reviewer, target);
    const publicItem = exported.body.items.find(item => item.payload !== null)!;
    expect(publicItem.payload).not.toBeNull();
    const nonce = publicItem.payload!.afterNonce;
    const displayed = BackOfficeStoredRecordSchema.parse(hidden.after);
    for (let amountMinor = 10000; amountMinor <= 70000; amountMinor += 500) {
      const guessed = z.json().parse({ ...displayed, values: { ...displayed.values, rate: { amountMinor, currency: "EUR" } } });
      expect(backOfficeAuditStateHash(guessed, nonce)).not.toBe(hidden.proof.afterHash);
    }
    expect(verifyBackOfficeHistoryExport(exported).chainsValid).toBe(true);
    const nonces = store.journal.evidence("local").entries.filter(item => item.payload.entityId === record.id).map(item => item.payload.afterNonce);
    expect(new Set(nonces).size).toBe(nonces.length);
  } finally { store.close(); }
});

test("export verification stays authenticated and read-only when the current history store is damaged", async () => {
  const { store, target } = await fixture();
  const exported = localBackOfficeHistoryExport(store, "local", owner, target);
  const root = await mkdtemp(join(tmpdir(), "legalwork-history-damaged-"));
  try {
    store.db.exec("DROP TRIGGER bo_records_journal_guard_UPDATE");
    store.db.run("VACUUM INTO ?", [join(root, "runtime.sqlite")]);
    const config: ServerConfig = {
      configPath: join(root, "server.json"),
      host: "127.0.0.1",
      port: 0,
      token: "viewer",
      hostToken: "host",
      approval: { mode: "auto", timeoutMs: 1000 },
      corsOrigins: [],
      workspaces: [],
      authorizedRoots: [],
      readOnly: true,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    };
    const routes: Route[] = [];
    registerBackOfficeRoutes({
      routes,
      config,
      jsonResponse: (data, status) => Response.json(data, { status }),
      readJsonBodyLimited: async (request) => {
        const body: unknown = await request.json();
        return z.record(z.string(), z.unknown()).parse(body);
      },
      requireClientScope: (ctx, scope) => {
        expect(scope).toBe("viewer");
        if (ctx.request.headers.get("authorization") !== "Bearer viewer")
          throw new ApiError(403, "forbidden", "Missing viewer authorization");
      },
      ensureWritable: () => {
        throw new Error("Verification must not require writable mode");
      },
      resolveWorkspace: async () => {
        throw new Error("Verification must not open a workspace");
      },
    });
    const path = "/back-office/history/verify",
      route = matchRoute(routes, "POST", path)!;
    expect(route.auth).toBe("client");
    const request = new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer viewer",
        "content-type": "application/json",
      },
      body: JSON.stringify({ exported }),
    });
    const context: RequestContext = {
      request,
      url: new URL(request.url),
      params: route.params,
      config,
      get approvals(): RequestContext["approvals"] {
        throw new Error("Unused approval service");
      },
      get reloadEvents(): RequestContext["reloadEvents"] {
        throw new Error("Unused event service");
      },
      get tokens(): RequestContext["tokens"] {
        throw new Error("Unused token service");
      },
    };
    const response = await route.handler(context);
    expect(await response.json()).toMatchObject({
      signatureValid: true,
      chainsValid: true,
      fullyAnchored: false,
    });
    const tampered = structuredClone(exported);
    tampered.signature =
      (tampered.signature.startsWith("A") ? "B" : "A") +
      tampered.signature.slice(1);
    context.request = new Request(request.url, {
      method: "POST",
      headers: {
        authorization: "Bearer viewer",
        "content-type": "application/json",
      },
      body: JSON.stringify({ exported: tampered }),
    });
    await expect(route.handler(context)).rejects.toMatchObject({
      status: 400,
      code: "back_office_history_verification",
    });
    context.request = new Request(request.url, { method: "POST" });
    await expect(route.handler(context)).rejects.toThrow(
      "Missing viewer authorization",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const stores: BackOfficeStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
async function fixture() {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  stores.push(store);
  const model = store.model("local");
  model.objects.push(
    BackOfficeObjectSchema.parse({
      id: "reviews",
      label: "Review",
      plural: "Reviews",
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "summary", label: "Summary at creation", type: "text" },
        {
          id: "financial",
          label: "Confidential fee",
          type: "text",
          visibility: "finance",
        },
        {
          id: "notes",
          label: "Private work note",
          type: "text",
          visibility: "private",
        },
        {
          id: "company",
          label: "Company",
          type: "relation",
          target: "companies",
        },
        { id: "matter", label: "Matter", type: "relation", target: "matters" },
      ],
    }),
  );
  store.saveModel("local", owner, model, model.revision);
  const record = store.saveRecord("local", owner, {
    objectId: "reviews",
    revision: 0,
    values: {
      name: "Review",
      summary: "Original wording",
      financial: "Never disclose this fee",
      notes: "Never disclose these work notes",
    },
  });
  const target = { type: "record", id: record.id } satisfies {
    type: "record";
    id: string;
  };
  return { store, record, target };
}

test("model and saved-view history enforce their own permissions without exposing filter values", async () => {
  const { store } = await fixture();
  const view = {
    id: crypto.randomUUID(),
    objectId: "reviews",
    name: "Review list",
    columns: ["name", "financial", "notes"],
    filters: {
      financial: "Hidden financial filter",
      notes: "Hidden private filter",
    },
    query: "Hidden saved search",
  };
  store.saveView("local", owner, view);
  const page = localBackOfficeHistoryPage(store, "local", reviewer, {
    type: "view",
    id: view.id,
  });
  expect(page.items).toHaveLength(1);
  expect(JSON.stringify(page)).not.toContain("Hidden");
  expect(page.items[0]).toMatchObject({ redacted: true, payload: null });
  const model = localBackOfficeHistoryExport(store, "local", reviewer, {
    type: "model",
    id: "model",
  });
  expect(JSON.stringify(model)).not.toContain("Never disclose");
  expect(() =>
    localBackOfficeHistoryPage(
      store,
      "local",
      { ...reviewer, model: false },
      { type: "model", id: "model" },
    ),
  ).toThrow("administrator");
  expect(() =>
    localBackOfficeHistoryExport(
      store,
      "local",
      { ...reviewer, model: false },
      { type: "model", id: "model" },
    ),
  ).toThrow("administrator");
});

test("legacy baseline enumeration does not hide an existing parent stored after its child", async () => {
  const db = await openSqlite(":memory:");
  db.exec(
    "CREATE TABLE bo_models(scope TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE bo_records(scope TEXT NOT NULL,id TEXT NOT NULL,object_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,id))",
  );
  const model = defaultBackOfficeModel(),
    companyId = crypto.randomUUID();
  db.run("INSERT INTO bo_models VALUES('local',?)", [JSON.stringify(model)]);
  const child = BackOfficeStoredRecordSchema.parse({
    id: crypto.randomUUID(),
    objectId: "people",
    values: { name: "Existing contact", company: companyId },
    revision: 1,
    schemaRevision: model.revision,
    ownerId: owner.userId,
    createdAt: "2025-01-02T09:00:00.000Z",
    updatedAt: "2025-01-02T09:00:00.000Z",
    archivedAt: null,
  });
  const parent = {
    ...child,
    id: companyId,
    objectId: "companies",
    values: { name: "Existing company" },
  };
  for (const record of [child, parent])
    db.run("INSERT INTO bo_records VALUES('local',?,?,?)", [
      record.id,
      record.objectId,
      JSON.stringify(record),
    ]);
  const store = new BackOfficeStore(db);
  stores.push(store);
  const page = localBackOfficeHistoryPage(store, "local", owner, {
    type: "record",
    id: child.id,
  });
  expect(page.items).toHaveLength(1);
  expect(page.items[0].action).toBe("baseline.record");
  expect(
    BackOfficeStoredRecordSchema.parse(page.items[0].after).values.company,
  ).toBe(companyId);
  expect(page.items[0].recordedAt).not.toBe(child.createdAt);
});

test("history and signed exports enforce finance and private-note access independently of model administration", async () => {
  const { store, target } = await fixture();
  const page = localBackOfficeHistoryPage(store, "local", reviewer, target);
  expect(page.items).toHaveLength(1);
  expect(JSON.stringify(page)).toContain("Original wording");
  expect(JSON.stringify(page)).not.toContain("Never disclose");
  expect(page.items[0]).toMatchObject({ redacted: true, payload: null });
  const exported = localBackOfficeHistoryExport(
    store,
    "local",
    reviewer,
    target,
  );
  expect(JSON.stringify(exported)).not.toContain("Never disclose");
  const verified = verifyBackOfficeHistoryExport(exported);
  expect(verified).toMatchObject({
    signatureValid: true,
    chainsValid: true,
    payloadsVerified: 0,
    fullyAnchored: false,
  });
  expect(verified.payloadsWithheld).toBe(exported.body.proofs.length);
});

test("record owners can inspect private work notes without gaining finance access", async () => {
  const { store, target } = await fixture();
  const page = localBackOfficeHistoryPage(
    store,
    "local",
    { ...owner, finance: false },
    target,
  );
  expect(JSON.stringify(page)).toContain("Never disclose these work notes");
  expect(JSON.stringify(page)).not.toContain("Never disclose this fee");
});

test("a stricter current field policy also restricts values recorded when the field was public", async () => {
  const { store, target } = await fixture();
  const model = store.model("local");
  model.objects
    .find((object) => object.id === "reviews")!
    .fields.find((field) => field.id === "summary")!.visibility = "private";
  store.saveModel("local", owner, model, model.revision);
  expect(
    JSON.stringify(
      localBackOfficeHistoryPage(store, "local", reviewer, target),
    ),
  ).not.toContain("Original wording");
});

test("historical field labels survive renaming and removed fields need model administration plus their original permissions", async () => {
  const { store, target } = await fixture();
  const renamed = store.model("local");
  renamed.objects
    .find((object) => object.id === "reviews")!
    .fields.find((field) => field.id === "summary")!.label = "Renamed summary";
  store.saveModel("local", owner, renamed, renamed.revision);
  const model = store.model("local"),
    object = model.objects.find((object) => object.id === "reviews")!;
  store.transaction(
    () => {
      const row = store.raw("local", target.id)!;
      const { summary, ...values } = row.values;
      store.db.run(
        "UPDATE bo_records SET data=? WHERE scope='local' AND id=?",
        [
          JSON.stringify({ ...row, values, revision: row.revision + 1 }),
          row.id,
        ],
      );
    },
    { actor: owner, action: "migration.remove-summary-values" },
  );
  object.fields = object.fields.filter((field) => field.id !== "summary");
  store.saveModel("local", owner, model, model.revision);
  const administrative = localBackOfficeHistoryPage(
    store,
    "local",
    reviewer,
    target,
  );
  expect(JSON.stringify(administrative)).toContain("Summary at creation");
  expect(JSON.stringify(administrative)).toContain("Original wording");
  expect(JSON.stringify(administrative)).not.toContain("Never disclose");
  expect(
    JSON.stringify(
      localBackOfficeHistoryPage(
        store,
        "local",
        { ...reviewer, model: false },
        target,
      ),
    ),
  ).not.toContain("Original wording");
});

test("a record moved from a restricted matter does not reveal its earlier values", async () => {
  const { store, record, target } = await fixture();
  const hidden = store.saveRecord("local", owner, {
    objectId: "matters",
    revision: 0,
    values: { name: "Restricted matter" },
    access: "members",
    members: [],
  });
  const visible = store.saveRecord("local", owner, {
    objectId: "matters",
    revision: 0,
    values: { name: "Accessible matter" },
  });
  const restricted = store.saveRecord("local", owner, {
    id: record.id,
    objectId: record.objectId,
    revision: record.revision,
    values: { matter: hidden.id, summary: "Restricted before" },
  });
  store.saveRecord("local", owner, {
    id: record.id,
    objectId: record.objectId,
    revision: restricted.revision,
    values: { matter: visible.id, summary: "Accessible now" },
  });
  const page = localBackOfficeHistoryPage(store, "local", reviewer, target);
  expect(JSON.stringify(page)).not.toContain("Restricted before");
  expect(JSON.stringify(page)).not.toContain(hidden.id);
  expect(JSON.stringify(page)).toContain("Accessible now");
});

test("history does not disclose a related company whose access was revoked", async () => {
  const { store, record, target } = await fixture();
  const company = store.saveRecord("local", owner, {
    objectId: "companies",
    revision: 0,
    values: { name: "Hidden related company" },
    access: "members",
    members: [],
  });
  store.saveRecord("local", owner, {
    id: record.id,
    objectId: record.objectId,
    revision: record.revision,
    values: { company: company.id },
  });
  const exported = localBackOfficeHistoryExport(
    store,
    "local",
    reviewer,
    target,
  );
  expect(JSON.stringify(exported.body.items)).not.toContain(company.id);
  expect(JSON.stringify(exported.body.items)).not.toContain(
    "Hidden related company",
  );
});

test("revoked record access blocks history and export with the same permission check", async () => {
  const { store, record, target } = await fixture();
  store.saveRecord("local", owner, {
    id: record.id,
    objectId: record.objectId,
    revision: record.revision,
    values: {},
    access: "members",
    members: [],
  });
  expect(() =>
    localBackOfficeHistoryPage(store, "local", reviewer, target),
  ).toThrow("unavailable");
  expect(() =>
    localBackOfficeHistoryExport(store, "local", reviewer, target),
  ).toThrow("unavailable");
});

test("pagination remains stable when newer revisions are appended", async () => {
  const { store, record, target } = await fixture();
  let current = record;
  for (const summary of ["Second", "Third"])
    current = store.saveRecord("local", owner, {
      id: current.id,
      objectId: current.objectId,
      revision: current.revision,
      values: { summary },
    });
  const first = localBackOfficeHistoryPage(store, "local", owner, target, 1);
  store.saveRecord("local", owner, {
    id: current.id,
    objectId: current.objectId,
    revision: current.revision,
    values: { summary: "Fourth" },
  });
  const second = localBackOfficeHistoryPage(
    store,
    "local",
    owner,
    target,
    1,
    first.nextCursor,
  );
  expect(second.items[0].eventId).not.toBe(first.items[0].eventId);
  expect(JSON.stringify(second.items[0].after)).toContain("Second");
  expect(() =>
    localBackOfficeHistoryPage(
      store,
      "local",
      owner,
      target,
      1,
      crypto.randomUUID(),
    ),
  ).toThrow("Refresh");
});

test("an unredacted export verifies original payloads and distinguishes retained checkpoints from self-consistency", async () => {
  const { store, record, target } = await fixture();
  const old = localBackOfficeHistoryExport(store, "local", owner, target);
  expect(verifyBackOfficeHistoryExport(old).payloadsVerified).toBe(1);
  expect(verifyBackOfficeHistoryExport(old, old.body.heads).fullyAnchored).toBe(
    true,
  );
  store.saveRecord("local", owner, {
    id: record.id,
    objectId: record.objectId,
    revision: record.revision,
    values: { summary: "Later" },
  });
  const latest = localBackOfficeHistoryExport(store, "local", owner, target);
  const verified = verifyBackOfficeHistoryExport(latest, old.body.heads);
  expect(verified.fullyAnchored).toBe(false);
  expect(verified.coverage[0].trustedThrough).toBeLessThan(
    verified.coverage[0].exportedThrough,
  );
  expect(() => verifyBackOfficeHistoryExport(old, latest.body.heads)).toThrow();
});

test("export verification rejects changed displays, removed proofs and falsely unredacted payloads", async () => {
  const { store, target } = await fixture();
  const original = localBackOfficeHistoryExport(store, "local", owner, target);
  const altered = structuredClone(original);
  const record = BackOfficeStoredRecordSchema.parse(
    altered.body.items[0].after,
  );
  record.values.summary = "Forged";
  altered.body.items[0].after = JSON.parse(JSON.stringify(record));
  expect(() => verifyBackOfficeHistoryExport(altered)).toThrow("signature");
  const removed = structuredClone(original.body);
  removed.proofs.splice(1, 1);
  expect(() =>
    verifyBackOfficeHistoryExport(
      signBackOfficeHistoryExport(removed, store.journal.storage.identity),
      original.body.heads,
    ),
  ).toThrow();
  const redacted = localBackOfficeHistoryExport(
    store,
    "local",
    reviewer,
    target,
  ).body;
  redacted.items[0].redacted = false;
  expect(() =>
    verifyBackOfficeHistoryExport(
      signBackOfficeHistoryExport(redacted, store.journal.storage.identity),
    ),
  ).toThrow("marked as redacted");
});
