import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

async function main() {
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../app/package.json", import.meta.url));
const { createServer: createVite } = await import(require.resolve("vite"));
const { default: react } = await import(require.resolve("@vitejs/plugin-react"));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = process.env.LEGALWORK_REQUEST_EVIDENCE || join(root, "artifacts/request-performance");
const listeners = new Map(); const states = new Map(); const metrics = new Map();
let delay = 0; let session = true; let viewTitle = "Initial report";
function metric(mode) { if (!metrics.has(mode)) metrics.set(mode, { batch: 0, individualEvents: 0, individualState: 0, migrations: 0, active: 0, peak: 0, reloads: [] }); return metrics.get(mode); }
function state(id) { if (!states.has(id)) states.set(id, { cursor: 0, state: { groups: [], assignments: {} } }); return states.get(id); }
function announce(mode, poke) { for (const response of listeners.get(mode) ?? []) response.write(`data: ${JSON.stringify(poke)}\n\n`); }
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const mode = url.pathname.startsWith("/legacy/") ? "legacy" : "modern";
  const path = url.pathname.replace(/^\/legacy/, ""); const stats = metric(mode);
  response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS"); response.setHeader("Access-Control-Max-Age", "600");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (path === "/sync/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const own = listeners.get(mode) ?? new Set(); own.add(response); listeners.set(mode, own);
    response.on("close", () => own.delete(response));
    response.write(`data: ${JSON.stringify(mode === "modern" ? { resync: true, metadata: true } : { resync: true })}\n\n`); return;
  }
  const json = (value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  if (path === "/session-groups/events") {
    stats.batch++;
    if (mode === "legacy") { json({ code: "not_found" }, 404); return; }
    stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    let ended = false;
    const finish = () => { if (!ended) { ended = true; stats.active--; } };
    response.once("close", finish);
    if (delay) await wait(delay);
    if (response.destroyed) { finish(); return; }
    const cursors = JSON.parse(url.searchParams.get("cursors"));
    json({ items: Object.entries(cursors).map(([id, cursor]) => ({ workspaceId: id, cursor: state(id).cursor, ...(cursor === null || cursor !== state(id).cursor ? { state: state(id).state } : {}) })) }); finish(); return;
  }
  const match = path.match(/^\/workspace\/([^/]+)\/session-groups(\/events)?$/);
  if (match) {
    const item = state(match[1]);
    if (request.method === "PUT") {
      let body = ""; for await (const chunk of request) body += chunk;
      item.state = JSON.parse(body).state; item.cursor++; stats.migrations++; announce(mode, { groups: true }); json({ state: item.state }); return;
    }
    if (match[2]) { stats.individualEvents++; json({ items: [], cursor: item.cursor }); }
    else { stats.individualState++; json({ state: item.state }); } return;
  }
  if (path === "/workspace/ws_0/ui-views") { json({ items: [{ id: "view", title: viewTitle, mode: "report" }], issues: [] }); return; }
  if (path === "/session-inbox") { json({ sessions: session ? [{ workspaceId: "ws_0", sessionId: "chat", updatedAt: 100, assistantAt: 100 }] : [] }); return; }
  if (path === "/test/reloads") { let body = ""; for await (const chunk of request) body += chunk; stats.reloads.push(JSON.parse(body)); json({}); return; }
  json({ code: "not_found" }, 404);
});
let vite; let pageDir; let window;

try {
  await mkdir(output, { recursive: true });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const api = `http://127.0.0.1:${address.port}`;
  pageDir = await mkdtemp(join(root, "apps/app/.request-performance-"));
  await writeFile(join(pageDir, "index.html"), '<div id="root"></div><script type="module" src="/scripts/request-performance-regression.tsx"></script>');
  vite = await createVite({ configFile: false, root: join(root, "apps/app"), plugins: [react()], resolve: { alias: { "@": join(root, "apps/app/src") } }, optimizeDeps: { entries: [join(pageDir, "index.html")] }, server: { host: "127.0.0.1", port: 0 } });
  await vite.listen(); const web = vite.resolvedUrls.local[0];
  const check = async (expression, message, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await window.webContents.executeJavaScript(expression)) return; await wait(30); }
    throw new Error(message);
  };
  for (const mode of ["modern", "legacy"]) {
    states.clear(); session = true;
    window = new BrowserWindow({ show: false, width: 800, height: 850, webPreferences: { backgroundThrottling: false } });
    window.webContents.on("console-message", (_event, _level, message) => { if (/error|failed/i.test(message)) console.error(`renderer: ${message}`); });
    const server = mode === "legacy" ? api + "/legacy" : api;
    await window.loadURL(`${web}${pageDir.split("/").at(-1)}/index.html?api=${encodeURIComponent(server)}`);
    await check('window.requestPerformance && Object.keys(window.requestPerformance.snapshot().groups).length === 18', `${mode}: all projects failed to synchronize`);
    await check('window.requestPerformance.snapshot().groups.ws_0.groups[0]?.label === "Preserved local group"', `${mode}: migration was lost`);
    if (mode === "modern") {
      state("ws_3").state = { groups: [{ id: "remote", label: "Changed through events" }], assignments: {} }; state("ws_3").cursor++;
      announce(mode, { groups: true });
      await check('window.requestPerformance.snapshot().groups.ws_3.groups[0]?.label === "Changed through events"', "A live update was lost");
      viewTitle = "Updated through resource events"; announce(mode, { views: true });
      await check('window.requestPerformance.snapshot().view?.items[0]?.title === "Updated through resource events"', "Resource event did not refresh a saved view");
      for (const response of listeners.get(mode) ?? []) response.end();
      viewTitle = "Recovered after reconnect";
      await check('window.requestPerformance.snapshot().view?.items[0]?.title === "Recovered after reconnect"', "Reconnect failed to reconcile missed changes");
      delay = 250; metric(mode).peak = 0;
      for (let i = 0; i < 100; i++) announce(mode, { groups: true });
      await wait(700); delay = 0; assert.equal(metric(mode).peak, 1, "Event bursts overlapped requests");
      metric(mode).reloads = []; session = false; announce(mode, { sessions: true });
      const start = Date.now(); while (!metric(mode).reloads.some(ids => ids.includes("ws_0")) && Date.now() - start < 5000) await wait(20);
      assert.ok(metric(mode).reloads.some(ids => ids.includes("ws_0")), "Archived/deleted chat did not refresh the sidebar");
      await writeFile(join(output, "request-regression.png"), (await window.webContents.capturePage()).toPNG());
    }
    const before = structuredClone(metric(mode)); await wait(7000);
    const after = metric(mode); const sample = { mode, sampleMs: 7000, batch: after.batch - before.batch, individualEvents: after.individualEvents - before.individualEvents, individualState: after.individualState - before.individualState, migrations: after.migrations, peak: after.peak };
    if (mode === "modern") { assert.equal(sample.individualEvents, 0); assert.equal(sample.individualState, 0); assert.equal(sample.batch, 0); }
    else { assert.ok(sample.individualEvents >= 36); assert.ok(after.batch <= 3, "Legacy worker capability is repeatedly probed"); }
    console.log(JSON.stringify(sample));
    await writeFile(join(output, `${mode}-requests.json`), JSON.stringify({ ...sample, total: after }, null, 2));
    await window.webContents.executeJavaScript('window.requestPerformance.unmount()'); window.destroy(); window = undefined;
  }
  console.log("PASS: live updates, migration, StrictMode, event bursts, sidebar deletion and legacy fallback");
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  window?.destroy(); for (const group of listeners.values()) for (const response of group) response.end();
  fixture.closeAllConnections(); fixture.close(); await vite?.close(); if (pageDir) await rm(pageDir, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}

}
const profile = mkdtempSync(join(tmpdir(), "legalwork-request-browser-"));
app.setPath("userData", profile);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
app.once("quit", () => rmSync(profile, { recursive: true, force: true }));
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
