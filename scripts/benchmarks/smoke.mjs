// Real Electron + real OpenCode startup/document/browser contract smoke. No model calls.
import http from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "./electron-runner.mjs";
import { makeWordFixture } from "./artifacts.mjs";
import { privateWrite } from "./evidence.mjs";

const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const root = option("--root", process.env.LEGALWORK_BENCH_ROOT);
if (!root) throw new Error("--root is required");
const repo = resolve(option("--repo", fileURLToPath(new URL("../..", import.meta.url))));
const evidence = option("--output", join(root, `smoke-${Date.now()}`));
const workspace = join(root, "workspace");
const { driver, connection, record } = await preflight({ repo, profile: join(root, "electron"), workspace, evidence, expectedBase: option("--expected-base"), uiReadyTimeoutMs: Number(option("--ui-ready-timeout-ms", "30000")) });
const fixture = http.createServer((request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><html><head><title>LegalWork synthetic web fixture</title></head><body><h1>Renewal register</h1><p>Reference: LW-SYNTHETIC-2026</p><label>Notice days <input value="45"></label><button>Save register</button></body></html>'); });
fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
const checks = [];
try {
  const ui = await driver.snapshot();
  const sessionId = /\/session\/([^/?#]+)/.exec(ui.route)?.[1];
  if (!sessionId) throw new Error("Real Electron task identity unavailable");
  const path = `benchmark-fixtures/smoke-${Date.now()}/agreement.docx`;
  await privateWrite(join(workspace, path), makeWordFixture(["SYNTHETIC AGREEMENT", "The renewal notice period is 30 calendar days.", "Governing law: England and Wales."]));
  await driver.action("documents.open", { sessionId, path, show: true });
  const draft = await driver.action("document.read_draft");
  checks.push({ id: "real-live-word-document", passed: JSON.stringify(draft.result).includes("30 calendar days"), evidence: draft.result });
  const metadata = await driver.action("document.read_metadata");
  checks.push({ id: "real-live-word-pages", passed: metadata.result?.pageCount > 0, evidence: metadata.result });
  const browser = await driver.action("browser.open_url", { directory: workspace, workspaceId: connection.workspace.id, sessionId, provider: "builtin", url: `http://127.0.0.1:${fixture.address().port}`, show: true });
  checks.push({ id: "real-built-in-browser", passed: JSON.stringify(browser.result).includes("LW-SYNTHETIC-2026"), evidence: browser.result });
} catch (error) { checks.push({ id: "runtime-contract", passed: false, error: String(error) }); }
finally { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
const result = { kind: "real-electron-real-engine-no-inference-smoke", timestamp: new Date().toISOString(), preflight: record, checks, paidCalls: 0, passed: checks.length === 3 && checks.every(check => check.passed), limitations: ["Exercises actual Electron document/browser and engine readiness without inference. Does not establish model behavior, tool selection, live editing, legal quality or v2 compatibility."] };
await privateWrite(join(evidence, "smoke.json"), result);
console.log(JSON.stringify({ passed: result.passed, checks: checks.map(check => ({ id: check.id, passed: check.passed, error: check.error })), evidence, paidCalls: 0 }));
process.exitCode = result.passed ? 0 : 1;
