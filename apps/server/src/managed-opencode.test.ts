import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { createConfiguredManagedEngine } from "./managed-engine-lifecycle.js";
import type { ServerConfig } from "./types.js";

import { createManagedOpencodeServer } from "./managed-opencode.js";
import { verifiedTestEngine } from "./opencode-candidate.test-support.js";

// Real process identity/readiness checks must not inherit another unit test's
// mocked fetch, clock or interpreter lookup. Keep the complete executable
// suite in one clean Bun child and surface every failed assertion/output.
if (process.env.LEGALWORK_MANAGED_EXECUTABLE_FIXTURE !== "1") {
  test("managed engine executable lifecycle and identity checks in an isolated process", async () => {
    const child = Bun.spawn([process.execPath, "test", "--timeout", "25000", import.meta.filename], {
      env: { ...process.env, LEGALWORK_MANAGED_EXECUTABLE_FIXTURE: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 55_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const output = stdout + stderr;
      expect(code, output).toBe(0);
      expect(output).toContain("15 pass");
      expect(output).toContain("0 fail");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  }, 60_000);
} else {

// A stand-in for the opencode binary: it fails the first
// FAKE_OPENCODE_FAIL_UNTIL starts with the same "database is locked" message a
// not-yet-reaped predecessor produces, then comes up healthy. Invocation count
// is tracked in a file so the test can assert how many attempts happened.
const FAKE_OPENCODE = (version: string) => `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const counter = process.env.FAKE_OPENCODE_COUNTER;
const failUntil = Number(process.env.FAKE_OPENCODE_FAIL_UNTIL || "0");
let n = 0;
try { n = Number(fs.readFileSync(counter, "utf8")) || 0; } catch {}
n += 1;
fs.writeFileSync(counter, String(n));
fs.writeFileSync(counter + ".pid", String(process.pid));
fs.writeFileSync(counter + ".fff", process.env.OPENCODE_DISABLE_FFF || "");
fs.writeFileSync(counter + ".system-ca", process.env.NODE_USE_SYSTEM_CA || "");
const portIdx = process.argv.indexOf("--port");
const port = portIdx >= 0 ? process.argv[portIdx + 1] : "0";
if (n <= failUntil) {
  process.stderr.write("Error: Unexpected error\\n\\ndatabase is locked\\n");
  process.exit(1);
}
const stdio = process.argv.includes("--stdio");
process.stdout.write((stdio ? JSON.stringify({url:"http://127.0.0.1:"+port}) : "server listening on http://127.0.0.1:" + port) + "\\n");
const migrationStarted = Date.now();
setTimeout(() => http.createServer((request, response) => {
  if (request.headers.authorization !== "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64")) return response.writeHead(401).end();
  if (request.url === "/api/experimental/migration/v1") {
    response.setHeader("Content-Type", "application/json");
    const status = process.env.FAKE_OPENCODE_MIGRATION_ERROR ? {status: "error", error: "legacy conversion failed"}
      : Date.now() - migrationStarted < Number(process.env.FAKE_OPENCODE_MIGRATION_MS || "0")
      ? {status: "running", progress: {label: "Chats", numerator: 1, denominator: 2}} : {status: "completed"};
    return response.end(JSON.stringify(status));
  }
  if (request.url !== "/api/info") return response.writeHead(404).end();
  if (process.env.FAKE_OPENCODE_BAD_INFO === "1") return response.writeHead(200).end("not an API response");
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ version: process.env.FAKE_OPENCODE_VERSION || ${JSON.stringify(version)}, pid: process.env.FAKE_OPENCODE_WRONG_PID ? process.pid + 1 : process.pid }));
}).listen(Number(port), "127.0.0.1"), Number(process.env.FAKE_OPENCODE_LISTEN_DELAY_MS || "0"));
process.on("SIGTERM", () => { fs.writeFileSync(counter + ".sigterm", "true"); process.exit(0); });
if (stdio) { process.stdin.once("end", () => { fs.writeFileSync(counter + ".eof", "true"); process.exit(0); }); process.stdin.resume(); }
setInterval(() => {}, 1 << 30);
`;

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function fakeBin() {
  dir = mkdtempSync(join(tmpdir(), "managed-opencode-"));
  return { ...await verifiedTestEngine(dir, FAKE_OPENCODE), counter: join(dir, "counter") };
}

test("the default engine resolves the effective child PATH once and spawns that verified absolute path", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const cwd = join(dir!, "workspace"); mkdirSync(cwd);
  const server = await createManagedOpencodeServer({ cwd, candidateBuild,
    env: { PATH: [dirname(bin), dirname(process.execPath)].join(delimiter), FAKE_OPENCODE_COUNTER: counter },
  });
  try { expect(server.execution.command).toBe(await realpath(bin)); expect(server.running()).toBe(true); }
  finally { await server.close(); }
});

test("a corrupt first PATH executable is rejected without executing it or searching for a passing engine", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const first = join(dir!, "first"); mkdirSync(first);
  const marker = join(dir!, "rejected-engine-ran"), rejected = join(first, process.platform === "win32" ? "opencode.exe" : "opencode");
  writeFileSync(rejected, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, 'executed');\n`); chmodSync(rejected, 0o755);
  await expect(createManagedOpencodeServer({ cwd: dir!, candidateBuild,
    env: { PATH: [first, dirname(bin), dirname(process.execPath)].join(delimiter), FAKE_OPENCODE_COUNTER: counter },
  })).rejects.toThrow(/requested engine path/);
  expect(existsSync(marker)).toBe(false); expect(existsSync(counter)).toBe(false);
});

for (const relative of [false, true]) test(relative ? "an explicit relative engine path resolves against the intended child cwd" : "a relative PATH entry resolves against the intended child cwd", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const server = await createManagedOpencodeServer({ cwd: dir!, candidateBuild,
    ...(relative ? { bin: process.platform === "win32" ? ".\\opencode" : "./opencode" } : {}),
    env: { PATH: [relative ? dirname(process.execPath) : ".", dirname(process.execPath)].join(delimiter), FAKE_OPENCODE_COUNTER: counter },
  });
  try { expect(server.execution.command).toBe(await realpath(bin)); expect(server.running()).toBe(true); }
  finally { await server.close(); }
});

test("retries the engine spawn while the DB is locked, then succeeds", async () => {
  const { bin, counter, candidateBuild } = await fakeBin(); // fail twice, succeed on the 3rd
  const server = await createManagedOpencodeServer({
    bin, candidateBuild,
    cwd: dir!,
    env: { FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_FAIL_UNTIL: "2" },
  });
  try {
    expect(server.url).toContain("http://127.0.0.1:");
    expect(server.running()).toBe(true);
    expect(Number(readFileSync(counter, "utf8"))).toBe(3); // 2 locked + 1 healthy
  } finally {
    await server.close();
  }
  expect(server.running()).toBe(false);
}, 20000);

test("waits for the HTTP listener even when the child announces readiness early", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const startedAt = Date.now();
  const server = await createManagedOpencodeServer({
    bin, candidateBuild,
    cwd: dir!,
    env: { FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_LISTEN_DELAY_MS: "300" },
  });
  try {
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(server.username).toBe("opencode");
    expect((await fetch(`${server.url}/api/info`)).status).toBe(401);
    expect(server.execution.env.find(entry => entry.name === "OPENCODE_PASSWORD")?.redacted).toBe(true);
  } finally {
    await server.close();
  }
}, 20000);

test("native stdin lease uses JSON readiness and normal Stop closes EOF without signalling a live process", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const server = await createManagedOpencodeServer({ bin, candidateBuild, cwd: dir!, parentLease: true, env: { FAKE_OPENCODE_COUNTER: counter } });
  try {
    expect(server.execution.args).toContain("--stdio");
    expect(server.execution.args).not.toContain("--service");
    expect((await fetch(`${server.url}/api/info`)).status).toBe(401);
  } finally { await server.close(); }
  expect(server.running()).toBe(false);
  expect(readFileSync(counter + ".eof", "utf8")).toBe("true");
  expect(existsSync(counter + ".sigterm")).toBe(false);
});

test("keeps FFF disabled in the child and execution details even if caller env enables it", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const server = await createManagedOpencodeServer({
    bin, candidateBuild,
    cwd: dir!,
    env: { FAKE_OPENCODE_COUNTER: counter, OPENCODE_DISABLE_FFF: "false", NODE_USE_SYSTEM_CA: "0" },
  });
  try {
    expect(readFileSync(counter + ".fff", "utf8")).toBe("true");
    expect(readFileSync(counter + ".system-ca", "utf8")).toBe("1");
    expect(server.execution.env.find(entry => entry.name === "NODE_USE_SYSTEM_CA")).toEqual({ name: "NODE_USE_SYSTEM_CA", value: "1", redacted: false });
    expect(server.execution.env.find(entry => entry.name === "OPENCODE_DISABLE_FFF")).toEqual({
      name: "OPENCODE_DISABLE_FFF", value: "true", redacted: false,
    });
  } finally {
    await server.close();
  }
}, 20000);

test("does NOT retry a non-lock start failure (fails fast)", async () => {
  // fail "forever" but with a lock message would retry; use a bin that exits
  // with a different error so the loop must give up on the first attempt.
  dir = mkdtempSync(join(tmpdir(), "managed-opencode-"));
  const counter = join(dir, "counter");
  const { bin, candidateBuild } = await verifiedTestEngine(dir, () => `#!${process.execPath}
const fs = require("node:fs");
const counter = process.env.FAKE_OPENCODE_COUNTER;
let n = 0; try { n = Number(fs.readFileSync(counter, "utf8")) || 0; } catch {}
fs.writeFileSync(counter, String(n + 1));
process.stderr.write("Error: config parse failed\\n");
process.exit(1);
`);
  await expect(
    createManagedOpencodeServer({ bin, candidateBuild, cwd: dir, env: { FAKE_OPENCODE_COUNTER: counter } }),
  ).rejects.toThrow(/config parse failed/);
  expect(Number(readFileSync(counter, "utf8"))).toBe(1); // exactly one attempt
}, 20000);

test("a successful HTTP status with a non-API body cannot mark the engine ready", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  let published = false;
  await expect(createManagedOpencodeServer({
    bin, candidateBuild, cwd: dir!, timeoutMs: 2000, onAuthenticated: () => { published = true; },
    env: { FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_BAD_INFO: "1" },
  })).rejects.toThrow(/HTTP listener/);
  expect(published).toBe(false);
  expect(() => process.kill(Number(readFileSync(counter + ".pid", "utf8")), 0)).toThrow();
});

test("a foreign reported version cannot replace the verified engine identity", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  let published = false;
  await expect(createManagedOpencodeServer({
    // Reach the identity check even when starting the child is slow on CI.
    bin, candidateBuild, cwd: dir!, timeoutMs: 5000, onAuthenticated: () => { published = true; },
    env: { FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_VERSION: "2.1.4-legalwork.mcp-ready.1", FAKE_OPENCODE_LISTEN_DELAY_MS: "650" },
  })).rejects.toThrow(/spawned OpenCode .* process/);
  expect(published).toBe(false);
  expect(() => process.kill(Number(readFileSync(counter + ".pid", "utf8")), 0)).toThrow();
}, 10000);

test("matching version from another PID cannot mark the managed process ready", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  let published = false;
  await expect(createManagedOpencodeServer({
    bin, candidateBuild, cwd: dir!, timeoutMs: 5000, onAuthenticated: () => { published = true; },
    env: { FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_WRONG_PID: "1", FAKE_OPENCODE_LISTEN_DELAY_MS: "650" },
  })).rejects.toThrow(/spawned OpenCode .* process/);
  expect(published).toBe(false);
  expect(() => process.kill(Number(readFileSync(counter + ".pid", "utf8")), 0)).toThrow();
}, 10000);

function startupConfig(): ServerConfig {
  return { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", workspaces: [], authorizedRoots: [],
    readOnly: true, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
}

test("waits for history migration beyond the HTTP startup watchdog", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const config = startupConfig();
  const statuses: string[] = [];
  const startedAt = Date.now();
  const server = await createConfiguredManagedEngine(config, {
    bin, candidateBuild, cwd: dir!, timeoutMs: 2000,
    env: { OPENCODE_DB: "", FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_MIGRATION_MS: "3000" },
    onMigrationProgress: status => { statuses.push(status.status);
      expect(config.managedEngineStarting).toBe(true);
      expect(config.managedEngineStatus).toBe(status.status === "running" ? "migrating" : "starting"); },
  });
  try {
    expect(config.managedEngineStatus).toBe("ready");
    expect(config.managedEngineStarting).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3000);
    expect(statuses).toContain("running");
    expect(statuses.at(-1)).toBe("completed");
  } finally { await server.close(); }
});

test("migration errors fail startup and reap the engine", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const config = startupConfig();
  await expect(createConfiguredManagedEngine(config, { bin, candidateBuild, cwd: dir!,
    env: { OPENCODE_DB: "", FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_MIGRATION_ERROR: "1" },
  })).rejects.toThrow("chat history migration failed: legacy conversion failed");
  expect(config.managedEngineStatus).toBe("error");
  expect(config.managedEngineStarting).toBe(false);
  expect(() => process.kill(Number(readFileSync(counter + ".pid", "utf8")), 0)).toThrow();
});

test("cancelling startup during migration reaps the engine", async () => {
  const { bin, counter, candidateBuild } = await fakeBin();
  const controller = new AbortController();
  await expect(createManagedOpencodeServer({ bin, candidateBuild, cwd: dir!, signal: controller.signal,
    env: { FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_MIGRATION_MS: "60000" },
    onMigrationProgress: status => { if (status.status === "running") controller.abort(new Error("Startup cancelled")); },
  })).rejects.toThrow("Startup cancelled");
  expect(() => process.kill(Number(readFileSync(counter + ".pid", "utf8")), 0)).toThrow();
});

}
