import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { CloudTranscriber, pcm16 } from "./audio/cloud-transcriber.mjs";
import { createDictationSpeechDetector } from "./audio/dictation-speech.mjs";
import { RecorderService } from "./audio/recorder-service.mjs";

const until = async condition => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

async function fixture(t, options = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const requests = [];
  server.on("connection", (socket, request) => {
    const state = { socket, request, frames: [], commands: [] };
    requests.push(state);
    if (request.url.includes("/transcription/diarize")) {
      socket.on("message", raw => {
        state.frames.push(Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw));
        if (options.holdSpeakers) return;
        setTimeout(() => socket.send(JSON.stringify(options.speakerFailure
          ? { type: "error", error: "Provider failed" }
          : { type: "speakers", words: [{ startMs: 0, endMs: 2000, speaker: "provider-id" }] })), 20);
      });
      return;
    }
    socket.on("message", (raw, binary) => {
      if (binary) state.frames.push(Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw));
      else {
        const command = JSON.parse(String(raw));
        state.commands.push(command);
        if (command.type === "cancel") socket.send(JSON.stringify({ type: "done" }));
        if (command.type === "finish") {
          socket.send(JSON.stringify({ type: "segment", text: "70.388,50 Euro.", startMs: 0, endMs: 200, id: "s" }));
          socket.send(JSON.stringify({ type: "done" }));
        }
      }
    });
    setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: "ready" })); }, options.readyDelay ?? 15);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  const resolveConnection = async (model = "gemini-transcribe-live-eu") => ({ url: `ws://127.0.0.1:${address.port}/v1/transcription/live?model=${model}`, apiKey: "fixture-subscription-key" });
  const worker = new CloudTranscriber({ modelId: "gemini-transcribe-live-eu", language: "de", resolveConnection,
    createSpeechDetector: options.createSpeechDetector ?? null,
    ...(options.rotateMs ? { rotateMs: options.rotateMs } : {}) });
  const events = [];
  worker.on("message", event => events.push(event));
  t.after(async () => {
    worker.kill();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  if (options.begin !== false) worker.postMessage({ type: "begin", streamId: "r", ephemeral: options.meeting !== true, diarize: options.meeting === true });
  return { worker, requests, events, resolveConnection };
}

async function backgroundFixture(t) {
  const transport = await fixture(t, { begin: false, holdSpeakers: true });
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lw-background-speakers-"));
  const held = new Set();
  const events = [];
  const service = new RecorderService({ userDataDir, resolveCloudConnection: transport.resolveConnection,
    powerSessions: { acquire: key => held.add(key), release: key => held.delete(key) } });
  service.broadcast = event => events.push(event);
  t.after(async () => { service.dispose(); await Promise.all(service.speakerJobs.values()); await fsp.rm(userDataDir, { recursive: true, force: true }); });
  const modelId = "gemini-transcribe-live-eu";
  await service.startTranscriber({ modelId, language: "de" });
  return { ...transport, service, userDataDir, held, events, modelId };
}

test("Stop saves immediately; an older speaker job survives model changes and cannot alter the next recording", { timeout: 5000 }, async t => {
  const { service, requests, userDataDir, held, events, modelId } = await backgroundFixture(t);
  const first = await service.startRecording({ modelId, sources: ["microphone", "system"], separateSources: true });
  await service.startLiveTranscript(userDataDir);
  for (const source of first.sources) service.feedPcm(first.id, new Float32Array(48000).fill(.1).buffer, source);
  const saved = await service.stopRecording(first.id);
  assert.equal(saved.speakerProcessing, true);
  assert.equal(saved.status, "complete");
  assert.equal(service.activeRecordings.size, 0);
  assert.deepEqual([...held], [`speakers:${first.id}`]);
  const job = service.speakerJobs.get(first.id);
  await until(() => requests.filter(request => request.request.url.includes("/diarize") && request.frames.length).length === 2);
  assert.ok((await service.getRecording(first.id)).segments.every(segment => segment.speaker === null));
  await service.renameRecording(first.id, "Renamed while processing");
  await service.setRecordingProject(first.id, "project-one", true);
  await assert.rejects(service.editTranscript(first.id, { type: "add-speaker", name: "Test" }), /speaker detection/);

  const nextModel = "gemini-transcribe-live-us";
  await service.startTranscriber({ modelId: nextModel, language: "en" });
  const second = await service.startRecording({ modelId: nextModel });
  await service.startLiveTranscript(userDataDir);
  service.handleWorkerMessage({ type: "segment", streamId: second.id, id: "next", text: "Next recording stays live.", startMs: 0, endMs: 1000 });
  await service.writeLiveTranscript();
  for (const request of requests.filter(request => request.request.url.includes("/diarize"))) {
    request.socket.send(JSON.stringify({ type: "speakers", words: [{ text: "70.388,50 Euro.", startMs: 0, endMs: 2000, speaker: "person" }] }));
  }
  await job;
  const completed = await service.getRecording(first.id);
  assert.equal(completed.meta.speakerProcessing, false);
  assert.equal(completed.meta.speakerCount, 2);
  assert.equal(completed.meta.title, "Renamed while processing");
  assert.deepEqual(completed.meta.projectIds, ["project-one"]);
  assert.ok(events.some(event => event.type === "recording-updated" && event.meta.id === first.id));
  assert.equal(service.activeRecordings.get(second.id).meta.status, "recording");
  assert.deepEqual((await service.getRecording(second.id)).segments.map(segment => segment.speaker), [null]);
  assert.deepEqual([...held], [`recording:${second.id}`]);
  const mirror = await fsp.readFile(path.join(userDataDir, RecorderService.LIVE_TRANSCRIPT_FILE), "utf8");
  assert.match(mirror, /Next recording stays live/);
  assert.doesNotMatch(mirror, /70.388/);
  await fsp.rm(path.join(first.folderPath, "transcript.json"));
  assert.deepEqual((await service.getRecording(first.id)).segments, completed.segments, "journal recovery preserves final speaker changes");
  await service.cancelRecording(second.id);
});

test("deleting a recording cancels its blocked speaker request without resurrecting its files", { timeout: 5000 }, async t => {
  const { service, requests, held, events, modelId } = await backgroundFixture(t);
  const first = await service.startRecording({ modelId });
  service.feedPcm(first.id, new Float32Array(48000).fill(.1).buffer);
  await service.stopRecording(first.id);
  await until(() => requests.some(request => request.request.url.includes("/diarize") && request.frames.length));
  await service.deleteRecording(first.id);
  assert.equal(await service.getRecording(first.id), null);
  assert.equal(service.speakerJobs.size, 0);
  assert.equal(service.recordingInputs.size, 0);
  assert.equal(held.size, 0);
  assert.equal(events.some(event => event.type === "recording-updated"), false);
});

test("a background provider failure keeps the saved transcript and clears processing", { timeout: 5000 }, async t => {
  const { service, requests, held, modelId } = await backgroundFixture(t);
  const first = await service.startRecording({ modelId });
  service.feedPcm(first.id, new Float32Array(48000).fill(.1).buffer);
  await service.stopRecording(first.id);
  const job = service.speakerJobs.get(first.id);
  await until(() => requests.some(request => request.request.url.includes("/diarize") && request.frames.length));
  requests.find(request => request.request.url.includes("/diarize")).socket.send(JSON.stringify({ type: "error", error: "Unavailable" }));
  await job;
  const detail = await service.getRecording(first.id);
  assert.equal(detail.meta.status, "complete");
  assert.equal(detail.meta.speakerProcessing, false);
  assert.ok(detail.meta.speakerError);
  assert.equal(detail.segments[0].text, "70.388,50 Euro.");
  assert.equal(held.size, 0);
});

test("shutdown cancels background work and a restart clears the interrupted processing indicator", { timeout: 5000 }, async t => {
  const { service, userDataDir, held, modelId } = await backgroundFixture(t);
  const first = await service.startRecording({ modelId });
  service.feedPcm(first.id, new Float32Array(48000).fill(.1).buffer);
  await service.stopRecording(first.id);
  const job = service.speakerJobs.get(first.id);
  service.dispose();
  await job;
  const reopened = new RecorderService({ userDataDir });
  t.after(() => reopened.dispose());
  const [saved] = await reopened.listRecordings();
  assert.equal(saved.speakerProcessing, false);
  assert.match(saved.speakerError, /interrupted/);
  assert.equal((await reopened.getRecording(first.id)).segments.length, 1);
  assert.equal(held.size, 0);
});

test("PCM conversion keeps the sample count and gain; clips non-finite input safely", () => {
  const buffer = pcm16(new Float32Array([-1, -.5, 0, .5, 1, NaN, 2]).buffer);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => buffer.readInt16LE(i * 2)), [-32768, -16384, 0, 16384, 32767, 0, 32767]);
});

test("silent dictation finishes locally without resolving a cloud connection", async t => {
  let connections = 0;
  const worker = new CloudTranscriber({ modelId: "gemini-transcribe-live-eu", language: "de",
    createSpeechDetector: () => ({ accept: () => false, finish: () => false }),
    resolveConnection: async () => { connections += 1; throw new Error("Silence must stay local"); },
  });
  t.after(() => worker.kill());
  const events = [];
  worker.on("message", event => events.push(event));
  worker.postMessage({ type: "begin", streamId: "silent", ephemeral: true });
  for (let i = 0; i < 60; i++) worker.postMessage({ type: "pcm", streamId: "silent", buffer: new Float32Array(16000).buffer });
  const queued = worker.streams.get("silent")?.queuedBytes;
  worker.postMessage({ type: "finalize", streamId: "silent" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections, 0);
  assert.ok(queued <= 16000 * 2 * 2, "leading silence uses a bounded two-second buffer");
  assert.deepEqual(events, [{ type: "finalized", streamId: "silent" }]);
  assert.equal(worker.streams.size, 0);
});

test("local speech detection opens the cloud with the complete buffered onset and quiet PCM", async t => {
  let chunks = 0;
  const { worker, requests, events } = await fixture(t, {
    createSpeechDetector: () => ({ accept: () => ++chunks === 2, finish: () => true }),
  });
  const onset = new Float32Array(4096).fill(.0001);
  const tail = new Float32Array(4096).fill(.0002);
  worker.postMessage({ type: "pcm", streamId: "r", buffer: onset.buffer });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 0);
  worker.postMessage({ type: "pcm", streamId: "r", buffer: tail.buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  assert.deepEqual(Buffer.concat(requests[0].frames), pcm16(new Float32Array([...onset, ...tail]).buffer));
  assert.equal(events.find(event => event.type === "segment").text, "70.388,50 Euro.");
});

test("speech detected in the final local frame still sends the recording", async t => {
  const { worker, requests, events } = await fixture(t, {
    createSpeechDetector: () => ({ accept: () => false, finish: () => true }),
  });
  const samples = new Float32Array(100).fill(.0001);
  worker.postMessage({ type: "pcm", streamId: "r", buffer: samples.buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  assert.deepEqual(Buffer.concat(requests[0].frames), pcm16(samples.buffer));
  assert.ok(events.some(event => event.type === "segment"));
});

test("real local detection finishes silent PCM without opening the cloud", async t => {
  const { worker, requests, events } = await fixture(t, { createSpeechDetector: createDictationSpeechDetector });
  worker.postMessage({ type: "pcm", streamId: "r", buffer: new Float32Array(16000).buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  assert.deepEqual(events, [{ type: "finalized", streamId: "r" }]);
  assert.deepEqual(requests, []);
});

test("cancelling local silence frees the session and permits the next dictation immediately", async t => {
  let chunks = 0;
  const { worker, requests, events } = await fixture(t, {
    createSpeechDetector: () => ({ accept: () => ++chunks === 2, finish: () => false }),
  });
  worker.postMessage({ type: "pcm", streamId: "r", buffer: new Float32Array(4096).buffer });
  worker.postMessage({ type: "drop", streamId: "r" });
  assert.equal(worker.streams.size, 0);
  worker.postMessage({ type: "begin", streamId: "next", ephemeral: true });
  const samples = new Float32Array(4096).fill(.1);
  worker.postMessage({ type: "pcm", streamId: "next", buffer: samples.buffer });
  worker.postMessage({ type: "finalize", streamId: "next" });
  await until(() => events.some(event => event.type === "finalized" && event.streamId === "next"));
  assert.deepEqual(Buffer.concat(requests[0].frames), pcm16(samples.buffer));
  assert.equal(events.some(event => event.streamId === "r"), false);
});

test("a failed local detector preserves the audio and uses cloud transcription", async t => {
  const { worker, requests, events } = await fixture(t, {
    createSpeechDetector: () => ({ accept: () => { throw new Error("Detector unavailable"); }, finish: () => false }),
  });
  const samples = new Float32Array(4096).fill(.001);
  worker.postMessage({ type: "pcm", streamId: "r", buffer: samples.buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  assert.deepEqual(Buffer.concat(requests[0].frames), pcm16(samples.buffer));
  assert.ok(events.some(event => event.type === "segment"));
});

test("an empty dictation finishes without waiting for connection setup or opening a late socket", async t => {
  const connection = new EventEmitter();
  let sockets = 0;
  const worker = new CloudTranscriber({ modelId: "gemini-transcribe-live-eu", language: "de",
    resolveConnection: () => once(connection, "ready").then(([value]) => value),
    socketFactory: () => { sockets += 1; throw new Error("An empty dictation must not open a socket"); },
  });
  t.after(() => worker.kill());
  const events = [];
  worker.on("message", event => events.push(event));
  worker.postMessage({ type: "begin", streamId: "empty", ephemeral: true });
  worker.postMessage({ type: "finalize", streamId: "empty" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "finalized", streamId: "empty" }]);
  assert.equal(worker.streams.size, 0);
  connection.emit("ready", { url: "ws://127.0.0.1/unused", apiKey: "fixture-key" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets, 0);
});

test("quiet nonempty dictation still sends all audio and waits for its final transcript", async t => {
  const { worker, requests, events } = await fixture(t, { readyDelay: 40 });
  const samples = new Float32Array(1600).fill(.0001);
  worker.postMessage({ type: "pcm", streamId: "r", buffer: samples.buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  assert.equal(events.some(event => event.type === "finalized"), false);
  await until(() => events.some(event => event.type === "finalized"));
  assert.deepEqual(Buffer.concat(requests[0].frames), pcm16(samples.buffer));
  assert.equal(events.find(event => event.type === "segment").text, "70.388,50 Euro.");
});

test("an empty dictation on an already ready socket finishes without requesting transcription", async t => {
  const { worker, requests, events } = await fixture(t);
  await until(() => worker.streams.get("r")?.ready);
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  assert.deepEqual(requests[0].commands, []);
  assert.deepEqual(events, [{ type: "finalized", streamId: "r" }]);
  assert.equal(worker.streams.size, 0);
});

test("buffers opening audio and release, sends the tail, and uses the subscription key only in headers", async t => {
  const { worker, requests, events } = await fixture(t, { readyDelay: 40 });
  const samples = new Float32Array(17000).fill(.25);
  worker.postMessage({ type: "pcm", streamId: "r", buffer: samples.buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  assert.deepEqual(Buffer.concat(requests[0].frames), pcm16(samples.buffer));
  assert.equal(requests[0].request.headers.authorization, "Bearer fixture-subscription-key");
  assert.equal(requests[0].request.url.includes("fixture-subscription-key"), false);
  assert.match(requests[0].request.url, /language=de/);
  assert.deepEqual(requests[0].commands, [{ type: "finish" }]);
  assert.equal(events.find(event => event.type === "segment").text, "70.388,50 Euro.");
});

test("renews a long session without losing or replaying PCM and preserves the recording offset", async t => {
  const { worker, requests, events } = await fixture(t, { rotateMs: 70 });
  worker.postMessage({ type: "pcm", streamId: "r", buffer: new Float32Array(1600).fill(.1).buffer });
  await until(() => requests.length === 2);
  worker.postMessage({ type: "pcm", streamId: "r", buffer: new Float32Array(3200).fill(.2).buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  assert.equal(requests.flatMap(request => request.frames).reduce((sum, frame) => sum + frame.length, 0), 9600);
  assert.match(requests[1].request.url, /offsetMs=100/);
});

test("an upstream disconnect reports an error without starting a local fallback", async t => {
  const { worker, requests, events } = await fixture(t);
  await until(() => requests.length === 1);
  requests[0].socket.close(1011);
  await until(() => events.some(event => event.type === "stream-error"));
  assert.equal(worker.streams.size, 0);
  assert.equal(requests.length, 1);
});


test("meeting captions stay live but speaker requests start only after Stop and final text", async t => {
  const { worker, requests, events } = await fixture(t, { meeting: true });
  worker.postMessage({ type: "pcm", streamId: "r", buffer: new Float32Array(400000).fill(.1).buffer });
  await until(() => requests[0]?.frames.length === 25);
  requests[0].socket.send(JSON.stringify({ type: "partial", text: "Live words", startMs: 0, endMs: 200 }));
  await until(() => events.some(event => event.type === "partial"));
  assert.equal(requests.length, 1, "no speaker request during capture, even after the old twenty-second interval");
  assert.equal(events.some(event => event.type === "speaker-turns"), false);
  assert.equal(events.find(event => event.type === "partial").speaker, null);
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  const speakerRequest = requests.find(request => request.request.url.includes("/diarize"));
  assert.ok(speakerRequest);
  assert.equal(speakerRequest.request.headers.authorization, "Bearer fixture-subscription-key");
  assert.equal(speakerRequest.frames[0].length, 800000);
  assert.equal(events.find(event => event.type === "speaker-turns").turns[0].speaker, 0);
  assert.ok(events.findIndex(event => event.type === "speaker-turns") < events.findIndex(event => event.type === "finalized"));
  assert.ok(events.findIndex(event => event.type === "segment") < events.findIndex(event => event.type === "speaker-turns"));
});

test("speaker endpoint failure warns while live text and finalization still succeed", async t => {
  const { worker, events } = await fixture(t, { meeting: true, speakerFailure: true });
  worker.postMessage({ type: "pcm", streamId: "r", buffer: new Float32Array(48000).fill(.1).buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  await until(() => events.some(event => event.type === "finalized"));
  assert.ok(events.some(event => event.type === "diarize-error"));
  assert.ok(events.some(event => event.type === "segment"));
  assert.equal(events.some(event => event.type === "stream-error"), false);
});
