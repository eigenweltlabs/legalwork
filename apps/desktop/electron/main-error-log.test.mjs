import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { installMainErrorLog, logWindowErrors } from "./main-error-log.mjs";
import { buildSupportBundleText } from "./support-bundle.mjs";

// Installs the log over silent console stubs so test output stays clean, then
// restores the real console and stack limit.
function withMainErrorLog(run) {
  const logsDir = mkdtempSync(path.join(os.tmpdir(), "legalwork-main-log-"));
  const { error, warn } = console;
  const { stackTraceLimit } = Error;
  console.error = () => {};
  console.warn = () => {};
  try {
    installMainErrorLog(() => logsDir);
    run(logsDir);
  } finally {
    console.error = error;
    console.warn = warn;
    Error.stackTraceLimit = stackTraceLimit;
    rmSync(logsDir, { recursive: true, force: true });
  }
}

describe("installMainErrorLog", () => {
  it("keeps an embedded-server route failure, with its stack, for the support bundle", () => {
    withMainErrorLog((logsDir) => {
      // Past the old 64 KB bundle tail, so the bundle must carry main.log whole.
      console.warn("first entry", "y".repeat(100_000));
      const failure = new Error("Nested mappings are not allowed in compact mappings");
      // The call server.ts makes when a route throws something that is not an ApiError.
      console.error("[legalwork-server] Unhandled error:", "GET", "/workspace/ws_1/skills/client-update", failure);

      const log = readFileSync(path.join(logsDir, "main.log"), "utf8");
      assert.match(log, /ERROR \[legalwork-server\] Unhandled error: GET \/workspace\/ws_1\/skills\/client-update Error: Nested mappings/);
      assert.ok(log.includes(failure.stack.split("\n")[1].trim()), "stack frames are kept");

      const bundle = buildSupportBundleText({
        app: { getName: () => "LegalWork", getVersion: () => "0.0.0", isPackaged: true, getPath: () => logsDir },
        runtimeManager: { collectRuntimeDiagnostics: () => ({}) },
      });
      assert.match(bundle, /Log file: main\.log/);
      assert.match(bundle, /WARN first entry y{100000}\n/);
      assert.match(bundle, /\[legalwork-server\] Unhandled error: GET \/workspace\/ws_1\/skills\/client-update Error: Nested mappings/);
    });
  });

  it("keeps deep stacks, nested details and long strings whole", () => {
    withMainErrorLog((logsDir) => {
      // 15 distinct frames: past node's default of 10 (recursion would print
      // as one collapsed line).
      let call = () => new Error("created 15 calls deep");
      for (let index = 0; index < 15; index += 1) {
        const inner = call;
        call = { [`frame${index}`]: () => inner() }[`frame${index}`];
      }
      const failure = Object.assign(call(), {
        details: { a: { b: { c: { d: "detail at depth 4" } } } },
        body: `${"z".repeat(12_000)}END`,
      });
      console.error("[skills] failure:", failure);

      const log = readFileSync(path.join(logsDir, "main.log"), "utf8");
      for (let index = 0; index < 15; index += 1) assert.match(log, new RegExp(`at frame${index} `));
      assert.match(log, /detail at depth 4/);
      assert.match(log, /z{12000}END/);
    });
  });

  it("rotates main.log to main.old.log once it passes the size cap", () => {
    withMainErrorLog((logsDir) => {
      const filler = "x".repeat(100_000);
      for (let index = 0; index < 11; index += 1) console.warn(`entry-${index}`, filler);

      const current = readFileSync(path.join(logsDir, "main.log"), "utf8");
      const previous = readFileSync(path.join(logsDir, "main.old.log"), "utf8");
      assert.match(current, /WARN entry-10 /);
      assert.doesNotMatch(current, /entry-9 /);
      assert.match(previous, /WARN entry-9 /);
    });
  });
});

describe("buildSupportBundleText", () => {
  it("says how this machine reaches GitHub", () => {
    withMainErrorLog((logsDir) => {
      const bundle = buildSupportBundleText({
        app: { getName: () => "LegalWork", getVersion: () => "0.0.0", isPackaged: true, getPath: () => logsDir },
        runtimeManager: { collectRuntimeDiagnostics: () => ({}) },
        network: { systemProxyForGithub: "PROXY proxy.firm.local:8080", proxyEnv: {} },
      });
      assert.match(bundle, /========== Network ==========\n\{\n {2}"systemProxyForGithub": "PROXY proxy\.firm\.local:8080"/);
    });
  });
});

describe("logWindowErrors", () => {
  it("keeps an app window's console warnings, errors and crashes", () => {
    withMainErrorLog((logsDir) => {
      const contents = new EventEmitter();
      logWindowErrors(contents);
      contents.emit("console-message", {
        level: "warning",
        message: "[legalwork-server] POST http://127.0.0.1:5000/workspace/ws_1/github-skills/scan failed after 10002ms: Request timed out.",
        lineNumber: 12,
        sourceId: "app.js",
      });
      contents.emit("console-message", { level: "info", message: "chatty", lineNumber: 1, sourceId: "app.js" });
      contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });

      const log = readFileSync(path.join(logsDir, "main.log"), "utf8");
      assert.match(log, /WARN \[window\] \[legalwork-server\] POST \S+\/github-skills\/scan failed after 10002ms: Request timed out\. \(app\.js:12\)/);
      assert.doesNotMatch(log, /chatty/);
      assert.match(log, /ERROR \[window\] Renderer process gone: \{ reason: 'crashed', exitCode: 5 \}/);
    });
  });
});
