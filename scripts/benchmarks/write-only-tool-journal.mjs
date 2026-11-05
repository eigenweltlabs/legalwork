// Opt-in benchmark instrumentation. Raw values only leave this process through
// the append-only Unix socket; they are never written to an agent-readable file.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createConnection } from "node:net";
import { canonical } from "./tool-journal.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const snapshot = value => JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error
  ? { ...item, name: item.name, message: item.message, stack: item.stack, ...(item.cause === undefined ? {} : { cause: item.cause }) }
  : item));

// One attempt for each event. An unknown/lost ACK is sticky evidence failure;
// retrying could create duplicate records and pretend that capture was complete.
export function appendToWriteOnlySocket(socketPath, payload, recordSha256) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let response = "", settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once("error", error => finish(error));
    socket.once("end", () => finish(new Error("recorder_closed_without_ack")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ kind: "append", payload, recordSha256 })}\n`));
    socket.on("data", chunk => {
      response += chunk.toString("utf8");
      if (!response.includes("\n")) return;
      try {
        const ack = JSON.parse(response.slice(0, response.indexOf("\n")));
        if (ack.ok !== true || ack.recordSha256 !== recordSha256) throw new Error("recorder_ack_rejected_or_changed");
        finish(null, ack);
      } catch (error) { finish(error); }
    });
  });
}

export async function createWriteOnlyToolJournal({ socketPath, healthPath, location, runtimeKind, append = appendToWriteOnlySocket }) {
  const observerInstance = randomUUID();
  const metadataPath = `${healthPath}.${observerInstance}.json`;
  const health = { contractVersion: 4, transport: "linux-peercred-write-only", observerInstance, location, runtimeKind,
    healthName: basename(metadataPath),
    ready: false, registrationSha256: null,
    sequence: 0, lastSha256: null, acknowledgedSequence: 0, acknowledgedSha256: null,
    pendingWrites: 0, pendingCalls: 0, errors: [], bytes: 0, enqueueMs: 0, transportMs: 0,
    outputCaps: false, automaticRetries: 0, mutatesEngine: false, rawLocalFiles: false };
  let queue = Promise.resolve(), metadataQueue = Promise.resolve();
  const pending = new Map();
  const key = event => canonical([event.sessionID, event.messageID, event.id, event.tool, event.input]);
  function note(operation, error) { health.errors.push({ operation, code: error?.code ?? error?.name ?? "Error" }); }
  function publish() {
    const value = JSON.stringify({ ...snapshot(health), updatedAt: new Date().toISOString() });
    metadataQueue = metadataQueue.then(async () => {
      try {
        await mkdir(dirname(metadataPath), { recursive: true, mode: 0o700 });
        const temporary = `${metadataPath}.${randomUUID()}.tmp`;
        await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
        await rename(temporary, metadataPath);
      } catch (error) { note("metadata_health", error); }
    }).catch(error => note("metadata_queue", error));
  }
  function enqueue(value) {
    const started = performance.now();
    try {
      const payload = JSON.stringify({ observerInstance, sequence: health.sequence + 1, previousSha256: health.lastSha256,
        location, runtimeKind, ...snapshot(value) });
      const recordSha256 = digest(payload), sequence = ++health.sequence;
      health.lastSha256 = recordSha256;
      health.pendingWrites++;
      health.bytes += Buffer.byteLength(payload);
      queue = queue.then(async () => {
        const transportStarted = performance.now();
        try {
          const ack = await append(socketPath, payload, recordSha256);
          if (ack.sequence !== sequence) throw new Error("recorder_ack_sequence_changed");
          health.acknowledgedSequence = sequence;
          health.acknowledgedSha256 = recordSha256;
        } catch (error) { note("append_or_ack", error); }
        finally { health.pendingWrites--; health.transportMs += performance.now() - transportStarted; publish(); }
      }).catch(error => note("transport_queue", error));
    } catch (error) { note("snapshot_or_enqueue", error); }
    finally { health.enqueueMs += performance.now() - started; publish(); }
  }
  // Install this observer only after the controller has bound/started the sink.
  // The metadata-only registration proves actual engine-peer transport before
  // any model admission, without inserting a tool or conversation message.
  health.pendingWrites++;
  queue = queue.then(async () => {
    try {
      const payload = JSON.stringify({ observerInstance, sequence: 0, previousSha256: null,
        location, runtimeKind, phase: "observer.ready", at: new Date().toISOString() });
      const registrationSha256 = digest(payload), ack = await append(socketPath, payload, registrationSha256);
      if (ack.sequence !== 0) throw new Error("recorder_registration_ack_changed");
      health.registrationSha256 = registrationSha256; health.ready = true;
    } catch (error) { note("registration_or_ack", error); }
    finally { health.pendingWrites--; publish(); }
  }).catch(error => note("registration_queue", error));
  publish();
  return {
    // Deliberately do not await recorder I/O in engine hooks. An unavailable or
    // stalled recorder must not change tool outputs, errors, permissions or pace.
    before(event) {
      try {
        const group = pending.get(key(event)) ?? { starts: [], ambiguous: false };
        if (group.starts.length) group.ambiguous = true;
        const start = { at: new Date().toISOString(), monotonic: performance.now() };
        group.starts.push(start); pending.set(key(event), group); health.pendingCalls++;
        enqueue({ phase: "before", at: start.at, ...event });
      } catch (error) { note("before", error); publish(); }
    },
    after(event) {
      try {
        const group = pending.get(key(event)), start = group?.starts.shift(), ambiguous = group?.ambiguous === true;
        if (start) health.pendingCalls--;
        if (group && !group.starts.length) pending.delete(key(event));
        const completedAt = new Date().toISOString();
        enqueue({ phase: "after", at: completedAt, ...event, toolID: event.tool, callID: event.id,
          startedAt: start?.at ?? null, completedAt,
          elapsedMs: start && !ambiguous ? performance.now() - start.monotonic : null,
          pairing: !start ? "before-unavailable" : ambiguous ? "duplicate-concurrent-key-duration-unknown" : "exact-session-message-call-tool-input" });
      } catch (error) { note("after", error); publish(); }
    },
    async flush() { await queue; publish(); await metadataQueue; return snapshot(health); },
    async close() { return this.flush(); },
  };
}

export function verifyWriteOnlyAcknowledgments(health, collector) {
  if (health.ready !== true || health.errors?.length || health.pendingWrites !== 0 || health.sequence !== health.acknowledgedSequence
    || health.lastSha256 !== health.acknowledgedSha256 || collector.errors?.length) throw new Error("Write-only capture/ACK health incomplete");
  const observed = collector.observers?.[health.observerInstance];
  if (!observed || observed.registrationSha256 !== health.registrationSha256 || observed.sequence !== health.sequence || observed.lastSha256 !== health.lastSha256) throw new Error("Write-only producer and root journal disagree");
  return { captureIntegrityVerified: true, contractVersion: 4, fullRawReturnCoverage: "requires-history-and-lifecycle-evaluation",
    noAgentReadableRawFiles: true, pendingCalls: health.pendingCalls,
    overhead: { enqueueMs: health.enqueueMs, transportMs: health.transportMs, note: "Asynchronous recorder overhead remains observed; no hypothetical latency subtraction." } };
}
