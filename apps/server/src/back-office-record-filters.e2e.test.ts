import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { startServer } from "./server.js";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import { BackOfficeFilterCriteriaSchema, BackOfficeRecordSchema, BackOfficeViewSchema } from "./back-office/schema.js";

test("typed saved-view filters round-trip through native HTTP and survive partial view updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "back-office-record-filters-"));
  const previous = { LEGALWORK_DATA_DIR: process.env.LEGALWORK_DATA_DIR, LEGALWORK_TOKEN_STORE: process.env.LEGALWORK_TOKEN_STORE };
  process.env.LEGALWORK_DATA_DIR = join(root, "data"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const config = backOfficeTestConfig(root, { authorizedRoots: [root], startedAt: 0 });
  const server = await startServer(config), base = `http://127.0.0.1:${server.port}/back-office`;
  const request = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const organisation = z.object({ record: BackOfficeRecordSchema }).parse(await (await request("/records", { objectId: "companies", revision: 0, values: { name: "Organisation" } })).json()).record;
    const criteria = BackOfficeFilterCriteriaSchema.parse({ mode: "all", conditions: [{ fieldId: "name", operator: "contains", values: ["Client"] }, { fieldId: "company", operator: "is", values: [organisation.id] }] });
    const id = crypto.randomUUID();
    const saved = await request("/views", { id, objectId: "clients", name: "Linked clients", columns: ["name", "company"], filterCriteria: criteria });
    expect(saved.status).toBe(200);
    const { view } = z.object({ view: BackOfficeViewSchema }).parse(await saved.json());
    expect(view.filterCriteria).toEqual(criteria);
    expect((await request("/views", { id, name: "Unguarded rename" })).status).toBe(428);
    const renamed = await request("/views", { id, name: "Renamed", expected: view });
    expect(renamed.status).toBe(200);
    const updated = z.object({ view: BackOfficeViewSchema }).parse(await renamed.json()).view;
    expect(updated.filterCriteria).toEqual(criteria);
    const state = z.object({ views: z.array(BackOfficeViewSchema) }).parse(await (await request("")).json());
    expect(state.views.find(view => view.id === id)?.filterCriteria).toEqual(criteria);
    expect((await request("/views", { id, expected: updated, filterCriteria: { mode: "all", conditions: [{ fieldId: "name", operator: "gt", values: [42] }] } })).status).toBe(400);
    expect(z.object({ views: z.array(BackOfficeViewSchema) }).parse(await (await request("")).json()).views.find(view => view.id === id)?.filterCriteria).toEqual(criteria);
  } finally {
    await server.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
