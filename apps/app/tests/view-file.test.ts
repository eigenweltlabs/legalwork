import { expect, test } from "bun:test";
import { ViewRecordSchema, StoredViewSchema, copyViewFile, viewCopyInput } from "@legalwork/types/views";
import { renameView, snapshotView } from "../src/react-app/domains/views/view-file";
import { viewDataStatus, viewSourceAvailable } from "../src/react-app/domains/views/view-data-status";

const original = ViewRecordSchema.parse({ version: 1, title: "Matters", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Matters")', queries: {}, owner: { kind: "workspace", id: "source" }, id: "00000000-0000-4000-8000-000000000001", revision: "r1", updatedAt: 100,
  datasets: { matters: { rows: [{ title: "A", path: "Matters/A.md" }], total: 1, revision: "data1", asOf: 100, truncated: false, sources: [{ path: "Matters/A.md", revision: "page1" }] } } });
const data = original.datasets!.matters;

test("copy/import assigns independent IDs and preserves snapshot data and original source context", () => {
  const { owner, revision: _revision, ...stored } = original;
  const attributed = { ...stored, ...viewCopyInput(stored, { owner, serverUrl: "https://source.example" }) };
  const bytes = new TextEncoder().encode(JSON.stringify(attributed));
  const first = StoredViewSchema.parse(JSON.parse(new TextDecoder().decode(copyViewFile(bytes))));
  const second = StoredViewSchema.parse(JSON.parse(new TextDecoder().decode(copyViewFile(bytes))));
  expect(new Set([original.id, first.id, second.id]).size).toBe(3);
  expect(first.datasets!.matters).toEqual({ ...data, sourceOwner: owner, sourceServerUrl: "https://source.example" });
  expect(first.sourceOwner).toEqual(owner);
  expect(first.sourceServerUrl).toBe("https://source.example");
  expect(viewSourceAvailable(first.datasets!.matters, "https://source.example")).toBe(true);
  expect(viewSourceAvailable(first.datasets!.matters, "https://destination.example")).toBe(false);
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(attributed);
});

test("an unattributed external import keeps its data but cannot bind source links to its new owner", () => {
  const input = viewCopyInput(original);
  expect(input.datasets!.matters.rows).toEqual(data.rows);
  expect(input.datasets!.matters.sourceServerUrl).toBe("");
  expect(viewSourceAvailable(input, "https://destination.example")).toBe(false);
  expect(viewSourceAvailable(input.datasets!.matters, "https://destination.example")).toBe(false);
  expect(viewSourceAvailable(data, "https://original.example")).toBe(true);
});

test("live exports query the source wiki and freeze results; missing snapshots are rejected", async () => {
  const live = { ...original, owner: { kind: "wiki", id: "source-wiki" }, queries: { matters: { fields: ["title"] } }, datasets: {} } satisfies typeof original;
  expect(() => viewCopyInput(live)).toThrow("Export it from LegalWork");
  const queried: string[] = [];
  const snapshot = await snapshotView({ baseUrl: "https://source.example", queryWiki: async wiki => { queried.push(wiki); return data; } }, live);
  expect(queried).toEqual(["source-wiki"]);
  expect(snapshot.queries).toEqual({});
  expect(snapshot.datasets!.matters).toEqual({ ...data, sourceOwner: live.owner, sourceServerUrl: "https://source.example" });
  // Same-wiki duplication is different: live queries may stay live.
  expect(viewCopyInput(live, undefined, true)).toBe(live);
});

test("rename changes the visible title with revision protection, preserving the program and data", async () => {
  let current = original;
  let writes = 0;
  const client = { readView: async () => current, updateView: async (_owner: typeof original.owner, id: string, change: { baseRevision: string; input: Parameters<typeof viewCopyInput>[0] }) => {
    expect(id).toBe(original.id); expect(change.baseRevision).toBe(current.revision);
    writes++; current = { ...current, ...change.input, revision: "r2" }; return current;
  } };
  expect((await renameView(client, original, "  Quarterly overview  ")).title).toBe("Quarterly overview");
  expect(current.id).toBe(original.id); expect(current.program).toBe(original.program); expect(current.datasets).toEqual(original.datasets);
  await expect(renameView(client, original, "Stale title")).rejects.toMatchObject({ status: 409 });
  expect(writes).toBe(1);
});

test("export never replaces historical report data with today's query results", async () => {
  const report = { ...original, mode: "report", owner: { kind: "wiki", id: "source-wiki" }, queries: { matters: { fields: ["title"] } } } satisfies typeof original;
  const client = { baseUrl: "https://source.example", queryWiki: async () => { throw new Error("Historical reports must not query today's data"); } };
  const snapshot = await snapshotView(client, report);
  expect(snapshot.datasets!.matters.rows).toEqual(data.rows);
  expect(snapshot.datasets!.matters.asOf).toBe(100);
  await expect(snapshotView(client, { ...report, datasets: {} })).rejects.toThrow("data snapshot");
});

test("data status distinguishes snapshots from live dashboards and reports the oldest included data", () => {
  expect(viewDataStatus(original)).toEqual({ live: false, asOf: 100 });
  expect(viewDataStatus({ ...original, datasets: { ...original.datasets, older: { ...data, asOf: 50 } } }).asOf).toBe(50);
  expect(viewDataStatus({ ...original, queries: { matters: { fields: ["title"] } } }).live).toBe(true);
  expect(viewDataStatus({ ...original, mode: "report", queries: { matters: { fields: ["title"] } } }).live).toBe(false);
  expect(viewDataStatus({ ...original, datasets: {} })).toEqual({ live: false, asOf: null });
});
