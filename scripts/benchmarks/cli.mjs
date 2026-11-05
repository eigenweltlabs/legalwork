#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns, privateWrite, readJson } from "./evidence.mjs";
import { preflight, runSuite } from "./electron-runner.mjs";
import { startCaptureProxy } from "./capture-proxy.mjs";

const harnessRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [command, ...args] = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`); return args[index + 1]; }
const repo = resolve(option("--repo", harnessRoot));
const root = option("--root", process.env.LEGALWORK_BENCH_ROOT);
let browserFixture;

try {
  if (command === "compare") {
    const comparison = compareRuns(await readJson(option("--baseline")), await readJson(option("--candidate")));
    console.log(JSON.stringify(comparison, null, 2));
    process.exitCode = comparison.passed ? 0 : 1;
  } else {
    if (!root) throw new Error("Pass --root with a private directory outside the checkout");
    const privateRoot = resolve(root);
    if (privateRoot === repo || privateRoot.startsWith(`${repo}/`)) throw new Error("Benchmark evidence must live outside the checkout");
    const environmentPath = option("--environment");
    let environment = environmentPath ? await (await import("./packaged-environment.mjs")).createPackagedEnvironment(environmentPath) : undefined;
    const browserFixturePath = option("--browser-fixture-config");
    if (browserFixturePath) {
      if (command !== "run" || !environment) throw new Error("--browser-fixture-config requires run with an isolated packaged --environment");
      browserFixture = await (await import("./browser-register-environment.mjs")).startBrowserRegisterEnvironment(environment, browserFixturePath, environmentPath);
      environment = browserFixture.environment;
    }
    const profile = join(privateRoot, "electron");
    const workspace = join(privateRoot, "workspace");
    if (command === "init") {
      try { await stat(join(profile, "legalwork-workspaces.json")); throw new Error("Refusing to overwrite an existing benchmark profile"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const id = `ws_${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
      await privateWrite(join(profile, "legalwork-workspaces.json"), { recoveryCompleted: true, selectedId: id, watchedId: null, activeId: id, workspaces: [{ id, name: "Migration benchmark", path: workspace, preset: "starter", workspaceType: "local" }] });
      await privateWrite(join(privateRoot, "bootstrap.json"), { baseUrl: "", apiBaseUrl: "", requireSignin: false });
      const env = { LEGALWORK_DEV_MODE: "1", LEGALWORK_ELECTRON_USERDATA: profile, LEGALWORK_DATA_DIR: join(privateRoot, "server-data"), LEGALWORK_DESKTOP_BOOTSTRAP_PATH: join(privateRoot, "bootstrap.json"), LEGALWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY: "1", LEGALWORK_ELECTRON_APP_IDENTIFIER: "com.eigenweltlabs.legalwork.migration-benchmark", LEGALWORK_ELECTRON_APP_NAME: "LegalWork Migration Benchmark", VITE_DISABLE_LEGALWORK_MODELS: "1", LEGALWORK_WORD_ADDIN: "0", PORT: option("--port", "5373") };
      await privateWrite(join(privateRoot, "launch-env.json"), env);
      console.log(JSON.stringify({ root: privateRoot, launchEnv: join(privateRoot, "launch-env.json"), next: "node scripts/benchmarks/launch.mjs --root <private root>", caveat: "Configure an isolated restricted benchmark provider before inference. init and preflight make no model calls." }, null, 2));
    } else if (command === "preflight") {
      const output = option("--output", join(privateRoot, `preflight-${Date.now()}`));
      const { record } = await preflight({ repo, profile, workspace, environment, evidence: output, expectedBase: option("--expected-base"), uiReadyTimeoutMs: Number(option("--ui-ready-timeout-ms", "30000")) });
      console.log(JSON.stringify({ passed: true, engine: record.engineHealth, git: record.git, evidence: output, paidCalls: 0 }, null, 2));
    } else if (command === "proxy") {
      const configPath = option("--config");
      if (!configPath) throw new Error("--config requires an owner-only gateway configuration file outside the checkout");
      const config = await readJson(configPath);
      const { createBudgetGuard } = await import("./budget-guard.mjs");
      if (!config.budgetLedgerPath) throw new Error("Pin the shared migration budgetLedgerPath in the private proxy config; never create a fresh ledger for another profile/run");
      if (!config.budgetAuditPath) throw new Error("A fresh production model-info audit file is required before paid-mode proxy startup");
      // The config selects a reviewed run plan, never a numeric ceiling or trust override.
      const { verifyBudgetRunCoverage } = await import("./budget-ceiling.mjs");
      const runCoverage = config.budgetCoveragePath ? await verifyBudgetRunCoverage({
        coveragePath: config.budgetCoveragePath, expectedSha256: config.budgetCoverageSha256,
      }) : undefined;
      const budgetGuard = await createBudgetGuard({ ledgerPath: config.budgetLedgerPath,
        auditAttestation: await readJson(config.budgetAuditPath), totalEur: runCoverage ? 250 : 100, runCoverage });
      const proxy = await startCaptureProxy({ ...config, fixtureMode: false, budgetGuard, root: join(privateRoot, "provider-traces") });
      await privateWrite(join(privateRoot, "capture-connection.json"), { baseURL: proxy.baseURL, localToken: config.localToken });
      console.log(JSON.stringify({ listening: proxy.baseURL, evidence: join(privateRoot, "provider-traces"), bodyMutation: false }));
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await proxy.close(); });
    } else if (command === "run") {
      const suite = await readJson(option("--suite", join(harnessRoot, "scripts/benchmarks/suites/capabilities.json")));
      const capture = await readJson(join(privateRoot, "capture-connection.json"));
      const timeout = option("--task-timeout-ms", "none");
      const result = await runSuite({ suite, repo, profile, workspace, capture, environment, evidence: option("--output", join(privateRoot, `runs/${Date.now()}`)), expectedBase: option("--expected-base"), settings: { uiReadyTimeoutMs: Number(option("--ui-ready-timeout-ms", "30000")), pollIntervalMs: Number(option("--poll-ms", "1000")), taskTimeoutMs: timeout === "none" ? null : Number(timeout), timeoutReason: timeout === "none" ? "No harness task deadline; manual cancellation or budget refusal ends spending." : "Explicit operator watchdog; timed-out tasks fail and their full partial evidence is retained.", injectedRetries: 0, outputCaps: false } });
      console.log(JSON.stringify({ passed: result.passed, items: result.items.map(item => ({ id: item.id, status: item.status, evaluation: item.evaluation, assertions: item.assertions })) }, null, 2));
      process.exitCode = result.passed ? 0 : 1;
    } else throw new Error("Commands: init, preflight, proxy, run, compare. See scripts/benchmarks/README.md.");
  }
} catch (error) { console.error(String(error)); process.exitCode = 1; }
finally { if (browserFixture) await browserFixture.close(); }
