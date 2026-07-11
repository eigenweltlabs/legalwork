import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import { AUDIO_MODEL_CATALOG, VAD_MODEL, findAudioModel } from "./audio/model-catalog.mjs";
import { AudioModelManager } from "./audio/model-manager.mjs";
import { RecorderService } from "./audio/recorder-service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ── catalog ────────────────────────────────────────────────────────────────

test("model catalog entries are well formed", () => {
  assert.ok(AUDIO_MODEL_CATALOG.length >= 4);
  const ids = new Set();
  for (const entry of AUDIO_MODEL_CATALOG) {
    assert.ok(!ids.has(entry.id), `duplicate model id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.approxSizeBytes > 0);
    assert.ok(["whisper", "nemo-transducer"].includes(entry.kind));
    assert.ok(entry.files.length >= 3, `${entry.id} needs model files`);
    for (const file of entry.files) {
      assert.match(file.url, /^https:\/\/huggingface\.co\/.+\/resolve\/main\/.+/);
      assert.ok(file.name.length > 0);
    }
    assert.ok(entry.files.some((file) => file.name === "tokens.txt"));
    if (entry.kind === "whisper") {
      assert.ok(entry.files.some((file) => file.name === "encoder.int8.onnx"));
      assert.ok(entry.files.some((file) => file.name === "decoder.int8.onnx"));
    } else {
      assert.ok(entry.files.some((file) => file.name === "joiner.int8.onnx"));
    }
  }
  // German + English coverage: every catalog model must be multilingual.
  assert.ok(AUDIO_MODEL_CATALOG.every((entry) => entry.languages === "multilingual"));
  // A resource-light and a top-quality option must both exist.
  assert.ok(AUDIO_MODEL_CATALOG.some((entry) => entry.tier === "fastest"));
  assert.ok(AUDIO_MODEL_CATALOG.some((entry) => entry.tier === "best"));
  assert.match(VAD_MODEL.url, /^https:\/\/huggingface\.co\/.+silero_vad\.onnx$/);
  assert.equal(findAudioModel("parakeet-tdt-0.6b-v3")?.kind, "nemo-transducer");
  assert.equal(findAudioModel("nope"), null);
});

// ── model manager ──────────────────────────────────────────────────────────

test("model manager reports install state from files + marker", async () => {
  const dir = await tempDir("lw-models-");
  const manager = new AudioModelManager({ modelsDir: dir, emitEvent: () => {} });

  const states = manager.listModelStates();
  assert.equal(states.length, AUDIO_MODEL_CATALOG.length);
  assert.ok(states.every((state) => state.state === "not-installed"));

  // Fake a completed install for whisper-tiny.
  const entry = findAudioModel("whisper-tiny");
  const modelDir = manager.modelDir(entry.id);
  await fsp.mkdir(modelDir, { recursive: true });
  for (const file of entry.files) {
    await fsp.writeFile(path.join(modelDir, file.name), "fake-model-bytes");
  }
  assert.equal(manager.isModelInstalled(entry.id), false, "no marker yet");
  await fsp.writeFile(path.join(modelDir, ".complete"), "1");
  assert.equal(manager.isModelInstalled(entry.id), true);

  const paths = manager.installedModelPaths(entry.id);
  assert.ok(paths["encoder.int8.onnx"].endsWith("encoder.int8.onnx"));
  assert.ok(manager.installedSizeBytes(entry.id) > 0);

  const installedState = manager.listModelStates().find((state) => state.id === entry.id);
  assert.equal(installedState.state, "installed");

  await manager.delete(entry.id);
  assert.equal(manager.isModelInstalled(entry.id), false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test("model manager imports a model folder with prefixed file names", async () => {
  const dir = await tempDir("lw-models-");
  const manager = new AudioModelManager({ modelsDir: dir, emitEvent: () => {} });

  // Simulate an extracted sherpa-onnx-whisper-tiny folder (prefixed names).
  const sourceDir = await tempDir("lw-import-");
  for (const name of ["tiny-encoder.int8.onnx", "tiny-decoder.int8.onnx", "tiny-tokens.txt"]) {
    await fsp.writeFile(path.join(sourceDir, name), "model-bytes");
  }
  await fsp.writeFile(path.join(sourceDir, "silero_vad.onnx"), "vad-bytes");

  const result = await manager.importFromFolder(sourceDir);
  assert.equal(result.ok, true);
  assert.equal(result.modelId, "whisper-tiny");
  assert.equal(manager.isModelInstalled("whisper-tiny"), true);
  assert.equal(manager.isVadInstalled(), true, "silero_vad.onnx rides along");

  // Unrecognizable folders produce a helpful error, not a crash.
  const junkDir = await tempDir("lw-junk-");
  await fsp.writeFile(path.join(junkDir, "ggml-tiny.bin"), "ggml");
  const failed = await manager.importFromFolder(junkDir);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /sherpa-onnx/);

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(sourceDir, { recursive: true, force: true });
  await fsp.rm(junkDir, { recursive: true, force: true });
});

test("scanExistingModels skips installed models and tolerates missing caches", async () => {
  const dir = await tempDir("lw-models-");
  const manager = new AudioModelManager({ modelsDir: dir, emitEvent: () => {} });
  const results = manager.scanExistingModels();
  assert.ok(Array.isArray(results));
  await fsp.rm(dir, { recursive: true, force: true });
});

// ── recorder service with a mocked worker ──────────────────────────────────

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === "load") {
      queueMicrotask(() => this.emit("message", { type: "ready" }));
    }
    if (message.type === "pcm") {
      queueMicrotask(() =>
        this.emit("message", {
          type: "segment",
          streamId: message.streamId,
          id: `seg-${this.messages.length}`,
          text: "Guten Tag, das ist ein Test.",
          startMs: 0,
          endMs: 1200,
        }),
      );
    }
    if (message.type === "finalize") {
      queueMicrotask(() => this.emit("message", { type: "finalized", streamId: message.streamId }));
    }
  }

  kill() {}
}

async function installFakeModel(service, modelId) {
  const entry = findAudioModel(modelId);
  const modelDir = service.modelManager.modelDir(modelId);
  await fsp.mkdir(modelDir, { recursive: true });
  for (const file of entry.files) {
    await fsp.writeFile(path.join(modelDir, file.name), "x");
  }
  await fsp.writeFile(path.join(modelDir, ".complete"), "1");
  await fsp.mkdir(path.dirname(service.modelManager.vadModelPath()), { recursive: true });
  await fsp.writeFile(service.modelManager.vadModelPath(), "x");
}

test("recorder service records, transcribes, finalizes files", async () => {
  const userDataDir = await tempDir("lw-recorder-");
  const fakeWorker = new FakeWorker();
  const events = [];
  const service = new RecorderService({
    userDataDir,
    forkWorker: () => fakeWorker,
  });
  service.broadcast = (event) => events.push(event);

  await installFakeModel(service, "whisper-tiny");

  const bootstrap = service.bootstrap();
  assert.equal(bootstrap.models.find((m) => m.id === "whisper-tiny").state, "installed");
  assert.equal(bootstrap.capabilities.systemAudio, true);

  const status = await service.startTranscriber({ modelId: "whisper-tiny", language: "de" });
  assert.equal(status.state, "loading");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.transcriberStatus.state, "ready");
  assert.equal(fakeWorker.messages[0].type, "load");
  assert.equal(fakeWorker.messages[0].language, "de");

  const meta = await service.startRecording({
    title: "Mandanten-Gespräch",
    language: "de",
    modelId: "whisper-tiny",
    sources: ["microphone", "system"],
  });
  assert.equal(meta.status, "recording");
  assert.ok(fs.existsSync(meta.folderPath));

  // Stream audio + PCM like the renderer does.
  service.appendMediaChunk(meta.id, new TextEncoder().encode("webm-bytes").buffer);
  service.feedPcm(meta.id, new Float32Array(1600).buffer);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const done = await service.stopRecording(meta.id);
  assert.equal(done.status, "complete");
  assert.equal(done.segmentCount, 1);
  assert.ok(done.sizeBytes > 0);

  const transcript = JSON.parse(await fsp.readFile(path.join(done.folderPath, "transcript.json"), "utf8"));
  assert.equal(transcript.segments.length, 1);
  assert.match(transcript.segments[0].text, /Guten Tag/);
  const srt = await fsp.readFile(path.join(done.folderPath, "transcript.srt"), "utf8");
  assert.match(srt, /00:00:00,000 --> 00:00:01,200/);
  const md = await fsp.readFile(path.join(done.folderPath, "transcript.md"), "utf8");
  assert.match(md, /# Mandanten-Gespräch/);
  assert.match(md, /local, on-device/);

  // Listing + detail round-trip.
  const listed = await service.listRecordings();
  assert.equal(listed.length, 1);
  const detail = await service.getRecording(meta.id);
  assert.equal(detail.segments.length, 1);

  // Save into a workspace folder for session/agent access.
  const workspaceDir = await tempDir("lw-workspace-");
  const saved = await service.saveToWorkspace(meta.id, workspaceDir);
  assert.equal(saved.ok, true);
  assert.ok(fs.existsSync(path.join(saved.folderPath, "transcript.md")));
  assert.ok(fs.existsSync(path.join(saved.folderPath, "audio.webm")));

  // Live transcript events were broadcast.
  assert.ok(events.some((event) => event.type === "transcript-segment"));

  const remaining = await service.deleteRecording(meta.id);
  assert.equal(remaining.length, 0);

  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
  await fsp.rm(workspaceDir, { recursive: true, force: true });
});

test("recorder service surfaces missing model as error", async () => {
  const userDataDir = await tempDir("lw-recorder-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  service.broadcast = () => {};
  const status = await service.startTranscriber({ modelId: "whisper-tiny", language: "auto" });
  assert.equal(status.state, "error");
  assert.match(status.error, /not installed/);
  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
});

test("ephemeral dictations never appear in recording history and are cleaned up", async () => {
  const userDataDir = await tempDir("lw-recorder-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  service.broadcast = () => {};
  const meta = await service.startRecording({
    title: "System dictation",
    language: "en",
    modelId: null,
    sources: ["microphone"],
    ephemeral: true,
  });
  assert.equal((await service.listRecordings()).length, 0);
  await service.stopRecording(meta.id);
  assert.equal((await service.listRecordings()).length, 0);
  assert.equal(fs.existsSync(meta.folderPath), false);
  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
});

test("live transcript bridge tracks normal recordings but ignores dictation", async () => {
  const userDataDir = await tempDir("lw-recorder-");
  const workspaceDir = await tempDir("lw-workspace-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  service.broadcast = () => {};

  const dictation = await service.startRecording({
    title: "System dictation",
    language: "en",
    modelId: null,
    sources: ["microphone"],
    ephemeral: true,
  });
  assert.equal(service.liveTranscriptStatus(workspaceDir).recordingActive, false);
  assert.match(service.setLiveTranscript(true, workspaceDir).error, /No recording/);
  await service.cancelRecording(dictation.id);

  const recording = await service.startRecording({
    title: "Client call",
    language: "en",
    modelId: null,
    sources: ["microphone"],
  });
  assert.equal(service.liveTranscriptStatus(workspaceDir).recordingActive, true);
  const started = service.setLiveTranscript(true, workspaceDir);
  assert.equal(started.liveTranscriptActive, true);
  assert.equal(started.fileName, RecorderService.LIVE_TRANSCRIPT_FILE);
  await service.liveTranscriptWriteQueue;
  assert.equal(fs.existsSync(path.join(workspaceDir, RecorderService.LIVE_TRANSCRIPT_FILE)), true);
  assert.equal(service.setLiveTranscript(false, workspaceDir).liveTranscriptActive, false);

  service.setLiveTranscript(true, workspaceDir);
  await service.cancelRecording(recording.id);
  assert.equal(service.liveTranscriptStatus(workspaceDir).liveTranscriptActive, false);
  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
  await fsp.rm(workspaceDir, { recursive: true, force: true });
});

// ── real worker + real Silero VAD end-to-end ────────────────────────────────
// Exercises the full worker pipeline (windowed VAD feeding, speech
// segmentation, partials, finalize) with the actual sherpa-onnx native
// engine and a real Silero model; only the ASR decode is canned
// (LEGALWORK_TRANSCRIBER_FAKE_ASR) since model weights are gigabytes.

const SAMPLE_RATE = 16000;

/** Speech-like signal: harmonic pulse train + syllable-rate AM. */
function synthSpeech(durationSec) {
  const n = Math.floor(durationSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  const partials = [
    [1, 0.6], [2, 0.8], [3, 1.0], [4, 0.9], [5, 0.8], [6, 0.7], [8, 0.5], [10, 0.35],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;
    for (const [h, w] of partials) {
      sample += w * Math.sin(2 * Math.PI * 120 * h * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * t)) * t);
    }
    out[i] = (0.25 * (0.55 + 0.45 * Math.sin(2 * Math.PI * 3.5 * t)) * sample) / 8;
  }
  return out;
}

test("worker segments real audio with the real Silero VAD (fake ASR)", async () => {
  const vadPath = path.join(
    __dirname,
    "..",
    "node_modules",
    "@ricky0123",
    "vad-web",
    "dist",
    "silero_vad_legacy.onnx",
  );
  assert.ok(fs.existsSync(vadPath), "silero model devDependency present");

  const workerPath = path.join(__dirname, "audio", "transcription-worker.cjs");
  const child = fork(workerPath, [], {
    stdio: "ignore",
    env: { ...process.env, LEGALWORK_TRANSCRIBER_FAKE_ASR: "1" },
  });
  const received = [];
  child.on("message", (message) => received.push(message));
  const waitFor = (predicate, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = received.find(predicate);
        if (found) return resolve(found);
        if (Date.now() > deadline) return reject(new Error(`timeout; got ${JSON.stringify(received)}`));
        setTimeout(check, 25);
      };
      const deadline = Date.now() + timeoutMs;
      check();
    });

  await waitFor((m) => m.type === "booted");
  child.send({
    type: "load",
    model: { kind: "whisper", files: {} },
    vadPath,
    language: "de",
    numThreads: 1,
  });
  await waitFor((m) => m.type === "ready");

  // 1s silence, 2.4s speech, 1.5s silence — streamed in 4096-sample chunks
  // exactly like the renderer's AudioWorklet batches.
  const audio = new Float32Array(SAMPLE_RATE * 5);
  audio.set(synthSpeech(2.4), SAMPLE_RATE);
  for (let offset = 0; offset < audio.length; offset += 4096) {
    const chunk = audio.slice(offset, Math.min(offset + 4096, audio.length));
    child.send({ type: "pcm", streamId: "e2e", buffer: Array.from(chunk) });
  }
  child.send({ type: "finalize", streamId: "e2e" });

  const segment = await waitFor((m) => m.type === "segment" && m.streamId === "e2e");
  assert.match(segment.text, /decoded \d+ samples/);
  // Speech was placed at 1.0s–3.4s; allow generous VAD hysteresis.
  assert.ok(segment.startMs > 500 && segment.startMs < 1600, `startMs=${segment.startMs}`);
  assert.ok(segment.endMs > 2800 && segment.endMs < 4600, `endMs=${segment.endMs}`);
  await waitFor((m) => m.type === "finalized" && m.streamId === "e2e");

  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
});

// ── real worker process boot (protocol smoke test) ─────────────────────────

test("transcription worker boots in a plain node fork and reports load errors", async () => {
  const workerPath = path.join(__dirname, "audio", "transcription-worker.cjs");
  const child = fork(workerPath, [], { stdio: "ignore" });
  const received = [];
  const waitFor = (type, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      const check = (message) => {
        received.push(message);
        if (message?.type === type) {
          clearTimeout(timer);
          child.off("message", check);
          resolve(message);
        }
      };
      child.on("message", check);
    });

  const booted = waitFor("booted");
  await booted;

  // Loading with bogus paths must fail gracefully (not crash the process).
  const loadError = waitFor("load-error");
  child.send({
    type: "load",
    model: {
      kind: "whisper",
      files: {
        "encoder.int8.onnx": "/nonexistent/encoder.onnx",
        "decoder.int8.onnx": "/nonexistent/decoder.onnx",
        "tokens.txt": "/nonexistent/tokens.txt",
      },
    },
    vadPath: "/nonexistent/silero_vad.onnx",
    language: "en",
    numThreads: 1,
  });
  const error = await loadError;
  assert.ok(typeof error.error === "string" && error.error.length > 0);
  assert.equal(child.exitCode, null, "worker survived the bad load");

  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
});
