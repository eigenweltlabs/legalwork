import { test } from "node:test";
import assert from "node:assert/strict";
import grpc from "@grpc/grpc-js";
import { CloudTranscriber } from "./audio/cloud-transcriber.mjs";
import { GrpcSpeechSocket, isGrpcSpeechUrl } from "./audio/grpc-speech-socket.mjs";

const identity = value => value;
const text = value => Buffer.concat([Buffer.of(1), Buffer.from(JSON.stringify(value))]);
const close = (code, reason = "") => Buffer.concat([Buffer.of(3), Buffer.from(JSON.stringify({ code, reason }))]);
const accepted = () => { const metadata = new grpc.Metadata(); metadata.set("x-eigenwelt-speech", "accepted"); return metadata; };
const method = name => ({ path: `/eigenwelt.speech.v1.Speech/${name}`, requestStream: true, responseStream: true,
  requestSerialize: identity, requestDeserialize: identity, responseSerialize: identity, responseDeserialize: identity });

/** The gateway's wire contract (model-api gemini_transcription/grpc_service.py). */
async function gateway(t, handlers) {
  const server = new grpc.Server();
  const calls = [];
  const wrap = handler => call => {
    const state = { call, frames: [], cancelled: false, metadata: call.metadata.getMap() };
    calls.push(state);
    call.on("cancelled", () => { state.cancelled = true; });
    call.on("data", frame => state.frames.push(frame));
    handler(call, state);
  };
  server.addService({ Live: method("Live"), Diarize: method("Diarize") },
    { Live: wrap(handlers.live ?? (() => {})), Diarize: wrap(handlers.diarize ?? (() => {})) });
  const port = await new Promise((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(),
    (error, bound) => error ? reject(error) : resolve(bound)));
  t.after(() => server.forceShutdown());
  return { calls, url: path => `grpc://127.0.0.1:${port}/v1/transcription/${path}?model=gemini-transcribe-live-eu` };
}

function record(socket) {
  const events = [];
  socket.on("open", () => events.push(["open"]));
  socket.on("message", (raw, binary) => events.push(["message", JSON.parse(String(raw)), binary]));
  socket.on("error", error => events.push(["error", error.message]));
  return { events, closed: new Promise(resolve => socket.on("close", (code, reason) => { events.push(["close", code, String(reason)]); resolve(); })) };
}

function live(call, state) {
  call.sendMetadata(accepted());
  call.write(text({ type: "ready" }));
  call.on("data", frame => {
    if (frame[0] === 1 && JSON.parse(frame.subarray(1)).type === "finish") {
      call.write(text({ type: "segment", text: "70.388,50 Euro.", startMs: 0, endMs: 200, id: "s" }));
      call.write(text({ type: "done" }));
      call.write(close(1000));
      call.end();
    }
  });
}

test("live speech carries WebSocket frames, the subscription key and settings over gRPC", { timeout: 5000 }, async t => {
  const server = await gateway(t, { live });
  const socket = new GrpcSpeechSocket(server.url("live") + "&language=de&mode=dictation&offsetMs=1200", { headers: { Authorization: "Bearer fixture-key" } });
  const { events, closed } = record(socket);
  await new Promise(resolve => socket.once("open", resolve));
  socket.send(Buffer.from([1, 0, 2, 0]));
  socket.send(JSON.stringify({ type: "finish" }));
  await closed;
  assert.deepEqual(events, [["open"], ["message", { type: "ready" }, false],
    ["message", { type: "segment", text: "70.388,50 Euro.", startMs: 0, endMs: 200, id: "s" }, false],
    ["message", { type: "done" }, false], ["close", 1000, ""]]);
  const [call] = server.calls;
  assert.equal(call.metadata.authorization, "Bearer fixture-key");
  assert.equal(call.metadata["x-eigenwelt-speech-query"], "model=gemini-transcribe-live-eu&language=de&mode=dictation&offsetMs=1200");
  assert.deepEqual(call.frames, [Buffer.from([2, 1, 0, 2, 0]), Buffer.from([1, ...Buffer.from('{"type":"finish"}')])]);
  assert.equal(socket.readyState, GrpcSpeechSocket.CLOSED);
  assert.equal(socket.bufferedAmount, 0);
});

test("a rejection before the handshake reports 403 and its policy close code, like ws", { timeout: 5000 }, async t => {
  const server = await gateway(t, { live: call => { call.write(close(1008, "Cloud transcription is unavailable")); call.end(); } });
  const { events, closed } = record(new GrpcSpeechSocket(server.url("live"), { headers: { Authorization: "Bearer invalid" } }));
  await closed;
  assert.deepEqual(events, [["error", "Unexpected server response: 403"], ["close", 1008, "Cloud transcription is unavailable"]]);
});

test("the speaker method sends one bounded request after the handshake", { timeout: 5000 }, async t => {
  const server = await gateway(t, { diarize: (call, state) => {
    call.sendMetadata(accepted());
    call.on("data", () => { call.write(text({ type: "speakers", words: [] })); call.write(close(1000)); call.end(); });
  } });
  const socket = new GrpcSpeechSocket(server.url("diarize").replace("model=", "language=de&model="), {});
  const { events, closed } = record(socket);
  socket.on("open", () => socket.send(Buffer.alloc(32000)));
  await closed;
  assert.deepEqual(events, [["open"], ["message", { type: "speakers", words: [] }, false], ["close", 1000, ""]]);
  assert.equal(server.calls[0].frames[0].length, 32001);
});

test("closing cancels the call once without an error; server failures and stalls are errors", { timeout: 5000 }, async t => {
  const server = await gateway(t, { live, diarize: call => call.emit("error", { code: grpc.status.UNAVAILABLE, details: "upstream" }) });
  const socket = new GrpcSpeechSocket(server.url("live"), {});
  const open = record(socket);
  await new Promise(resolve => socket.once("open", resolve));
  socket.close();
  socket.terminate();
  await open.closed;
  assert.deepEqual(open.events.filter(([type]) => type !== "message"), [["open"], ["close", 1005, ""]]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(server.calls[0].cancelled, true);

  const failed = record(new GrpcSpeechSocket(server.url("diarize"), {}));
  await failed.closed;
  assert.deepEqual(failed.events, [["error", "Cloud speech connection failed"], ["close", 1006, ""]]);

  const stalled = await gateway(t, { live: () => {} });
  const timeout = record(new GrpcSpeechSocket(stalled.url("live"), { handshakeTimeout: 50 }));
  await timeout.closed;
  assert.deepEqual(timeout.events, [["error", "Opening handshake has timed out"], ["close", 1006, ""]]);
});

test("only gRPC speech addresses are accepted, and plaintext only on loopback", () => {
  assert.equal(isGrpcSpeechUrl("grpcs://eu.platform.eigenweltlabs.com/v1/transcription/live"), true);
  assert.equal(isGrpcSpeechUrl("wss://eu.platform.eigenweltlabs.com/v1/transcription/live"), false);
  for (const address of ["grpc://example.com/v1/transcription/live", "grpcs://example.com/v1/chat/completions",
    "grpcs://user:secret@example.com/v1/transcription/live"]) {
    assert.throws(() => new GrpcSpeechSocket(address, {}), /cloud speech/i);
  }
});

test("CloudTranscriber dictates over gRPC when the connection is a gRPC address", { timeout: 5000 }, async t => {
  const server = await gateway(t, { live });
  const worker = new CloudTranscriber({ modelId: "gemini-transcribe-live-eu", language: "de", createSpeechDetector: null,
    resolveConnection: async () => ({ url: server.url("live"), apiKey: "fixture-subscription-key" }) });
  t.after(() => worker.kill());
  const events = [];
  const finalized = new Promise(resolve => worker.on("message", event => { events.push(event); if (event.type === "finalized") resolve(); }));
  worker.postMessage({ type: "begin", streamId: "r", ephemeral: true });
  worker.postMessage({ type: "pcm", streamId: "r", buffer: new Float32Array(1600).fill(.25).buffer });
  worker.postMessage({ type: "finalize", streamId: "r" });
  await finalized;
  assert.deepEqual(events.map(event => event.type), ["segment", "finalized"]);
  assert.equal(events[0].text, "70.388,50 Euro.");
  const [call] = server.calls;
  assert.equal(call.metadata.authorization, "Bearer fixture-subscription-key");
  assert.match(call.metadata["x-eigenwelt-speech-query"], /^model=gemini-transcribe-live-eu&language=de&mode=dictation&offsetMs=0$/);
  assert.deepEqual(call.frames.map(frame => frame[0]), [2, 1]);
  assert.equal(call.frames[0].length, 1 + 1600 * 2);
});
