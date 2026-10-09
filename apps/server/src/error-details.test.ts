import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerErrorDetailsStore } from "./error-details.js";
import { startServer } from "./server.js";
import { TokenService } from "./tokens.js";
import type { ServerConfig } from "./types.js";

test("original server causes remain memory-only and accessible only to their original credentials", () => {
  const store = createServerErrorDetailsStore();
  const request = new Request("http://localhost/private/path", { headers: { Authorization: "Bearer ORIGINAL_SECRET", cookie: "COOKIE_SECRET" } });
  store.record("incident", new TypeError("PRIVATE_ROOT_CONTENT /private/contracts/draft.docx"), request);
  const details = store.get("incident", request);
  expect(JSON.stringify(details)).toContain("PRIVATE_ROOT_CONTENT"); expect(JSON.stringify(details)).toContain("stack");
  expect(JSON.stringify(details)).not.toContain("ORIGINAL_SECRET"); expect(JSON.stringify(details)).not.toContain("COOKIE_SECRET");
  expect(store.get("incident", new Request(request.url, { headers: { Authorization: "Bearer DIFFERENT_SECRET" } }))).toBeNull();
  expect(store.get("incident", new Request(request.url))).toBeNull();
  for (let i = 0; i < 51; i++) store.record(`later-${i}`, new Error("bounded"), request);
  expect(store.get("incident", request)).toBeNull();
});

test("running server exposes original stacks on authenticated report retrieval, never in generic error envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-full-error-route-"));
  const oldStore = process.env.LEGALWORK_TOKEN_STORE;
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "report-client-token", hostToken: "report-host-token",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, configPath: join(root, "server.json"),
  };
  const server = await startServer(config);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
    const failure = await fetch(`${base}/model-catalog/settings`, { method: "PUT", headers, body: "{" });
    expect(failure.status).toBe(400);
    const body = await failure.json();
    expect(body.diagnostic.incident_id).toBeString(); expect(JSON.stringify(body)).not.toContain('"stack"');
    const reportUrl = `${base}/error-reports/${body.diagnostic.incident_id}`;
    expect((await fetch(reportUrl)).status).toBe(401);
    const viewer = await new TokenService(config).create("viewer");
    expect((await fetch(reportUrl, { headers: { Authorization: `Bearer ${viewer.token}` } })).status).toBe(404);
    const report = await fetch(reportUrl, { headers });
    expect(report.status).toBe(200); expect(report.headers.get("cache-control")).toBe("no-store");
    const details = await report.json();
    expect(details.error.stack).toContain("Invalid JSON body");
    expect(details.error.stack).toContain("readJsonBody");
    expect(JSON.stringify(details)).not.toContain(config.token);
  } finally {
    await server.stop();
    if (oldStore === undefined) delete process.env.LEGALWORK_TOKEN_STORE;
    else process.env.LEGALWORK_TOKEN_STORE = oldStore;
    await rm(root, { recursive: true, force: true });
  }
});
