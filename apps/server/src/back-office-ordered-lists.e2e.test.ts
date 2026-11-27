import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import { BackOfficeFieldSchema, BackOfficeModelSchema, BackOfficeRecordSchema, z } from "./back-office/schema.js";

test("native list fields round-trip as ordered record values and conflict as one field", async () => {
  const root = await mkdtemp(join(tmpdir(), "bo-list-fields-"));
  const previous = { LEGALWORK_DATA_DIR: process.env.LEGALWORK_DATA_DIR, LEGALWORK_TOKEN_STORE: process.env.LEGALWORK_TOKEN_STORE };
  process.env.LEGALWORK_DATA_DIR = join(root, "data");
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const config = backOfficeTestConfig(root, { authorizedRoots: [root] });
  const server = await startServer(config);
  const request = (path: string, method = "GET", body?: unknown) => fetch(
    `http://127.0.0.1:${server.port}/back-office${path}`, {
      method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
  try {
    const { model, directoryId } = z.object({ model: BackOfficeModelSchema, directoryId: z.string(), orderedListFields: z.literal(true) })
      .parse(await (await request("?schema=1")).json());
    const object = model.objects.find(object => object.id === "matters")!;
    object.fields.push(...[
      { id: "items", label: "Items", type: "textList" }, { id: "links", label: "Links", type: "linkList" },
      { id: "choices", label: "Choices", type: "multiselect", options: ["Red", "Blue"] },
    ].map(field => BackOfficeFieldSchema.parse(field)));
    expect((await request("/model", "PUT", { model, revision: model.revision })).status).toBe(200);
    const items = ["Beta, gamma", "Alpha", "Alpha"];
    const links = [{ label: "Index", url: "http://example.test/index" }, { label: "Chapter, two", url: "https://example.test/chapter" }];
    const id = crypto.randomUUID(), values = { name: "Sample", items, links, choices: ["Blue", "Red"] };
    const identity = { id, objectId: object.id };
    expect((await request("/records/batch", "POST", { directoryId, records: [{ ...identity, values }] })).status).toBe(200);
    const read = async () => z.object({ records: z.array(BackOfficeRecordSchema) }).parse(await (await request("/records/matters")).json()).records[0];
    expect(await read()).toMatchObject({ id, revision: 1, values });
    const query = await request("/dashboard-query", "POST", { source: "backOffice", objectId: object.id, directoryId, fields: ["items", "links"] });
    expect(await query.json()).toMatchObject({ rows: [{ items, links }] });
    const write = (patch: unknown, expectedValues?: unknown) => request("/records", "POST", { ...identity, revision: 1, values: patch, expectedValues });
    for (const url of ["ftp://example.test/index", "mailto:reader@example.test"]) {
      expect((await write({ links: [{ label: "Other", url }] })).status).toBe(400);
    }
    expect((await write({ choices: ["Green"] })).status).toBe(400);
    expect((await write({ items: [...items].reverse() }, { items })).status).toBe(200);
    expect((await write({ items: ["Different"] }, { items })).status).toBe(409);
    expect(await read()).toMatchObject({ id, revision: 2, values: { ...values, items: [...items].reverse() } });
  } finally {
    await server.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
