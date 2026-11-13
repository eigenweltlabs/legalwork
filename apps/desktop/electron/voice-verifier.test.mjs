import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceVerifier } from "./audio/voice-verifier.cjs";
import { VoiceVerifierClient } from "./audio/voice-verifier.mjs";

function extractor(vectors) {
  return {
    createStream: () => ({ acceptWaveform() {}, inputFinished() {} }),
    isReady: () => true,
    compute: () => vectors.shift(),
  };
}
const audio = Buffer.alloc(8000 * 32);
const turn = (offset, speaker) => [{ startMs: offset, endMs: offset + 8000, speaker }];
class Worker extends EventEmitter {
  postMessage(_message) {}
  kill() {}
}

test("voice identity survives provider label changes and requires independent evidence for a new voice", () => {
  const verifier = new VoiceVerifier(extractor([[1, 0], [1, 0], [0, 1], [0, 1]]));
  assert.equal(verifier.verify(audio, 0, turn(0, 20)).turns[0].speaker, 0);
  assert.equal(verifier.verify(audio, 8000, turn(8000, 99)).turns[0].speaker, 0);
  assert.equal(verifier.verify(audio, 16000, turn(16000, 40)).turns[0].speaker, null);
  const confirmed = verifier.verify(audio, 24000, turn(24000, 72));
  assert.equal(confirmed.turns[0].speaker, 1);
  assert.deepEqual(confirmed.corrections, [{ startMs: 16000, endMs: 24000, speaker: 1 }]);
  assert.deepEqual(verifier.finish(), {}, "distinct voices remain separate");
});

test("repeated overlapping audio cannot confirm a new identity", () => {
  const verifier = new VoiceVerifier(extractor([[1, 0], [0, 1], [0, 1]]));
  verifier.verify(audio, 0, turn(0, 0));
  verifier.verify(audio, 8000, turn(8000, 1));
  assert.equal(verifier.verify(audio, 10000, turn(10000, 2)).turns[0].speaker, null);
  assert.equal(verifier.clusters.voices.length, 1);
});

test("final reconciliation merges similar profiles and retains different voices", () => {
  const verifier = new VoiceVerifier(extractor([]));
  verifier.clusters.voices = [[1, 0, 0], [.6, .8, 0], [0, 0, 1]];
  assert.deepEqual(verifier.finish(), { 1: 0 });
});

test("brief or invalid embeddings cannot enroll a voice", () => {
  const verifier = new VoiceVerifier(extractor([[0, 0], [1, 0]]));
  assert.equal(verifier.verify(audio, 0, turn(0, 1)).turns[0].speaker, null);
  assert.equal(verifier.verify(Buffer.alloc(3000 * 32), 0, [{ startMs: 0, endMs: 3000, speaker: 1 }]).turns[0].speaker, null);
  assert.equal(verifier.clusters.voices.length, 0);
});

test("worker exit rejects a pending voice request and cancellation prevents later requests", async () => {
  const worker = new Worker();
  const client = new VoiceVerifierClient(worker, "embedding.onnx");
  const request = client.verify(audio, 0, turn(0, 1));
  worker.emit("exit");
  await assert.rejects(request, /stopped/);
  await assert.rejects(client.finish(), /unavailable/);
});

test("worker errors propagate and final aliases use the same session", async () => {
  const worker = new Worker();
  worker.postMessage = message => queueMicrotask(() => worker.emit("message",
    message.type === "finish" ? { result: { 1: 0 } } : { error: "invalid model" }));
  const client = new VoiceVerifierClient(worker, "embedding.onnx");
  await assert.rejects(client.verify(audio, 0, turn(0, 1)), /invalid model/);
  assert.deepEqual(await client.finish(), { 1: 0 });
  client.stop();
});
