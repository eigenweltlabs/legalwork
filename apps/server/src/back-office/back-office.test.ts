import { afterEach, describe, expect, test } from "bun:test";
import { BackOfficeStore } from "./store.js";
import { openSqlite } from "../runtime-db.js";
import {
  defaultBackOfficeModel,
  upgradeBackOfficeModel,
  backOfficeProjectContext,
  type BackOfficeActor,
  type BackOfficeRecord,
  type BackOfficeSnapshot,
} from "./schema.js";
import { applyImport, parseCsv, previewImport } from "./import.js";
import { mergePublishModel } from "./publish-model.js";

const owner: BackOfficeActor = {
  userId: "owner",
  model: true,
  edit: true,
  finance: true,
};
const member: BackOfficeActor = {
  userId: "member",
  model: false,
  edit: true,
  finance: false,
};
test("publishing preserves shared fields and labels while adding local extensions", () => {
  const source = defaultBackOfficeModel(),
    team = defaultBackOfficeModel();
  team.objects[0].plural = "Firm matters";
  const field = {
    id: "sharedOnly",
    label: "Shared only",
    type: "text",
    protected: false,
    required: false,
    multiple: false,
    options: [],
    visibility: "normal",
  } satisfies (typeof team.objects)[0]["fields"][number];
  team.objects[0].fields.push(field);
  source.objects[0].fields.push({ ...field, id: "localOnly" });
  const merged = mergePublishModel(source, team);
  expect(merged.objects[0].plural).toBe("Firm matters");
  expect(merged.objects[0].fields.map((field) => field.id)).toEqual(
    expect.arrayContaining(["sharedOnly", "localOnly"]),
  );
  expect(team.objects[0].fields.some((field) => field.id === "localOnly")).toBe(
    false,
  );
});
test("publishing rejects conflicting field types or visibility without changing the model", () => {
  const source = defaultBackOfficeModel(),
    team = defaultBackOfficeModel();
  source.objects[0].fields[0].visibility = "finance";
  expect(() => mergePublishModel(source, team)).toThrow(
    "different local definition",
  );
  expect(team.objects[0].fields[0].visibility).toBe("normal");
});
const opened: BackOfficeStore[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});
async function database() {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  opened.push(store);
  return store;
}
function add(
  store: BackOfficeStore,
  objectId: string,
  name: string,
  values = {},
) {
  return store.saveRecord("local", owner, {
    objectId,
    revision: 0,
    values: { name, ...values },
  });
}
const snapshot = (
  records: BackOfficeRecord[],
  accepted: string[] = [],
): BackOfficeSnapshot => ({
  protocol: 1,
  model: defaultBackOfficeModel(),
  records,
  views: [],
  cursor: 1,
  accepted,
  conflicts: [],
});

describe("Back Office records and protected model", () => {
  test("installs the starter once and preserves existing records", async () => {
    const store = await database();
    const model = store.model("local");
    add(store, "people", "Mara");
    expect(store.model("local")).toEqual(model);
    expect(store.records("local", owner).length).toBe(1);
  });
  test("a project can link to several matters and each matter to several projects", async () => {
    const store = await database(),
      a = add(store, "matters", "Acquisition"),
      b = add(store, "matters", "Employment");
    add(store, "projectLinks", "Project A", {
      projectId: "project-a",
      matter: a.id,
    });
    add(store, "projectLinks", "Project A", {
      projectId: "project-a",
      matter: b.id,
    });
    add(store, "projectLinks", "Project B", {
      projectId: "project-b",
      matter: a.id,
    });
    expect(store.records("local", owner, "projectLinks").length).toBe(3);
    expect(() =>
      add(store, "projectLinks", "Duplicate", {
        projectId: "project-a",
        matter: a.id,
      }),
    ).toThrow("already linked");
  });
  test("a stale edit never overwrites a newer value", async () => {
    const store = await database(),
      record = add(store, "companies", "Company");
    store.saveRecord("local", owner, {
      ...record,
      revision: record.revision,
      values: { industry: "Software" },
    });
    expect(() =>
      store.saveRecord("local", owner, { ...record, values: { name: "Old" } }),
    ).toThrow("changed");
    expect(store.raw("local", record.id)?.values.industry).toBe("Software");
  });
  test("field patches preserve values unknown to an older client", async () => {
    const store = await database(),
      record = add(store, "matters", "Matter", {
        externalReference: "External",
      });
    store.saveRecord("local", owner, {
      ...record,
      values: { name: "Renamed" },
    });
    expect(store.raw("local", record.id)?.values.externalReference).toBe(
      "External",
    );
  });
  test("protects system relationships and field visibility", async () => {
    const store = await database(),
      model = store.model("local"),
      next = structuredClone(model);
    next.objects[0].fields.find((field) => field.id === "clients")!.multiple =
      false;
    expect(() => store.saveModel("local", owner, next, model.revision)).toThrow(
      "protected",
    );
    expect(store.model("local").revision).toBe(1);
  });
  test("permits additive fields and rejects destructive changes to populated fields", async () => {
    const store = await database(),
      model = store.model("local"),
      next = structuredClone(model);
    next.objects[0].fields.push({
      id: "customReference",
      label: "Custom reference",
      type: "text",
      protected: false,
      required: false,
      multiple: false,
      options: [],
      visibility: "normal",
    });
    const saved = store.saveModel("local", owner, next, model.revision);
    const matter = add(store, "matters", "Case", { customReference: "Value" });
    const changed = structuredClone(saved);
    changed.objects[0].fields = changed.objects[0].fields.filter(
      (field) => field.id !== "customReference",
    );
    expect(() =>
      store.saveModel("local", owner, changed, saved.revision),
    ).toThrow("migration");
    expect(store.raw("local", matter.id)?.values.customReference).toBe("Value");
  });
  test("separates finance and private notes and enforces those permissions on writes", async () => {
    const store = await database(),
      record = add(store, "timeEntries", "Draft", {
        privateNote: "Internal strategy",
        hourlyRate: { amountMinor: 30000, currency: "EUR" },
        billingNarrative: "Review",
      });
    const viewer = { ...member, userId: owner.userId };
    const visible = store.records("local", viewer, "timeEntries")[0];
    expect(visible.values.privateNote).toBe("Internal strategy");
    const reviewer = store.records(
      "local",
      { ...member, finance: true },
      "timeEntries",
    )[0];
    expect(reviewer.values.privateNote).toBeUndefined();
    expect(reviewer.values.hourlyRate).toEqual({
      amountMinor: 30000,
      currency: "EUR",
    });
    expect(visible.values.hourlyRate).toBeUndefined();
    expect(visible.values.billingNarrative).toBe("Review");
    expect(() =>
      store.saveRecord("local", viewer, {
        ...record,
        values: { hourlyRate: { amountMinor: 100, currency: "EUR" } },
      }),
    ).toThrow("cannot edit");
  });
  test("restricted matters hide their linked time records", async () => {
    const store = await database(),
      matter = store.saveRecord("local", owner, {
        objectId: "matters",
        revision: 0,
        access: "members",
        values: { name: "Private matter" },
      });
    add(store, "timeEntries", "Work", { matter: matter.id });
    expect(store.records("local", member)).toEqual([]);
  });
  test("archive and restore keep identity and audit the operation", async () => {
    const store = await database(),
      record = add(store, "people", "Mara");
    const archived = store.saveRecord("local", owner, {
      ...record,
      values: {},
      archived: true,
    });
    expect(store.records("local", owner)).toEqual([]);
    const restored = store.saveRecord("local", owner, {
      ...archived,
      values: {},
      archived: false,
    });
    expect(restored.id).toBe(record.id);
    expect(store.history("local", owner, record.id)).toHaveLength(3);
  });
});
describe("Back Office imports and synchronization", () => {
  test("CSV parsing preserves quoted commas, quotes and line breaks", () => {
    expect(
      parseCsv('name,note\r\n"Mara, Weber","One\nTwo ""quoted"""'),
    ).toEqual([
      ["name", "note"],
      ["Mara, Weber", 'One\nTwo "quoted"'],
    ]);
  });
  test("CSV preview detects invalid rows and commit is atomic", async () => {
    const store = await database();
    const plan = previewImport(
      store,
      "local",
      owner,
      "people",
      "name,email\nMara,invalid",
      { name: "name", email: "email" },
    );
    expect(plan.valid).toBe(false);
    expect(() => applyImport(store, "local", owner, plan.planId)).toThrow();
    expect(store.records("local", owner)).toEqual([]);
  });
  test("matching names warn but matching source IDs update", async () => {
    const store = await database(),
      record = add(store, "companies", "Company", { actaportId: "42" });
    const plan = previewImport(
      store,
      "local",
      owner,
      "companies",
      "name,external\nNew name,42",
      { name: "name", actaportId: "external" },
    );
    const imported = applyImport(store, "local", owner, plan.planId);
    expect(imported[0].id).toBe(record.id);
    expect(store.records("local", owner)).toHaveLength(1);
  });
  test("a changed record invalidates the reviewed CSV plan", async () => {
    const store = await database();
    const plan = previewImport(store, "local", owner, "people", "name\nMara", {
      name: "name",
    });
    add(store, "people", "Jonas");
    expect(() => applyImport(store, "local", owner, plan.planId)).toThrow(
      "Preview again",
    );
  });
  test("replayed accepted operations disappear from the outbox once", async () => {
    const store = await database();
    const record = store.saveRecord("firm", owner, {
      objectId: "people",
      revision: 0,
      values: { name: "Mara" },
    });
    const id = store.pending("firm")[0].change.id;
    store.receive("firm", snapshot([record], [id]));
    store.receive("firm", snapshot([record], [id]));
    expect(store.pending("firm")).toEqual([]);
    expect(store.records("firm", owner)).toHaveLength(1);
  });
  test("an access revocation removes the live replica and retains a queued draft", async () => {
    const store = await database();
    const record = store.saveRecord("firm", owner, {
      objectId: "matters",
      revision: 0,
      values: { name: "Case" },
    });
    store.receive(
      "firm",
      snapshot([record], [store.pending("firm")[0].change.id]),
    );
    store.saveRecord("firm", owner, {
      id: record.id,
      objectId: "matters",
      revision: 1,
      values: { name: "Local edit" },
    });
    store.receive("firm", snapshot([]));
    expect(store.records("firm", owner)).toEqual([]);
    expect(store.pending("firm")).toHaveLength(1);
  });
});

describe("Back Office compatibility, previews and isolation", () => {
  test("the next template adds fields without replacing firm labels or extensions", () => {
    const current = defaultBackOfficeModel();
    current.objects[0].plural = "Firm matters";
    current.objects[0].fields.push({
      id: "custom",
      label: "Firm reference",
      type: "text",
      protected: false,
      required: false,
      multiple: false,
      options: [],
      visibility: "normal",
    });
    const baseline = defaultBackOfficeModel();
    baseline.templateVersion = current.templateVersion + 1;
    baseline.objects[0].fields.push({
      id: "future",
      label: "Future reference",
      type: "text",
      protected: true,
      required: false,
      multiple: false,
      options: [],
      visibility: "normal",
    });
    const next = upgradeBackOfficeModel(current, baseline);
    expect(next.objects[0].plural).toBe("Firm matters");
    expect(next.objects[0].fields.map((field) => field.id)).toContain("custom");
    expect(next.objects[0].fields.map((field) => field.id)).toContain("future");
    expect(upgradeBackOfficeModel(next, baseline)).toEqual(next);
  });
  test("model preview reports affected records and never changes the stored model", async () => {
    const store = await database();
    add(store, "matters", "Case");
    const model = store.model("local"),
      candidate = structuredClone(model);
    candidate.objects[0].label = "File";
    const preview = store.previewModel(
      "local",
      owner,
      candidate,
      model.revision,
    );
    expect(preview.valid).toBe(true);
    expect(preview.changes[0].records).toBe(1);
    expect(store.model("local")).toEqual(model);
    candidate.objects[0].fields.find((field) => field.id === "name")!.required =
      false;
    expect(
      store.previewModel("local", owner, candidate, model.revision).valid,
    ).toBe(false);
  });
  test("a bounded sync round preserves more than 100 unsent local creations", async () => {
    const store = await database();
    const records = [];
    for (let index = 0; index < 101; index++)
      records.push(
        store.saveRecord("firm", owner, {
          objectId: "people",
          revision: 0,
          values: { name: `Person ${index}` },
        }),
      );
    const accepted = store.pending("firm").map((entry) => entry.change.id);
    store.receive("firm", snapshot(records.slice(0, 100), accepted));
    expect(store.syncState("firm").pending).toBe(1);
    expect(store.records("firm", owner)).toHaveLength(101);
  });
  test("server permission rejection clears the team replica and blocks queued writes", async () => {
    const store = await database();
    store.setSync("firm", true);
    store.saveRecord("firm", owner, {
      objectId: "people",
      revision: 0,
      values: { name: "Queued" },
    });
    store.suspendTeam("firm", "Access revoked");
    expect(store.records("firm", owner)).toEqual([]);
    expect(store.pending("firm")[0].error).toBe("Access revoked");
    expect(store.syncState("firm").enabled).toBe(false);
  });
  test("client roles are distinct from billing recipients in project context", async () => {
    const store = await database(),
      client = add(store, "clients", "Client"),
      recipient = add(store, "clients", "Insurer"),
      matter = add(store, "matters", "Case");
    add(store, "parties", "Mandant", {
      matter: matter.id,
      role: "Client",
      client: client.id,
    });
    add(store, "parties", "Payor", {
      matter: matter.id,
      role: "Billing recipient",
      client: recipient.id,
    });
    add(store, "projectLinks", "Project", {
      projectId: "project-a",
      matter: matter.id,
    });
    expect(
      backOfficeProjectContext(
        store.records("local", owner),
        "project-a",
      ).clients.map((record) => record.id),
    ).toEqual([client.id]);
    expect(
      backOfficeProjectContext(store.records("local", owner), "unlinked")
        .matters,
    ).toEqual([]);
  });
  test("CSV relations resolve explicit source IDs and reject name guesses and duplicate sources", async () => {
    const store = await database(),
      client = add(store, "clients", "Client", { actaportId: "42" });
    const plan = previewImport(
      store,
      "local",
      owner,
      "matters",
      "name,client\nCase,actaport:42",
      { name: "name", clients: "client" },
    );
    expect(plan.valid).toBe(true);
    expect(
      applyImport(store, "local", owner, plan.planId)[0].values.clients,
    ).toEqual([client.id]);
    expect(
      previewImport(
        store,
        "local",
        owner,
        "matters",
        "name,client\nCase,Client",
        { name: "name", clients: "client" },
      ).valid,
    ).toBe(false);
    expect(
      previewImport(store, "local", owner, "people", "name,id\nA,42\nB,42", {
        name: "name",
        actaportId: "id",
      }).valid,
    ).toBe(false);
  });
  test("invalid relation imports leave the directory unchanged", async () => {
    const store = await database();
    const plan = previewImport(
      store,
      "local",
      owner,
      "matters",
      "name,parent\nA,missing",
      { name: "name", parentMatter: "parent" },
    );
    expect(plan.valid).toBe(false);
    expect(() => applyImport(store, "local", owner, plan.planId)).toThrow();
    expect(store.records("local", owner)).toEqual([]);
  });
});

test("conflict review combines queued field edits and discarding leaves unrelated edits intact", async () => {
  const store = await database();
  const record = store.saveRecord("firm", owner, {
    objectId: "people",
    revision: 0,
    values: { name: "Mara" },
  });
  store.receive(
    "firm",
    snapshot([record], [store.pending("firm")[0].change.id]),
  );
  const renamed = store.saveRecord("firm", owner, {
    id: record.id,
    objectId: "people",
    revision: 1,
    values: { name: "Mara Weber" },
  });
  store.saveRecord("firm", owner, {
    id: record.id,
    objectId: "people",
    revision: renamed.revision,
    values: { email: "mara@example.test" },
  });
  store.saveRecord("firm", owner, {
    objectId: "people",
    revision: 0,
    values: { name: "Other draft" },
  });
  const operation = store.pending("firm")[0].change.id,
    intent = store.queuedRecordIntent("firm", operation);
  expect(intent.fields.sort()).toEqual(["email", "name"]);
  expect(intent.record.values.email).toBe("mara@example.test");
  store.discardQueued("firm", operation);
  expect(store.pending("firm")).toHaveLength(1);
  expect(
    store.records("firm", owner).map((record) => record.values.name),
  ).toEqual(["Other draft"]);
});
