// TEST ONLY. This fixture deliberately simulates failures; never ship it as the mail worker.
import { createInterface } from "node:readline";
let mode;
function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.kind === "initialize") {
    mode = message.initialization.databasePath;
    const key = message.initialization.encryptionKey;
    if (key && (process.argv.some((arg) => arg.includes(key)) || Object.values(process.env).some((value) => value?.includes(key)))) process.exit(42);
    if (mode === "startup-hang") return;
    if (mode === "startup-crash") process.exit(1);
    if (mode === "startup-malformed") { process.stdout.write("not-json\n"); return; }
    output({ kind: "ready", protocol: 1, runtime: "node", nodeVersion: process.versions.node });
    if (key) process.stderr.write(`secret from stderr: ${key}\n`);
    return;
  }
  if (message.kind === "shutdown") {
    if (mode === "shutdown-hang") { setInterval(() => {}, 1000); return; }
    process.exit(0);
  }
  const account = message.command.accountId;
  if (account === "crash") process.exit(7);
  if (account === "hang") return;
  if (account === "malformed") { process.stdout.write('{"kind":"secret-value"}\n'); return; }
  if (account === "oversize") { process.stdout.write("x".repeat(70 * 1024)); return; }
  if (account === "unknown-id") { output({ kind: "response", id: "999:999", ok: true, result: { state: "idle", syncSupported: false } }); return; }
  if (account === "wrong-result") { output({ kind: "response", id: message.id, ok: true, result: { pong: true } }); return; }
  if (account === "worker-error") { output({ kind: "response", id: message.id, ok: false, code: "operation_failed" }); return; }
  const result = message.command.operation === "ping" ? { pong: true }
    : message.command.operation === "credentials.update" ? { updated: true }
      : message.command.operation === "mail.status" ? { state: account === "slow" ? "syncing" : "idle", syncSupported: true } : { accepted: true };
  setTimeout(() => output({ kind: "response", id: message.id, ok: true, result }), account === "slow" ? 60 : 0);
});
