import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

test("task search works when the first project's folder is disconnected, and still validates identity and project scope", async () => {
  const scratch = fileURLToPath(new URL("../../../.legalwork/scratch/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "search-routes-")), available = join(root, "available"), missing = join(root, "missing");
  await mkdir(available);
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "missing", name: "Missing", path: missing, preset: "starter", workspaceType: "local" }, { id: "available", name: "Available", path: available, preset: "starter", workspaceType: "local" }], authorizedRoots: [missing, available], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const server = await startServer(config), base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  try {
    const create = await fetch(`${base}/workspace/available/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "Review escrow", projectId: "available" }) });
    expect(create.status).toBe(201);
    const recent = await fetch(`${base}/tasks/search?q=`, { headers });
    expect(recent.status).toBe(200); expect(await recent.text()).toContain("Review escrow");
    const scoped = await fetch(`${base}/tasks/search?q=escrow&projectId=available`, { headers });
    expect(scoped.status).toBe(200); expect(await scoped.text()).toContain("Review escrow");
    const other = await fetch(`${base}/tasks/search?q=escrow&projectId=missing`, { headers });
    expect(other.status).toBe(200); expect(await other.json()).toEqual({ items: [], limited: false });
    expect((await fetch(`${base}/tasks/search?q=escrow&projectId=unknown`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/tasks/search?q=escrow`)).status).toBe(401);
  } finally {
    await server.stop();
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
