import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";

test("review HTTP routes enforce scope, user settings, workspace boundaries and read-only mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-routes-")), workspace = join(root, "workspace");
  await mkdir(workspace); await writeFile(join(workspace, "contract.md"), "Assignment needs consent.");
  const previousDb = process.env.LEGALWORK_RUNTIME_DB; process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "test", name: "Test", path: workspace, preset: "starter", workspaceType: "local" }], authorizedRoots: [workspace], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const server = await startServer(config), base = `http://127.0.0.1:${server.port}`;
  const call = (path: string, method = "GET", body?: unknown, token = config.token) => fetch(`${base}/workspace/test/reviews${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    expect((await call("", "GET", undefined, "wrong")).status).toBe(401);
    const issued = await fetch(`${base}/tokens`, { method: "POST", headers: { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" }, body: JSON.stringify({ scope: "viewer", label: "review-test" }) });
    const viewer = z.object({ token: z.string() }).parse(await issued.json()).token;
    expect((await call("", "GET", undefined, viewer)).status).toBe(200);
    const settings = { mode: "jev", jev: { providerId: "firm", model: "decision" }, llm: null };
    expect((await call("/settings", "PUT", settings, viewer)).status).toBe(403);
    expect((await call("/settings", "PUT", settings)).status).toBe(200);
    const column = { key: "assignment", label: "Assignment", question: "Is assignment permitted?", kind: "yes_no" };
    const request = { requestId: randomUUID(), name: "Test review", files: ["contract.md"], columns: [column] };
    expect((await call("", "POST", { ...request, settings: { ...settings, mode: "llm" } })).status).toBe(400);
    const incompatible = await call("", "POST", { ...request, columns: [{ ...column, kind: "text" }] });
    expect(incompatible.status).toBe(422); expect(await incompatible.text()).toContain("columnKeys");
    expect((await call("", "POST", request)).status).toBe(200);
    const saved = await call(`/${request.requestId}`); expect(await saved.text()).toContain('"mode":"jev"');
    expect((await fetch(`${base}/workspace/unknown/reviews/${request.requestId}`, { headers: { authorization: `Bearer ${config.token}` } })).status).toBe(404);
    const unavailable = await call(`/${request.requestId}/start`, "POST", { revision: 0 });
    expect(unavailable.status).toBe(409); expect(await unavailable.text()).toContain("review_model_unavailable");
    config.readOnly = true;
    expect((await call(`/${request.requestId}`, "PATCH", { revision: 0, name: "Changed" })).status).toBe(403);
    expect((await call("/settings", "PUT", settings)).status).toBe(403);
    expect((await call(`/${request.requestId}`)).status).toBe(200);
  } finally {
    await server.stop();
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
