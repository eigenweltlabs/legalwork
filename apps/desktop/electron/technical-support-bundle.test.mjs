import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectTechnicalSupportBundle } from "./support-bundle.mjs";

test("combines runtime diagnostics and app logs via the local server's message-removing export", async () => {
  const logs = await mkdtemp(path.join(tmpdir(), "support-logs-"));
  try {
    await writeFile(path.join(logs, "main.log"), "UI bridge unreachable at doc.ts:100");
    const requests = [];
    const text = await collectTechnicalSupportBundle({ app: { getVersion: () => "0.2.18", getName: () => "LegalWork", isPackaged: true, getPath: () => logs },
      runtimeManager: { collectRuntimeDiagnostics: async () => ({ engine: { running: true, pid: 123 } }) },
      serverInfo: { running: true, baseUrl: "http://127.0.0.1:9999", hostToken: "secret-fixture" },
      fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ format: "legalwork-technical-diagnostics", schemaVersion: 2, scope: { days: 7 }, desktop: { runtime: { engine: { pid: 123 } } } }); } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:9999/diagnostics/export");
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.headers["X-LegalWork-Host-Token"], "secret-fixture");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.days, 7);
    assert.equal(body.desktop.app.version, "0.2.18");
    assert.equal(body.desktop.runtime.engine.pid, 123);
    assert.match(body.desktop.logs[0].lines[0], /UI bridge unreachable/);
    assert.equal(JSON.parse(text).desktop.runtime.engine.pid, 123);
    assert.ok(!text.includes("secret-fixture"));
  } finally { await rm(logs, { recursive: true, force: true }); }
});

test("asynchronous runtime failures remain visible in an otherwise usable export", async () => {
  await collectTechnicalSupportBundle({
    app: { getVersion: () => "0.2.18", getName: () => "LegalWork", getPath: () => "missing" },
    runtimeManager: { collectRuntimeDiagnostics: async () => { throw new Error("engine status probe failed"); } },
    serverInfo: { running: true, baseUrl: "http://127.0.0.1:9999", hostToken: "fixture" },
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).desktop.runtime, { error: "engine status probe failed" });
      return Response.json({ format: "legalwork-technical-diagnostics", schemaVersion: 2, scope: { days: 7 } });
    },
  });
});

test("selected days reach the server and filter logs without separating stack traces", async () => {
  const logs = await mkdtemp(path.join(tmpdir(), "support-log-days-"));
  try {
    const oldDate = new Date(Date.now() - 2 * 86400000);
    const recentDate = new Date(Date.now() - 3600000);
    await writeFile(path.join(logs, "main.log"), `[${oldDate.toISOString()}] old failure\n  at old.ts:10\n[${recentDate.toISOString()}] recent failure\n  at recent.ts:20`);
    await writeFile(path.join(logs, "boot.log"), "old undated boot failure");
    await utimes(path.join(logs, "boot.log"), oldDate, oldDate);
    await collectTechnicalSupportBundle({ app: { getVersion: () => "0.2.18", getName: () => "LegalWork", getPath: () => logs },
      runtimeManager: { collectRuntimeDiagnostics: () => ({}) }, serverInfo: { running: true, baseUrl: "http://127.0.0.1:9999", hostToken: "fixture" }, days: 1,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.days, 1);
        const main = body.desktop.logs.find(log => log.name === "main.log");
        assert.equal(main.excludedLines, 2);
        assert.deepEqual(main.lines, [`[${recentDate.toISOString()}] recent failure`, "  at recent.ts:20"]);
        assert.equal(body.desktop.logs.find(log => log.name === "boot.log").excludedBeforePeriod, true);
        return Response.json({ format: "legalwork-technical-diagnostics", schemaVersion: 2, scope: { days: 1 } });
      } });
  } finally { await rm(logs, { recursive: true, force: true }); }
});

test("unavailable services, failed requests and old responses cannot produce a misleading export", async () => {
  const app = { getVersion: () => "0.2.18", getName: () => "LegalWork", getPath: () => "missing" };
  const runtimeManager = { collectRuntimeDiagnostics: () => ({}) };
  await assert.rejects(collectTechnicalSupportBundle({ app, runtimeManager, serverInfo: { running: false } }), /local LegalWork service/);
  const serverInfo = { running: true, baseUrl: "http://127.0.0.1:9999", hostToken: "fixture" };
  await assert.rejects(collectTechnicalSupportBundle({ app, runtimeManager, serverInfo, fetchImpl: async () => new Response("private error", { status: 500 }) }), /could not be collected/);
  await assert.rejects(collectTechnicalSupportBundle({ app, runtimeManager, serverInfo, fetchImpl: async () => Response.json({ format: "legalwork-technical-diagnostics", schemaVersion: 1 }) }), /does not support/);
  await assert.rejects(collectTechnicalSupportBundle({ app, runtimeManager, serverInfo, days: 1, fetchImpl: async () => Response.json({ format: "legalwork-technical-diagnostics", schemaVersion: 2, scope: { days: 7 } }) }), /selected export period/);
  await assert.rejects(collectTechnicalSupportBundle({ app, runtimeManager, serverInfo, days: 0 }), /whole number/);
});
