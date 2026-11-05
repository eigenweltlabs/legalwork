import { formatWithOptions } from "node:util";
import { sendPinned } from "./raw-http-hop.js";
import { rawHttpNodeInput } from "./raw-http-node-contract.js";

Error.stackTraceLimit = Infinity;
type Call = { controller: AbortController; settled: boolean; active: Promise<void> };
const calls = new Map<string, Call>();
let closing = false, graceful = false, prefix: string | undefined, sequence = 0n;
const inspect = (error: unknown) => formatWithOptions({ depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity }, error);
function disconnect() { if (process.connected) process.disconnect(); }
function abortAll(error: unknown) { for (const call of calls.values()) call.controller.abort(error); }
function fail(error: unknown) {
  if (closing) return;
  closing = true; process.exitCode = 1; console.error(inspect(error)); abortAll(error);
  void Promise.all([...calls.values()].map(call => call.active)).finally(disconnect);
}
function reply(value: object) {
  if (closing || !process.connected || !process.send) return;
  process.send(value, error => { if (error) fail(error); });
}
process.once("disconnect", () => {
  if (graceful) return;
  closing = true; process.exitCode = 1; abortAll(new Error("HTTP transport parent disconnected."));
});
process.on("message", value => {
  if (closing) return;
  const parsed = rawHttpNodeInput.safeParse(value);
  if (!parsed.success) { fail(new Error("Invalid private HTTP worker request.", { cause: parsed.error })); return; }
  const message = parsed.data;
  if (message.kind === "shutdown") {
    if (calls.size) { fail(new Error("HTTP worker shutdown before calls were released.")); return; }
    closing = true; graceful = true; disconnect(); return;
  }
  if (message.kind !== "request") {
    const call = calls.get(message.id);
    if (!call) { fail(new Error("Unknown or duplicate HTTP worker call.")); return; }
    if (message.kind === "cancel") { call.controller.abort(new Error("HTTP request cancelled by parent.")); return; }
    if (!call.settled) { fail(new Error("HTTP worker ACK before actual socket cleanup.")); return; }
    calls.delete(message.id); reply({ kind: "released", id: message.id }); return;
  }
  const separator = message.id.lastIndexOf(":"), nextPrefix = message.id.slice(0, separator), nextSequence = BigInt(message.id.slice(separator + 1));
  if ((prefix !== undefined && prefix !== nextPrefix) || nextSequence <= sequence) { fail(new Error("Duplicate or out-of-order HTTP worker request.")); return; }
  prefix = nextPrefix; sequence = nextSequence;
  const controller = new AbortController();
  const call: Call = { controller, settled: false, active: Promise.resolve() };
  calls.set(message.id, call);
  call.active = (async () => {
    try {
      const result = await sendPinned(message.request, message.address, controller.signal, message.addresses, message.proxy);
      call.settled = true; reply({ kind: "settled", id: message.id, outcome: { kind: "result", result } });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const code = "code" in failure && typeof failure.code === "string" ? failure.code : undefined;
      call.settled = true;
      reply({ kind: "settled", id: message.id, outcome: { kind: "error", error: { name: failure.name, message: failure.message, stack: failure.stack, ...(code ? { code } : {}), details: inspect(error) } } });
    }
  })();
});
if (!process.send) throw new Error("HTTP worker requires its private parent IPC channel.");
process.send({ kind: "ready", pid: process.pid, node: process.versions.node, openssl: process.versions.openssl, rss: process.memoryUsage().rss }, error => { if (error) fail(error); });
