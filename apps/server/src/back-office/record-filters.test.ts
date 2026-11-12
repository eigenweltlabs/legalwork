import { expect, test } from "bun:test";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeStore } from "./store.js";
import { localBackOfficeHistoryExport } from "./history.js";
import { BackOfficeFilterCriteriaSchema, BackOfficeObjectSchema, BackOfficeRecordSchema, BackOfficeViewSchema, backOfficeFilterError, backOfficeViewFilters, matchesBackOfficeFilters, readableBackOfficeView, defaultBackOfficeModel, validateBackOfficeView, type BackOfficeFilterCriteria } from "./schema.js";

const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const object = BackOfficeObjectSchema.parse({ id: "test", label: "Record", plural: "Records", fields: [
  { id: "name", label: "Name", type: "text", required: true }, { id: "links", label: "Clients", type: "relation", target: "clients", multiple: true },
  { id: "tags", label: "Tags", type: "multiselect" }, { id: "score", label: "Score", type: "number" }, { id: "active", label: "Active", type: "boolean" },
  { id: "day", label: "Date", type: "date" }, { id: "stamp", label: "Timestamp", type: "datetime" }, { id: "amount", label: "Amount", type: "currency", visibility: "finance" },
  { id: "file", label: "Files", type: "file", multiple: true }, { id: "secret", label: "Private note", type: "text", visibility: "private" },
] });
const record = BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId: object.id, ownerId: "owner", revision: 1, schemaRevision: 1, archivedAt: null, createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z", values: {
  name: "Élan Contract", links: [first, second], tags: ["Corporate", "Urgent"], score: 0, active: false, day: "2026-11-08", stamp: "2026-11-08T11:00:00+01:00", amount: { amountMinor: 50000, currency: "EUR" },
  file: [{ id: crypto.randomUUID(), recordId: crypto.randomUUID(), fieldId: "file", name: "Signed agreement.PDF", size: 10, sha256: "a".repeat(64), contentType: "application/pdf" }],
} });
const criterion = (fieldId: string, operator: string, values: unknown[] = []) => BackOfficeFilterCriteriaSchema.parse({ mode: "all", conditions: [{ fieldId, operator, values }] });
const match = (criteria: BackOfficeFilterCriteria) => matchesBackOfficeFilters(record, object, criteria);

test("record filters match text and linked identities with all/any rules, without stringifying arrays", () => {
  expect(match(criterion("name", "contains", ["ÉLAN"]))).toBe(true);
  expect(match(criterion("name", "is", ["e\u0301lan contract"]))).toBe(true);
  expect(match(criterion("links", "is", [second]))).toBe(true);
  expect(match(criterion("links", "is_not", [first]))).toBe(false);
  expect(match(criterion("tags", "is", ["Urgent"]))).toBe(true);
  const conditions = [...criterion("name", "contains", ["absent"]).conditions, ...criterion("links", "is", [second]).conditions];
  expect(match({ mode: "all", conditions })).toBe(false);
  expect(match({ mode: "any", conditions })).toBe(true);
  expect(match({ mode: "all", conditions: [] })).toBe(true);
});

test("numbers, false values and dates retain their types and compare equivalent timestamp instants", () => {
  expect(match(criterion("score", "is", [0]))).toBe(true);
  expect(match(criterion("active", "is", [false]))).toBe(true);
  expect(match(criterion("active", "empty"))).toBe(false);
  expect(match(criterion("score", "gte", [0]))).toBe(true);
  expect(match(criterion("day", "gt", ["2026-11-01"]))).toBe(true);
  expect(match(criterion("stamp", "is", ["2026-11-08T10:00:00Z"]))).toBe(true);
  expect(backOfficeFilterError(object, criterion("day", "is", ["2026-02-30"]))).not.toBeNull();
  expect(backOfficeFilterError(object, criterion("score", "contains", ["0"]))).not.toBeNull();
  expect(backOfficeFilterError(object, criterion("active", "is", ["false"]))).not.toBeNull();
});

test("amount filters never compare different currencies and file filters use names and presence", () => {
  expect(match(criterion("amount", "gte", [{ amountMinor: 10000, currency: "EUR" }]))).toBe(true);
  expect(match(criterion("amount", "gte", [{ amountMinor: 10000, currency: "USD" }]))).toBe(false);
  expect(match(criterion("amount", "is", [{ amountMinor: 50000, currency: "USD" }]))).toBe(false);
  expect(match(criterion("file", "contains", ["AGREEMENT.pdf"]))).toBe(true);
  expect(match(criterion("file", "not_contains", ["invoice"]))).toBe(true);
  expect(match(criterion("file", "not_empty"))).toBe(true);
  expect(matchesBackOfficeFilters({ ...record, values: { ...record.values, file: [] } }, object, criterion("file", "empty"))).toBe(true);
});

test("legacy predicates preserve multiple fields and false/zero values and structured filters validate model fields", () => {
  const legacy = backOfficeViewFilters({ filters: { score: 0, active: false, links: [second] } });
  expect(legacy.conditions).toHaveLength(3);
  expect(match(legacy)).toBe(true);
  expect(BackOfficeFilterCriteriaSchema.safeParse({ mode: "all", conditions: [{ fieldId: "name", operator: "contains", values: [] }] }).success).toBe(false);
  expect(backOfficeFilterError(object, criterion("missing", "empty"))).not.toBeNull();
  expect(backOfficeFilterError(object, criterion("secret", "contains", ["private"]))).not.toBeNull();
  const model = { ...defaultBackOfficeModel(), objects: [object] };
  const view = BackOfficeViewSchema.parse({ id: crypto.randomUUID(), objectId: object.id, name: "Filtered", columns: ["name"], filterCriteria: legacy });
  expect(() => validateBackOfficeView(model, view)).not.toThrow();
  expect(() => validateBackOfficeView(model, { ...view, filterCriteria: criterion("missing", "empty") })).toThrow();
});

test("shared view filtering withholds financial/private fields and inaccessible linked-record criteria", () => {
  const model = { ...defaultBackOfficeModel(), objects: [object] };
  const criteria: BackOfficeFilterCriteria = { mode: "all", conditions: [...criterion("name", "contains", ["Contract"]).conditions, ...criterion("amount", "gt", [{ amountMinor: 10000, currency: "EUR" }]).conditions, ...criterion("links", "is", [first]).conditions] };
  const view = BackOfficeViewSchema.parse({ id: crypto.randomUUID(), objectId: object.id, name: "Filtered", columns: ["name", "amount"], filterCriteria: criteria });
  const member = { userId: "member", model: false, edit: true, finance: false };
  const restricted = readableBackOfficeView(view, model, member, new Set());
  expect(restricted?.filterCriteria?.conditions.map(condition => condition.fieldId)).toEqual(["name"]);
  expect(JSON.stringify(restricted)).not.toContain("10000");
  expect(JSON.stringify(restricted)).not.toContain(first);
  expect(readableBackOfficeView(view, model, { ...member, finance: true }, new Set([first]))?.filterCriteria).toEqual(criteria);
});

test("saved filter history and exports redact financial criteria and inaccessible linked records", async () => {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  const owner = { userId: "owner", model: true, edit: true, finance: true };
  const member = { userId: "member", model: false, edit: true, finance: false };
  try {
    const model = store.model("local");
    model.objects.push(object);
    store.saveModel("local", owner, model, model.revision);
    const client = store.saveRecord("local", owner, { objectId: "clients", revision: 0, values: { name: "Restricted client" }, access: "members" });
    const criteria: BackOfficeFilterCriteria = { mode: "any", conditions: [...criterion("name", "contains", ["Contract"]).conditions, ...criterion("amount", "gt", [{ amountMinor: 12345, currency: "EUR" }]).conditions, ...criterion("links", "is", [client.id]).conditions] };
    const view = store.saveView("local", owner, { id: crypto.randomUUID(), objectId: object.id, name: "Filtered", columns: ["name"], filterCriteria: criteria });
    const target = { type: "view", id: view.id } satisfies Parameters<typeof localBackOfficeHistoryExport>[3];
    const hidden = localBackOfficeHistoryExport(store, "local", member, target);
    expect(hidden.body.items).toHaveLength(1);
    expect(hidden.body.items[0]).toMatchObject({ redacted: true, payload: null });
    expect(BackOfficeViewSchema.parse(hidden.body.items[0].after).filterCriteria).toEqual({ mode: "any", conditions: criterion("name", "contains", ["Contract"]).conditions });
    expect(JSON.stringify(hidden)).not.toContain("12345");
    expect(JSON.stringify(hidden)).not.toContain(client.id);
    const full = localBackOfficeHistoryExport(store, "local", owner, target);
    expect(BackOfficeViewSchema.parse(full.body.items[0].after).filterCriteria).toEqual(criteria);
    expect(full.body.items[0].payload).not.toBeNull();
  } finally { store.close(); }
});
