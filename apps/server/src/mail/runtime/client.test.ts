import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { MailWorkerClient, type MailWorkerOptions, type WorkerDiagnostic } from "./client.js";
import { probeWorkerExecutable } from "./executable.js";
import { parseParentMessage } from "./protocol.js";

// Resolve a concrete Node binary for fixture tests; production configuration always supplies its path.
const nodePath = process.env.LEGALWORK_MAIL_TEST_NODE ?? Bun.which("node");
if (!nodePath) throw new Error("Set LEGALWORK_MAIL_TEST_NODE to an absolute Node 22+ executable");
const executable = { kind: "node", path: nodePath } satisfies MailWorkerOptions["executable"];
const entryPoint = fileURLToPath(new URL("./fixtures/worker.mjs", import.meta.url));
const clients: MailWorkerClient[] = [];
function client(options: Partial<MailWorkerOptions> = {}) {
  const value = new MailWorkerClient({ executable, entryPoint, initialize: () => ({}), startupTimeoutMs: 500,
    requestTimeoutMs: 250, shutdownTimeoutMs: 100, maxRestarts: 0, restartDelayMs: 30, ...options });
  clients.push(value);
  return value;
}
afterEach(async () => { await Promise.all(clients.splice(0).map((value) => value.stop())); });
async function until(check: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("test_condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test("Bun parent probes a real compatible Node child and rejects Bun executable", async () => {
  expect(process.versions.bun).toBeDefined();
  expect(Number((await probeWorkerExecutable(executable)).nodeVersion.split(".")[0])).toBeGreaterThanOrEqual(22);
  await expect(probeWorkerExecutable({ kind: "node", path: process.execPath })).rejects.toThrow("requires_node");
});
test("ready handshake, coalesced start and out-of-order correlation", async () => {
  const worker = client();
  const start = worker.start();
  expect(worker.start()).toBe(start);
  await start;
  const slow = worker.request({ operation: "mail.status", accountId: "slow" });
  const fast = worker.request({ operation: "mail.status", accountId: "fast" });
  expect(await fast).toEqual({ state: "idle" });
  expect(await slow).toEqual({ state: "syncing" });
  expect(await worker.request({ operation: "ping" })).toEqual({ pong: true });
});
test("crash rejects every pending request", async () => {
  const worker = client(); await worker.start();
  const results = await Promise.allSettled([
    worker.request({ operation: "mail.status", accountId: "hang" }),
    worker.request({ operation: "mail.status", accountId: "crash" }),
  ]);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(worker.status().pending).toBe(0);
});
test("lost response times out and kills generation without replay", async () => {
  const worker = client({ requestTimeoutMs: 40 }); await worker.start();
  await expect(worker.request({ operation: "mail.status", accountId: "hang" })).rejects.toThrow("request_timeout");
  await until(() => worker.status().state === "failed");
  expect(worker.status().pending).toBe(0);
});
test("malformed, oversized, wrong-result and uncorrelated messages fail closed", async () => {
  for (const accountId of ["malformed", "oversize", "unknown-id", "wrong-result"]) {
    const worker = client(); await worker.start();
    await expect(worker.request({ operation: "mail.status", accountId })).rejects.toThrow("mail_worker_");
    expect(worker.status().pending).toBe(0);
    await worker.stop();
  }
});
test("startup hangs and malformed handshakes are bounded", async () => {
  for (const databasePath of ["startup-hang", "startup-malformed"]) {
    const worker = client({ startupTimeoutMs: 70, initialize: () => ({ databasePath }) });
    await expect(worker.start()).rejects.toThrow("mail_worker_");
    await worker.stop();
  }
});
test("initialization supplier hang is bounded and stop cancels it", async () => {
  const worker = client({ startupTimeoutMs: 60, initialize: () => new Promise(() => {}) });
  await expect(worker.start()).rejects.toThrow("start_failed");
  const stopped = client({ initialize: () => new Promise(() => {}) });
  const start = stopped.start();
  const stopping = stopped.stop();
  await expect(start).rejects.toThrow("stopped");
  await stopping;
});
test("restart budget caps repeated startup crashes", async () => {
  const diagnostics: WorkerDiagnostic[] = [];
  const worker = client({ maxRestarts: 2, initialize: () => ({ databasePath: "startup-crash" }), onDiagnostic: (value) => diagnostics.push(value) });
  await expect(worker.start()).rejects.toThrow("exited");
  await until(() => worker.status().state === "failed" && worker.status().restarts === 2);
  expect(diagnostics.filter((value) => value.event === "restart_scheduled")).toHaveLength(2);
});
test("recovers after crash without replay, and stop cancels backoff", async () => {
  const worker = client({ maxRestarts: 2, restartDelayMs: 50 }); await worker.start();
  await expect(worker.request({ operation: "mail.status", accountId: "crash" })).rejects.toThrow("exited");
  await until(() => worker.status().state === "ready");
  expect(await worker.request({ operation: "ping" })).toEqual({ pong: true });
  await expect(worker.request({ operation: "mail.status", accountId: "crash" })).rejects.toThrow("exited");
  await worker.stop();
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(worker.status().state).toBe("stopped");
});
test("graceful stop rejects pending, supports explicit restart and kills hung shutdown", async () => {
  const worker = client({ initialize: () => ({ databasePath: "shutdown-hang" }) }); await worker.start();
  const pending = worker.request({ operation: "mail.status", accountId: "hang" });
  const stopping = worker.stop();
  await expect(pending).rejects.toThrow("stopped");
  await stopping;
  expect(worker.status().state).toBe("stopped");
  await worker.start();
  expect(await worker.request({ operation: "ping" })).toEqual({ pong: true });
});
test("pending admission and outbound payload sizes are bounded", async () => {
  const worker = client({ maxPending: 1 }); await worker.start();
  const slow = worker.request({ operation: "mail.status", accountId: "slow" });
  await expect(worker.request({ operation: "ping" })).rejects.toThrow("busy");
  await slow;
  await expect(worker.request({ operation: "credentials.update", credentials: { accountId: "test", provider: "gmail", accessToken: "x".repeat(70 * 1024) } })).rejects.toThrow("rejected");
  expect(worker.status().pending).toBe(0);
});
test("pipe secrets and worker stderr never appear in diagnostics", async () => {
  const secret = "private-key-secret-value";
  const diagnostics: WorkerDiagnostic[] = [];
  process.env.MAIL_TEST_PARENT_SECRET = secret;
  const worker = client({ initialize: () => ({ encryptionKey: secret }), onDiagnostic: (value) => diagnostics.push(value) });
  try {
    await worker.start();
    expect(await worker.request({ operation: "credentials.update", credentials: { accountId: "test", provider: "gmail", refreshToken: secret } })).toEqual({ updated: true });
    await expect(worker.request({ operation: "mail.status", accountId: "malformed" })).rejects.toThrow("protocol_error");
    expect(JSON.stringify(diagnostics)).not.toContain("secret-value");
    expect(JSON.stringify(worker.status())).not.toContain(secret);
  } finally { delete process.env.MAIL_TEST_PARENT_SECRET; }
});
test("operation failures do not crash healthy worker", async () => {
  const worker = client(); await worker.start();
  await expect(worker.request({ operation: "mail.status", accountId: "worker-error" })).rejects.toThrow("operation_failed");
  expect(await worker.request({ operation: "ping" })).toEqual({ pong: true });
});

test("worker-side protocol rejects arbitrary SQL, network and filesystem commands", () => {
  for (const command of [{ operation: "sql", query: "DELETE FROM mail" }, { operation: "fetch", url: "https://example.com" }, { operation: "readFile", path: "/etc/passwd" }]) {
    expect(parseParentMessage(JSON.stringify({ kind: "request", id: "1:1", command }))).toBeUndefined();
  }
  expect(parseParentMessage(JSON.stringify({ kind: "initialize", protocol: 1, initialization: { command: "shell" } }))).toBeUndefined();
});
const electronPath = process.env.LEGALWORK_MAIL_TEST_ELECTRON;
test.skipIf(!electronPath)("Electron Node mode completes actual worker lifecycle without UI", async () => {
  if (!electronPath) return;
  const worker = client({ executable: { kind: "electron", path: electronPath } });
  await worker.start();
  expect(await worker.request({ operation: "ping" })).toEqual({ pong: true });
  await worker.stop();
  expect(worker.status().state).toBe("stopped");
});
