import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "./server.js";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import { BackOfficeRecordSchema } from "./back-office/schema.js";

test("picker creation pins the directory and reserved identity, leaving no record after validation failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "back-office-create-directory-"));
  const previous = { LEGALWORK_DATA_DIR: process.env.LEGALWORK_DATA_DIR, LEGALWORK_TOKEN_STORE: process.env.LEGALWORK_TOKEN_STORE };
  process.env.LEGALWORK_DATA_DIR = join(root, "data"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const config = backOfficeTestConfig(root, { authorizedRoots: [root], startedAt: 0 });
  const server = await startServer(config), base = `http://127.0.0.1:${server.port}`;
  const request = (path: string, body?: unknown) => fetch(base + "/back-office" + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const { directoryId } = z.object({ directoryId: z.string() }).parse(await (await request("")).json());
    const id = crypto.randomUUID(), body = { id, create: true, objectId: "clients", revision: 0, values: { name: "New client" } };
    expect((await request("/records", { ...body, directoryId: "local:wrong-directory" })).status).toBe(409);
    expect((await request("/records", { ...body, directoryId, values: { name: "" } })).status).toBe(400);
    expect(z.object({ records: z.array(BackOfficeRecordSchema) }).parse(await (await request("/records/clients")).json()).records).toEqual([]);
    const created = await request("/records", { ...body, directoryId });
    expect(created.status).toBe(200);
    expect(z.object({ record: BackOfficeRecordSchema }).parse(await created.json()).record.id).toBe(id);
    const replay = await request("/records", { ...body, directoryId });
    expect(replay.status).toBe(200);
    expect(z.object({ record: BackOfficeRecordSchema }).parse(await replay.json()).record).toMatchObject({ id, revision: 1 });
    expect((await request("/records", { ...body, directoryId, values: { name: "Different client" } })).status).toBe(409);
    expect(z.object({ records: z.array(BackOfficeRecordSchema) }).parse(await (await request("/records/clients")).json()).records).toHaveLength(1);
  } finally {
    await server.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
