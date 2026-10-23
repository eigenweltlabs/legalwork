import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "legalwork-request-node-"));
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) process.env[key] = root;
process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
process.env.OPENCODE_DB = join(root, "engine.sqlite");
const { startServer } = await import("../dist/server.js");
const workspaces = Array.from({ length: 18 }, (_, index) => ({ id: `ws_${index}`, name: `Project ${index}`, path: join(root, "projects", String(index)), preset: "starter", workspaceType: "local" }));
await mkdir(workspaces[0].path, { recursive: true });
const config = {
  host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "server.json"),
  approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces, authorizedRoots: [root], readOnly: false,
  startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, autoDownloadOcr: false,
};
const server = await startServer(config); const streams = [];
const base = `http://127.0.0.1:${server.port}`;
const headers = { Authorization: "Bearer fixture" };
async function read(path) { const response = await fetch(base + path, { headers }); assert.equal(response.status, 200); return response.json(); }
const cursors = Object.fromEntries(workspaces.map(workspace => [workspace.id, 0]));
const batchPath = `/session-groups/events?${new URLSearchParams({ cursors: JSON.stringify(cursors) })}`;
const measure = async action => { const started = performance.now(); await action(); return performance.now() - started; };
const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] }; };
try {
  const initial = await read(`/session-groups/events?${new URLSearchParams({ cursors: JSON.stringify(Object.fromEntries(workspaces.map(workspace => [workspace.id, null]))) })}`);
  assert.equal(initial.items.length, 18);
  await read("/session-inbox");
  await assert.rejects(stat(join(workspaces[0].path, ".opencode")));
  for (let i = 0; i < 8; i++) {
    const controller = new AbortController(); streams.push(controller);
    const response = await fetch(base + "/sync/events", { headers, signal: controller.signal }); assert.equal(response.status, 200);
  }
  const individual = [], batch = [], health = [];
  for (let round = 0; round < 20; round++) {
    individual.push(await measure(async () => { for (const workspace of workspaces) await read(`/workspace/${workspace.id}/session-groups/events?since=0`); }));
    batch.push(await measure(async () => { assert.equal((await read(batchPath)).items.length, 18); }));
    health.push(await measure(() => read("/health")));
  }
  await Promise.all(Array.from({ length: 40 }, () => read(batchPath)));
  const result = { runtime: process.version, projects: 18, openStreams: 8, rounds: 20, requestsPerLegacyCycle: 18, requestsPerBatchCycle: 1,
    individual: summary(individual), batch: summary(batch), health: summary(health), coldProjectBootstrapped: false, concurrentBatchReads: 40 };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const stream of streams) stream.abort();
  await server.stop(); await rm(root, { recursive: true, force: true });
}
