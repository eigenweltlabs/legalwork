import { expect, test } from "bun:test";
import { BackOfficeRecordSchema, type BackOfficeValue } from "@legalwork/types/back-office";
import { matterPickerOptions, recentMatterIds, rememberMatter } from "../src/react-app/domains/workspace/matter-picker-options";

function record(objectId: string, name: string, values: Record<string, BackOfficeValue> = {}) {
  return BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId, values: { name, ...values }, revision: 1, schemaRevision: 1,
    ownerId: "owner", createdAt: "2026-11-09T10:00:00Z", updatedAt: "2026-11-09T10:00:00Z", archivedAt: null });
}

test("matter search combines names, accessible clients and file numbers without showing archived records", () => {
  const client = record("clients", "ABC GmbH"), archivedClient = { ...record("clients", "Former client"), archivedAt: "2026-11-09T11:00:00Z" };
  const other = record("people", "Wrong object");
  const matter = record("matters", "Acquisition", { fileNumber: "2026/042", clients: [client.id, archivedClient.id, other.id, crypto.randomUUID()] });
  const rows = [client, archivedClient, other, matter, { ...record("matters", "Archived acquisition"), archivedAt: "2026-11-09T11:00:00Z" }];
  expect(matterPickerOptions(rows, "abc 042 acquisition", [])).toEqual([{ record: matter, clientNames: ["ABC GmbH"], reference: "2026/042" }]);
  expect(matterPickerOptions(rows, "Former", [])).toEqual([]);
  expect(matterPickerOptions(rows, "Wrong", [])).toEqual([]);
  expect(matterPickerOptions(rows, "", [])).toHaveLength(1);
});

test("recent selections sort first with alphabetical fallback and do not broaden matching", () => {
  const alpha = record("matters", "Alpha"), beta = record("matters", "Beta"), charlie = record("matters", "Charlie");
  expect(matterPickerOptions([charlie, beta, alpha], "", [beta.id]).map(item => item.record.id)).toEqual([beta.id, alpha.id, charlie.id]);
  expect(matterPickerOptions([charlie, beta, alpha], "Alpha", [beta.id]).map(item => item.record.id)).toEqual([alpha.id]);
});

test("recent preferences persist only IDs, remain account/directory scoped and are bounded", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) } });
  try {
    const scope = JSON.stringify(["server", "firm-a", "alice"]), other = JSON.stringify(["server", "firm-a", "bob"]);
    const id = crypto.randomUUID();
    rememberMatter(scope, id); rememberMatter(scope, id);
    expect(recentMatterIds(scope)).toEqual([id]);
    expect(recentMatterIds(other)).toEqual([]);
    expect(recentMatterIds(JSON.stringify(["server", "firm-b", "alice"]))).toEqual([]);
    for (let i = 0; i < 55; i++) rememberMatter(scope, crypto.randomUUID());
    expect(recentMatterIds(scope)).toHaveLength(50);
    expect(recentMatterIds(scope)).not.toContain(id);
    entries.set("legalwork.recent-matters.v1", "broken");
    expect(recentMatterIds(scope)).toEqual([]);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("Storage disabled"); } });
    expect(recentMatterIds(scope)).toEqual([]);
    expect(() => rememberMatter(scope, id)).not.toThrow();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
