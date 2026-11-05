import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createWriteOnlyToolJournal, appendToWriteOnlySocket, verifyWriteOnlyAcknowledgments } from "./write-only-tool-journal.mjs";
import { verifyToolJournal } from "./tool-journal.mjs";

const event = { sessionID: "owned", messageID: "message", id: "parent", tool: "legalwork_read", input: { path: "source.txt" } };
async function fixture(t, append) {
  const directory = await mkdtemp(join(tmpdir(), "lw-write-only-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await createWriteOnlyToolJournal({ socketPath: join(directory, "socket"), healthPath: join(directory, "health.json"), location: "/task", runtimeKind: "legacy-v1", append: (socket, raw, hash) => JSON.parse(raw).phase === "observer.ready"
    ? Promise.resolve({ ok: true, sequence: 0, recordSha256: hash }) : append(socket, raw, hash) });
  return { directory, journal };
}

test("full >1MiB hook values leave no raw local file; hooks never wait for ACK and snapshot values before mutation", async t => {
  const records = [], releases = [];
  const { directory, journal } = await fixture(t, (_socket, raw, hash) => new Promise(resolve => {
    records.push({ raw, hash }); releases.push(() => resolve({ ok: true, sequence: JSON.parse(raw).sequence, recordSha256: hash }));
  }));
  const result = { output: { ok: true, content: "trace-only-sentinel-" + "x".repeat(1024 * 1024 + 17) }, metadata: { mime: "text/plain" } };
  assert.equal(journal.before(event), undefined);
  assert.equal(journal.after({ ...event, status: "completed", result }), undefined);
  result.output.content = "mutated-after-hook";
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.length, 1);
  releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  releases.shift()();
  const health = await journal.flush();
  assert.equal(JSON.parse(records[1].raw).result.output.content.length, "trace-only-sentinel-".length + 1024 * 1024 + 17);
  assert.deepEqual(await readdir(directory), [health.healthName]);
  const metadata = await readFile(join(directory, health.healthName), "utf8");
  assert.equal(metadata.includes("trace-only-sentinel"), false);
  assert.equal(metadata.includes("source.txt"), false);
  const collector = { observers: { [health.observerInstance]: { sequence: 2, lastSha256: health.lastSha256, registrationSha256: health.registrationSha256 } }, errors: [] };
  assert.equal(verifyWriteOnlyAcknowledgments(health, collector).captureIntegrityVerified, true);
  const raw = records.map(item => `${item.raw.slice(0, -1)},"recordSha256":"${item.hash}"}\n`).join("");
  assert.equal(verifyToolJournal(raw, health).complete, true);
});

test("unknown/lost ACK is sticky and is not retried or substituted for a tool result", async t => {
  let attempts = 0;
  const { journal } = await fixture(t, async () => { attempts++; throw new Error("closed after durable append"); });
  const output = { ok: false, error: "real domain failure" };
  assert.doesNotThrow(() => { journal.before(event); journal.after({ ...event, status: "completed", result: output }); });
  const health = await journal.flush();
  assert.equal(attempts, 2);
  assert.equal(health.errors.length, 2);
  assert.equal(health.acknowledgedSequence, 0);
  assert.deepEqual(output, { ok: false, error: "real domain failure" });
  assert.throws(() => verifyWriteOnlyAcknowledgments(health, { observers: {}, errors: [] }), /incomplete/);
});

test("same-parent concurrent identical calls retain both full results with unknown durations; before-only stays pending", async t => {
  const records = [];
  const { journal } = await fixture(t, async (_socket, raw, hash) => {
    const record = JSON.parse(raw); records.push(record);
    return { ok: true, sequence: record.sequence, recordSha256: hash };
  });
  journal.before(event); journal.before(event);
  journal.after({ ...event, status: "error", error: { message: "first settled failure" } });
  journal.after({ ...event, status: "completed", result: { output: { ok: false, content: "second domain error" } } });
  journal.before({ ...event, id: "denied-without-after" });
  const health = await journal.flush();
  assert.equal(health.pendingCalls, 1);
  assert.equal(records[2].elapsedMs, null); assert.equal(records[3].elapsedMs, null);
  assert.equal(records[2].error.message, "first settled failure");
  assert.equal(records[3].result.output.ok, false);
  assert.equal(records.filter(record => record.phase === "after").length, 2);
});

test("socket sends exact large payload and accepts only matching append acknowledgment", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lw-recorder-wire-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "s");
  let received;
  const server = createServer({ allowHalfOpen: true }, socket => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      data += chunk;
      if (!data.endsWith("\n")) return;
      received = JSON.parse(data);
      socket.end(`${JSON.stringify({ ok: true, sequence: 7, recordSha256: received.recordSha256 })}\n`);
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const payload = JSON.stringify({ sequence: 7, result: "€".repeat(1024 * 1024) });
  assert.equal((await appendToWriteOnlySocket(socketPath, payload, "exact-hash")).sequence, 7);
  assert.equal(received.payload, payload);
  assert.deepEqual(Object.keys(received), ["kind", "payload", "recordSha256"]);
});

test("changed ACK and root health disagreement cannot produce completeness", async t => {
  const { journal } = await fixture(t, async () => ({ ok: true, sequence: 999, recordSha256: "wrong" }));
  journal.before(event);
  const health = await journal.flush();
  assert.throws(() => verifyWriteOnlyAcknowledgments(health, { observers: {}, errors: [] }), /incomplete/);
  const clean = { ...health, errors: [], pendingWrites: 0, acknowledgedSequence: health.sequence, acknowledgedSha256: health.lastSha256 };
  assert.throws(() => verifyWriteOnlyAcknowledgments(clean, { observers: {}, errors: [] }), /disagree/);
});

test("empty preadmission observer requires actual registration acknowledgment and matching private root receipt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lw-recorder-ready-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sent = [];
  const journal = await createWriteOnlyToolJournal({ socketPath: join(directory, "s"), healthPath: join(directory, "metadata"), location: "/task", runtimeKind: "legacy-v1",
    append: async (_socket, raw, hash) => { sent.push(JSON.parse(raw)); return { ok: true, sequence: 0, recordSha256: hash }; } });
  const health = await journal.flush();
  assert.equal(health.ready, true); assert.equal(health.sequence, 0); assert.equal(sent.length, 1);
  assert.equal(sent[0].phase, "observer.ready"); assert.equal(sent[0].result, undefined); assert.equal(sent[0].input, undefined);
  assert.throws(() => verifyWriteOnlyAcknowledgments(health, { observers: {}, errors: [] }), /disagree/);
  const collector = { observers: { [health.observerInstance]: { sequence: 0, lastSha256: null, registrationSha256: health.registrationSha256 } }, errors: [] };
  assert.equal(verifyWriteOnlyAcknowledgments(health, collector).captureIntegrityVerified, true);
  const failed = await createWriteOnlyToolJournal({ socketPath: join(directory, "missing"), healthPath: join(directory, "failed"), location: "/task", runtimeKind: "legacy-v1", append: async () => { throw new Error("unavailable"); } });
  const failedHealth = await failed.flush();
  assert.equal(failedHealth.ready, false); assert.throws(() => verifyWriteOnlyAcknowledgments(failedHealth, collector), /incomplete/);
});
