import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ViewPreviewSchema, type BackOfficeDataQuery } from "@legalwork/types/views";
import { backOfficeRecordUrl, BackOfficeModelSchema, BackOfficeRecordSchema, defaultBackOfficeModel, isInternalBackOfficeObject, type BackOfficeRecord } from "./schema.js";
import { queryDirectoryRecords } from "./dashboard-query.js";
import { closeBackOfficeStoreForTests } from "./store.js";
import { startServer } from "../server.js";
import { backOfficeTestConfig } from "./config.test-support.js";
import { nativePluginTools } from "../opencode-plugins/native-plugin-test-support.js";
import ProjectPlugin from "../opencode-plugins/legalwork-project-tools.js";
import WikiPlugin from "../opencode-plugins/legalwork-wiki-tools.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "../wiki/agent-access.js";
import { saveAssistantReport } from "../assistant-reports.js";

test("chat queries built-in and custom models, saves a live workspace dashboard and refreshes after edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-directory-dashboard-"));
  const env = ["LEGALWORK_DATA_DIR", "LEGALWORK_TOKEN_STORE", "LEGALWORK_SERVER_URL", "LEGALWORK_SERVER_TOKEN", "LEGALWORK_WIKI_AGENT_TOKEN"];
  const original = new Map(env.map(key => [key, process.env[key]]));
  process.env.LEGALWORK_DATA_DIR = join(root, "data");
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const project = join(root, "project");
  await mkdir(project);
  const workspace = { id: "project", name: "Project", path: project, preset: "starter" as const, workspaceType: "local" as const };
  const config = backOfficeTestConfig(root, { token: "owner", workspaces: [workspace], authorizedRoots: [root], startedAt: 0 });
  const server = await startServer(config);
  const plugins: Awaited<ReturnType<typeof nativePluginTools>>[] = [];
  try {
    const base = `http://127.0.0.1:${server.port}`;
    process.env.LEGALWORK_SERVER_URL = base;
    process.env.LEGALWORK_SERVER_TOKEN = config.token;
    process.env.LEGALWORK_WIKI_AGENT_TOKEN = await ensureWikiAgentToken(config);
    const context = { directory: project, sessionID: "session-dashboard" };
    await grantWikiAgentSession(config, { sessionId: context.sessionID, directory: project, scope: "owner" });
    const crm = await nativePluginTools(ProjectPlugin, context);
    plugins.push(crm);
    const views = await nativePluginTools(WikiPlugin, context);
    plugins.push(views);
    const discover = async () => z.object({ directoryId: z.string(), model: BackOfficeModelSchema }).parse(JSON.parse(await crm.tool.legalwork_back_office_discover.execute({})));
    const { directoryId, model } = await discover();
    const binding = { source: "backOffice" as const, directoryId, objectId: "matters", fields: ["name"] };
    const query = async (q: BackOfficeDataQuery) => JSON.parse(await crm.tool.legalwork_back_office_query.execute(q));
    for (const obj of model.objects.filter(o => !isInternalBackOfficeObject(o.id))) {
      expect((await query({ ...binding, objectId: obj.id })).rows).toEqual([]);
    }
    const custom = { ...model.objects[0], id: "claims", label: "Claim", plural: "Claims", protected: false };
    model.objects.push(custom);
    await crm.tool.legalwork_back_office_model.execute({ revision: model.revision, model });
    expect((await discover()).model.objects.at(-1)?.id).toBe("claims");
    const add = async (name: string, currency: string, amountMinor: number) => JSON.parse(await crm.tool.legalwork_back_office_save.execute({
      objectId: "claims", revision: 0, values: { name, practiceArea: "Commercial", claimValue: { currency, amountMinor } },
    })).record;
    const first = await add("First", "EUR", 5000);
    const url = backOfficeRecordUrl(first);
    expect(first.url).toBe(url);
    const records = JSON.parse(await crm.tool.legalwork_back_office_records.execute({ objectId: "claims" })).records;
    expect(records.find((record: { id: string }) => record.id === first.id).url).toBe(url);
    const named = await query({ ...binding, objectId: "claims", fields: ["name"], filters: [{ field: "$id", op: "eq", value: first.id }] });
    expect(named.rows).toEqual([{ name: "First", $id: first.id, $archived: false, $url: url }]);
    expect((await query({ ...binding, objectId: "claims", fields: Array(20).fill("name") })).rows[0].$url).toBe(url);
    await add("Other currency", "USD", 10000);
    const summary: BackOfficeDataQuery = { ...binding, objectId: "claims", fields: ["count", "value"], currency: "EUR",
      metrics: [{name:"count",op:"count"}, {name:"value",op:"sum",field:"claimValue"}] };
    const page = { ...binding, objectId: "claims", fields: ["$id"], limit: 1 };
    const firstPage = await query(page);
    const nextPage = JSON.parse(await crm.tool.legalwork_back_office_query.execute({ ...page, cursor: firstPage.nextCursor }));
    expect(firstPage.total).toBe(2);
    expect(nextPage.rows).toHaveLength(1);
    expect(firstPage.rows[0].$id).not.toBe(nextPage.rows[0].$id);
    const initial = await query(summary);
    expect(initial.rows).toEqual([{ count: 2, value: 50 }]);
    expect((await query({ ...summary, currency: "GBP" })).rows).toEqual([{ count: 2, value: null }]);
    const input = { version: 1, mode: "dashboard", catalog: "legalwork-1", title: "Claims", queries: { claims: summary },
      program: 'claims = Query("data", {name:"claims"}, {rows:[]})\nroot = QueryMetric("Value", claims.rows, "value", "EUR")' };
    const result = await views.tool.view_create.executeResult({ input });
    expect(result, JSON.stringify(result)).toHaveProperty("metadata");
    const preview = z.object({ metadata: z.object({ legalworkViewPreview: ViewPreviewSchema }) }).parse(result).metadata.legalworkViewPreview;
    expect(preview.input.datasets?.claims.rows).toEqual(initial.rows);
    const saved = await saveAssistantReport(workspace, { key: "claims", input: preview.input });
    expect(saved.view.datasets?.claims).toBeUndefined();
    expect(saved.view.queries.claims).toEqual(summary);
    expect((await saveAssistantReport(workspace, { key: "claims", input: preview.input })).view.revision).toBe(saved.view.revision);
    await crm.tool.legalwork_back_office_save.execute({ id:first.id, objectId:"claims", revision:first.revision, values:{ claimValue:{currency:"EUR",amountMinor:123450}} });
    const changed = await query(summary);
    expect(changed.rows).toEqual([{ count: 2, value: 1234.5 }]);
    expect(changed.revision).not.toBe(initial.revision);
    const updated = JSON.parse(await crm.tool.legalwork_back_office_records.execute({ objectId: "claims" })).records.find((record: { id: string }) => record.id === first.id);
    const archived = JSON.parse(await crm.tool.legalwork_back_office_save.execute({
      id: first.id, objectId: "claims", revision: updated.revision, values: {}, archived: true,
    })).record;
    expect(archived.url).toBe(backOfficeRecordUrl(archived));
    expect(archived.url).toEndWith("&archived=true");
    const archive = await query({ ...binding, objectId: "claims", fields: ["name"], includeArchived: true, filters: [{ field: "$id", op: "eq", value: first.id }] });
    expect(archive.rows[0].$url).toBe(archived.url);
    const rejected = (q: BackOfficeDataQuery) => fetch(base+"/back-office/dashboard-query", { method:"POST", headers:{authorization:"Bearer owner","content-type":"application/json"}, body:JSON.stringify(q) });
    expect((await rejected({...summary, directoryId:"different"})).status).toBe(409);
    expect((await rejected({...summary, objectId:"projectLinks"})).status).toBe(403);
    expect((await rejected({...summary, currency:undefined})).status).toBe(400);

    const create = async (objectId: string, values: BackOfficeRecord["values"]) =>
      z.object({ record: BackOfficeRecordSchema }).parse(JSON.parse(
        await crm.tool.legalwork_back_office_save.execute({ objectId, revision: 0, values }),
      )).record;
    const client = await create("clients", { name: "Billing client" });
    const matter = await create("matters", { name: "Contract review", clients: [client.id] });
    const sameName = await create("matters", { name: "Contract review" });
    const billing = {
      ...binding, objectId: "invoices", fields: ["name", "matter", "netTotal"], currency: "EUR",
      filters: [{ field: "matter", op: "eq", value: matter.id }],
    } satisfies BackOfficeDataQuery;
    const invoice = await create("invoices", { name: "Invoice 1", matter: matter.id, netTotal: { currency: "EUR", amountMinor: 58000 } });
    await create("invoices", { name: "Invoice 2", matter: sameName.id, netTotal: { currency: "EUR", amountMinor: 10000 } });
    const time = await create("timeEntries", {
      name: "Review", matter: matter.id, client: client.id, startedAt: "2026-11-16", billableMinutes: 120,
    });
    const claim = await create("claims", { name: "Related claim", parentMatter: matter.id });
    expect((await query(billing)).rows).toEqual([{
      $id: invoice.id, $archived: false, $url: backOfficeRecordUrl(invoice),
      name: "Invoice 1", matter: "Contract review", netTotal: 580,
    }]);
    expect((await query({ ...billing, filters: [{ field: "matter", op: "eq", value: "Contract review" }] })).total).toBe(2);
    expect((await query({ ...billing, objectId: "timeEntries", fields: ["billableMinutes"] })).rows[0])
      .toMatchObject({ $id: time.id, billableMinutes: 120 });
    expect((await query({
      ...billing, objectId: "claims", fields: ["parentMatter"],
      filters: [{ field: "parentMatter", op: "in", value: ["No matching name", matter.id] }],
    })).rows[0]).toMatchObject({ $id: claim.id, parentMatter: "Contract review" });
    await crm.tool.legalwork_back_office_save.execute({ id: matter.id, objectId: "matters", revision: matter.revision, values: { name: "Updated contract review" } });
    expect((await query(billing)).rows[0]).toMatchObject({ $id: invoice.id, matter: "Updated contract review" });
    expect((await query({
      ...billing, fields: ["billed"], metrics: [{ name: "billed", op: "sum", field: "netTotal" }],
    })).rows).toEqual([{ billed: 580 }]);
  } finally {
    for (const plugin of plugins) await plugin.close();
    await server.stop();
    await closeBackOfficeStoreForTests(config);
    for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("financial models and fields cannot be queried by an unprivileged viewer", () => {
  const actor = { userId:"lawyer", model:false, edit:false, finance:false };
  const q: BackOfficeDataQuery = { source:"backOffice", directoryId:"team:test", objectId:"invoices", fields:["name"] };
  const read = (query: BackOfficeDataQuery) => queryDirectoryRecords(defaultBackOfficeModel(), actor, () => [], query);
  expect(() => read(q)).toThrow("unavailable");
  expect(() => read({ ...q, objectId:"matters", fields:["claimValue"] })).toThrow("available fields");
  expect(() => read({ ...q, objectId:"matters", fields:["name"], filters:[{field:"claimValue",op:"exists"}] })).toThrow("available fields");
});

test("relation filters match visible target IDs and names without changing projected values", () => {
  const makeRecord = (objectId: string, values: BackOfficeRecord["values"]) => BackOfficeRecordSchema.parse({
    id: crypto.randomUUID(), objectId, values, ownerId: "lawyer",
    revision: 1, schemaRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null,
  });
  const alice = makeRecord("clients", { name: "Alice" });
  const bob = makeRecord("clients", { name: "Bob" });
  const hidden = makeRecord("clients", { name: "Hidden" });
  const both = makeRecord("matters", { name: "Both clients", clients: [alice.id, bob.id, hidden.id] });
  const one = makeRecord("matters", { name: "One client", clients: [alice.id] });
  const actor = { userId: "lawyer", model: false, edit: false, finance: false };
  const readRecords = (objectId: string) => objectId === "clients" ? [alice, bob] : [both, one];
  const filter = (op: "contains" | "eq" | "in" | "ne", value: string | (string | string[])[]) =>
    queryDirectoryRecords(defaultBackOfficeModel(), actor, readRecords, {
      source: "backOffice", directoryId: "team:test", objectId: "matters", fields: ["name", "clients"],
      filters: [{ field: "clients", op, value }],
    }).rows;

  const visible = [{ name: "Both clients", clients: ["Alice", "Bob"] }];
  expect(filter("contains", bob.id)).toEqual(visible);
  expect(filter("contains", "Bob")).toEqual(visible);
  expect(filter("eq", [alice.id, "Bob"])).toEqual(visible);
  expect(filter("in", [[alice.id, "Bob"]])).toEqual(visible);
  expect(filter("ne", [alice.id, bob.id])).toEqual([{ name: "One client", clients: ["Alice"] }]);
  expect(filter("contains", hidden.id)).toEqual([]);
  expect(filter("contains", "Hidden")).toEqual([]);
});
