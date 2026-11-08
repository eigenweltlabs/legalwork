import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.js";
import type { ServerConfig } from "../src/types.js";
import { backOfficeStore, closeBackOfficeStoreForTests } from "../src/back-office/store.js";
import { loadBackOfficeState } from "../../app/src/react-app/domains/back-office/api.js";

test("record pages assemble one complete directory, refresh changed records and remove archived rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "back-office-record-pages-"));
  const previous = { LEGALWORK_DATA_DIR: process.env.LEGALWORK_DATA_DIR, LEGALWORK_TOKEN_STORE: process.env.LEGALWORK_TOKEN_STORE };
  process.env.LEGALWORK_DATA_DIR = join(root, "data");
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "fixture",
    hostToken: "host",
    configPath: join(root, "server.json"),
    workspaces: [],
    authorizedRoots: [root],
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [],
    readOnly: false,
    startedAt: 0,
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  const base = `http://127.0.0.1:${server.port}/back-office`;
  const request = (path: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer fixture", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const store = await backOfficeStore(config);
    const model = store.model("local");
    const count = Number(process.env.LEGALWORK_BENCH_RECORDS ?? 201);
    const ids = Array.from({ length: count }, () => crypto.randomUUID());
    const stamp = new Date().toISOString();
    store.transaction(() => {
      for (const [i, id] of ids.entries()) {
        const record = {
          id, objectId: "clients", values: { name: "Client " + i }, revision: 1,
          schemaRevision: model.revision, ownerId: "local",
          createdAt: stamp, updatedAt: stamp, archivedAt: null,
        };
        store.db.run("INSERT INTO bo_records VALUES(?,?,?,?)", ["local", id, "clients", JSON.stringify(record)]);
      }
    }, { action: "fixture.seed" });
    const reads: number[] = [];
    const client = {
      async backOffice(path = "") {
        const response = await request(path);
        if (!response.ok) throw new Error(await response.text());
        if (path.startsWith("/record-page?")) {
          const ids = new URL(base + path).searchParams.get("ids");
          reads.push(ids ? ids.split(",").length : 0);
        }
        return response.json();
      },
    };
    const start = performance.now();
    const initial = await loadBackOfficeState(client);
    expect(initial.records.length).toBe(count);
    expect(reads.length).toBe(Math.ceil(count / 100));
    expect(Math.max(...reads)).toBeLessThanOrEqual(100);
    const loaded = performance.now();
    reads.length = 0;
    const unchanged = await loadBackOfficeState(client, initial);
    expect(reads).toEqual([]);
    expect(unchanged.records).toBe(initial.records);
    if (process.env.LEGALWORK_BENCH_RECORDS) console.log("Native directory benchmark", { count, initialMs: loaded - start, unchangedMs: performance.now() - loaded });
    const patch = async (id: string, values: Record<string, string>, archived = false) => {
      expect((await request("/records", { id, objectId: "clients", revision: 1, values, archived })).status).toBe(200);
    };
    await patch(ids[0], { name: "Renamed" });
    await patch(ids[1], {}, true);
    const changed = await loadBackOfficeState(client, unchanged);
    expect(reads).toEqual([1]);
    expect(changed.records.length).toBe(count - 1);
    expect(changed.records.find(row => row.id === ids[0])?.values.name).toBe("Renamed");
    expect(changed.records.some(row => row.id === ids[1])).toBe(false);
    expect((await request("/record-page?ids=" + ids.slice(0, 101).join(","))).status).toBe(400);
    const archive = await loadBackOfficeState(client, undefined, undefined, "clients");
    expect(archive.records.map(record => record.id)).toEqual([ids[1]]);
    // A write between the page read and its confirmation must not publish a stale row.
    await patch(ids[2], { name: "Before concurrent edit" });
    let edited = false;
    const duringEdit = await loadBackOfficeState({
      async backOffice(path = "") {
        const response = await client.backOffice(path);
        if (!edited && path.startsWith("/record-page?")) {
          edited = true;
          const updated = await request("/records", {
            id: ids[2], objectId: "clients", revision: 2, values: { name: "After concurrent edit" },
          });
          expect(updated.status).toBe(200);
        }
        return response;
      },
    }, changed);
    expect(duringEdit.records.find(record => record.id === ids[2])?.values.name).toBe("After concurrent edit");
    const legacy = await loadBackOfficeState({backOffice: async () => (await request("")).json()});
    expect(legacy.records.length).toBe(changed.records.length);
  } finally {
    await server.stop();
    await closeBackOfficeStoreForTests(config);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
