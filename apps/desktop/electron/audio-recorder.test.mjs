import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LiveSpeakers, SpeakerClusters } from "./audio/live-speakers.cjs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";

import { AUDIO_MODEL_CATALOG, VAD_MODEL, findAudioModel } from "./audio/model-catalog.mjs";
import { AudioModelManager } from "./audio/model-manager.mjs";
import { RecorderService, assignSpeakers } from "./audio/recorder-service.mjs";
import { RecorderRequestError, requestRecorderServer } from "./audio/recorder-server-request.mjs";
import { DeferredCloudSpeakerPass } from "./audio/deferred-cloud-speakers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("worker finalization preserves audio ending between VAD windows", async () => {
  const windows = [];
  const messages = [];
  /** @type {(event: { data: object }) => void} */
  let onMessage = () => assert.fail("worker did not subscribe to messages");
  let flushed = 0;
  class Vad {
    acceptWaveform(samples) { windows.push([...samples]); }
    isDetected() { return false; }
    isEmpty() { return true; }
    flush() { flushed += 1; }
  }
  const source = await fsp.readFile(path.join(__dirname, "audio", "transcription-worker.cjs"), "utf8");
  runInNewContext(source, {
    Float32Array, Buffer, setTimeout,
    require: name => name === "sherpa-onnx-node" ? { Vad } : {},
    process: {
      env: { LEGALWORK_TRANSCRIBER_FAKE_ASR: "1" }, on: () => {},
      parentPort: { postMessage: message => messages.push(message), on: (_event, callback) => { onMessage = callback; } },
    },
  });
  onMessage({ data: { type: "load", vadPath: "test-vad" } });
  assert.ok(messages.some(message => message.type === "ready"));
  for (const count of [1, 511, 512, 5633]) {
    windows.length = 0;
    const input = Float32Array.from({ length: count }, (_, index) => (index + 1) / 16_000);
    for (let offset = 0; offset < count; offset += 4096) {
      onMessage({ data: { type: "pcm", streamId: String(count), buffer: input.slice(offset, offset + 4096).buffer } });
    }
    onMessage({ data: { type: "finalize", streamId: String(count) } });
    await new Promise(resolve => setImmediate(resolve));
    const samples = windows.flat();
    assert.deepEqual(samples.slice(0, count), [...input], `all ${count} real samples are delivered before VAD flush`);
    assert.equal(samples.length, Math.ceil(count / 512) * 512);
    assert.ok(samples.slice(count).every(sample => sample === 0), "only the final window is padded with silence");
    assert.equal(messages.filter(message => message.type === "finalized" && message.streamId === String(count)).length, 1);
  }
  assert.equal(flushed, 4);
});

function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ── catalog ────────────────────────────────────────────────────────────────

test("model catalog entries are well formed", () => {
  // Three lawyer-facing tiers: Basic, Standard, Premium.
  assert.ok(AUDIO_MODEL_CATALOG.length >= 3);
  const ids = new Set();
  for (const entry of AUDIO_MODEL_CATALOG) {
    assert.ok(!ids.has(entry.id), `duplicate model id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.approxSizeBytes > 0);
    assert.ok(["whisper", "nemo-transducer"].includes(entry.kind));
    assert.ok(["free", "premium"].includes(entry.plan), `${entry.id} needs a plan`);
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
  // A resource-light free option and a gated premium option must both exist.
  assert.ok(AUDIO_MODEL_CATALOG.some((entry) => entry.tier === "fastest" && entry.plan === "free"));
  assert.ok(AUDIO_MODEL_CATALOG.some((entry) => entry.plan === "premium"));
  // The heaviest tier is premium AND held back to capable machines.
  assert.ok(
    AUDIO_MODEL_CATALOG.some((entry) => entry.plan === "premium" && entry.requiresFastDevice),
    "a fast-device-gated premium model exists",
  );
  assert.equal(findAudioModel("whisper-large-v3")?.tier, "best");
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

test("cloud readiness opens no connection, cannot capture a local choice, and keeps a failed connection recording until Stop", async t => {
  const userDataDir = await tempDir("lw-cloud-recorder-");
  let connections = 0;
  const service = new RecorderService({ userDataDir, resolveCloudConnection: async () => {
    connections += 1;
    throw new Error("Cloud unavailable");
  } });
  t.after(async () => { service.stopWorker(); await fsp.rm(userDataDir, { recursive: true, force: true }); });
  const modelId = "gemini-transcribe-live-eu";
  const ready = await service.startTranscriber({ modelId, language: "de" });
  assert.equal(ready.state, "ready");
  assert.equal(connections, 0);
  await assert.rejects(service.startRecording({ modelId: "whisper-tiny" }), /not ready/);
  assert.equal(connections, 0);
  const recording = await service.startRecording({ modelId, language: "de" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.activeRecordings.get(recording.id).meta.status, "recording");
  const saved = await service.stopRecording(recording.id);
  assert.equal(connections, 1);
  assert.equal(saved.transcriptionSource, "cloud");
  assert.equal(saved.status, "error");
  assert.match(saved.error, /Live transcription was interrupted/);
  assert.equal(fs.existsSync(saved.audioPath), true);
});

test("cancel interrupts a pending cloud finalization and cannot recreate its files", async t => {
  const userDataDir = await tempDir("lw-cancel-finalize-");
  const worker = new FakeWorker();
  worker.postMessage = message => { worker.messages.push(message); };
  const service = new RecorderService({ userDataDir });
  service.worker = worker;
  service.workerReady = true;
  service.loadedModel = { modelId: "gemini-transcribe-live-eu", language: "en" };
  const meta = await service.startRecording({ modelId: "gemini-transcribe-live-eu", ephemeral: true });
  const recording = service.activeRecordings.get(meta.id);
  const stopping = service.stopRecording(meta.id).then(() => "completed", error => error.message);
  t.after(async () => {
    recording.resolveFinalized?.();
    await stopping;
    service.stopWorker();
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => setImmediate(resolve));
  await service.cancelRecording(meta.id);
  assert.equal(await Promise.race([stopping, new Promise(resolve => setTimeout(() => resolve("pending"), 500))]), "Recording cancelled.");
  assert.equal(fs.existsSync(meta.folderPath), false);
  assert.equal(service.activeRecordings.has(meta.id), false);
  const next = await service.startRecording({ modelId: "gemini-transcribe-live-eu", ephemeral: true });
  service.handleWorkerMessage({ type: "finalized", streamId: meta.id });
  assert.equal(service.activeRecordings.has(next.id), true);
  assert.equal(fs.existsSync(meta.folderPath), false);
  await service.cancelRecording(next.id);
});

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

  // Audio file resolves for the playback protocol; bad ids are rejected.
  assert.ok(service.recordingAudioFilePath(meta.id)?.endsWith("audio.webm"));
  assert.equal(service.recordingAudioFilePath("nope"), null);
  assert.equal(service.recordingAudioFilePath("../etc/passwd"), null);

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

test("imported files resolve for playback under their original extension", async () => {
  const userDataDir = await tempDir("lw-recorder-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  await installFakeModel(service, "whisper-tiny");
  await service.startTranscriber({ modelId: "whisper-tiny", language: "de" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Import stores the original container (mp3), not audio.webm.
  const meta = await service.importFileStart({
    title: "Client meeting",
    fileName: "client-meeting.mp3",
    language: "de",
    modelId: "whisper-tiny",
  });
  await service.importFileSource(meta.id, new TextEncoder().encode("mp3-bytes").buffer);
  service.feedPcm(meta.id, new Float32Array(1600).buffer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const done = await service.importFileFinish(meta.id, 1200);
  assert.equal(done.status, "complete");

  // The playback protocol must find the imported file even though it is not
  // named audio.webm — this is the bug the play button hit for imports.
  const playbackPath = service.recordingAudioFilePath(meta.id);
  assert.ok(playbackPath, "imported file resolves for playback");
  assert.ok(playbackPath.endsWith("client-meeting.mp3"));
  assert.equal(service.recordingAudioFilePath("../etc/passwd"), null);

  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
});

test("project recording links persist through finalization and reopening without moving audio", async () => {
  const userDataDir = await tempDir("lw-project-recordings-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  service.broadcast = () => {};
  try {
    const meta = await service.startRecording({ title: "Client call", sources: ["microphone"], projectId: "matter-1" });
    assert.deepEqual((await service.getRecording(meta.id)).meta.projectIds, ["matter-1"]);
    service.appendMediaChunk(meta.id, new TextEncoder().encode("audio-bytes").buffer);
    await service.setRecordingProject(meta.id, "matter-2", true);
    await service.stopRecording(meta.id);
    const reopened = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
    reopened.broadcast = () => {};
    try {
      assert.deepEqual((await reopened.getRecording(meta.id)).meta.projectIds, ["matter-1", "matter-2"]);
      await reopened.setRecordingProject(meta.id, "matter-2", true);
      await reopened.setRecordingProject(meta.id, "matter-1", false);
      const detail = await reopened.getRecording(meta.id);
      assert.deepEqual(detail.meta.projectIds, ["matter-2"]);
      assert.equal(detail.meta.folderPath, meta.folderPath);
      assert.equal(await fsp.readFile(meta.audioPath, "utf8"), "audio-bytes");
      await reopened.setRecordingProject(meta.id, "matter-2", false);
      assert.deepEqual((await reopened.getRecording(meta.id)).meta.projectIds, []);
      assert.equal((await reopened.listRecordings()).length, 1);
    } finally { reopened.dispose(); }
  } finally { service.dispose(); await fsp.rm(userDataDir, { recursive: true, force: true }); }
});

test("global and legacy recordings need no project; existing recordings can be linked later", async () => {
  const userDataDir = await tempDir("lw-project-recordings-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  service.broadcast = () => {};
  try {
    const meta = await service.startRecording({ title: "Urgent call", sources: ["microphone"] });
    assert.deepEqual(meta.projectIds, []);
    await service.stopRecording(meta.id);
    const legacy = JSON.parse(await fsp.readFile(path.join(meta.folderPath, "meta.json"), "utf8"));
    delete legacy.projectIds;
    await fsp.writeFile(path.join(meta.folderPath, "meta.json"), JSON.stringify(legacy));
    await service.setRecordingProject(meta.id, "matter-1", true);
    assert.deepEqual((await service.getRecording(meta.id)).meta.projectIds, ["matter-1"]);
    await assert.rejects(service.setRecordingProject("../escape", "matter-1", true));
    await assert.rejects(service.setRecordingProject("missing", "matter-1", true));
    const dictation = await service.startRecording({ ephemeral: true, projectId: "matter-1", sources: ["microphone"] });
    assert.deepEqual(dictation.projectIds, []);
    await assert.rejects(service.setRecordingProject(dictation.id, "matter-1", true));
    await service.cancelRecording(dictation.id);
  } finally { service.dispose(); await fsp.rm(userDataDir, { recursive: true, force: true }); }
});

test("device profile exposes the fast-device flag that gates the heaviest model", async () => {
  const userDataDir = await tempDir("lw-recorder-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  service.broadcast = () => {};
  const profile = service.deviceProfile();
  assert.equal(typeof profile.fastDevice, "boolean");
  assert.ok(profile.logicalCores >= 1);
  assert.ok(profile.totalMemoryGb > 0);
  // The recommendation must be a real catalog model and never the heavy
  // fast-device-gated one (Premium is recommended on capable machines).
  const recommended = findAudioModel(profile.recommendedModelId);
  assert.ok(recommended, "recommended model is in the catalog");
  assert.ok(!recommended.requiresFastDevice, "never auto-recommend a fast-device-gated model");
  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
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
  // Hidden from history, but the folder survives the list: the paste outcome
  // decides between explicit delete (success) and retain (failure), and a
  // concurrent list must not sweep it out from underneath that decision.
  assert.equal((await service.listRecordings()).length, 0);
  assert.equal(fs.existsSync(meta.folderPath), true);

  // Stale strays (crash leftovers) do get swept.
  const metaPath = path.join(meta.folderPath, "meta.json");
  const stored = JSON.parse(await fsp.readFile(metaPath, "utf8"));
  stored.createdAt = Date.now() - 2 * 60 * 60 * 1000;
  await fsp.writeFile(metaPath, JSON.stringify(stored));
  assert.equal((await service.listRecordings()).length, 0);
  assert.equal(fs.existsSync(meta.folderPath), false);
  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
});

test("a failed dictation paste retains the recording in history", async () => {
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
  await service.stopRecording(meta.id);
  const retained = await service.retainRecording(meta.id);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, meta.id);
  assert.equal(retained[0].ephemeral, false);
  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
});

test("power sessions are held for exactly the duration of a recording", async () => {
  const userDataDir = await tempDir("lw-recorder-");
  const held = new Set();
  const service = new RecorderService({
    userDataDir,
    forkWorker: () => new FakeWorker(),
    powerSessions: {
      acquire: (key) => held.add(key),
      release: (key) => held.delete(key),
    },
  });
  service.broadcast = () => {};

  const meta = await service.startRecording({
    title: "Call",
    language: "en",
    modelId: null,
    sources: ["microphone"],
  });
  assert.equal(held.size, 1);
  await service.stopRecording(meta.id);
  assert.equal(held.size, 0);

  const canceled = await service.startRecording({
    title: "Call",
    language: "en",
    modelId: null,
    sources: ["microphone"],
  });
  assert.equal(held.size, 1);
  await service.cancelRecording(canceled.id);
  assert.equal(held.size, 0);
  service.dispose();
  await fsp.rm(userDataDir, { recursive: true, force: true });
});

test("assignSpeakers labels segments by overlap and remaps to first-appearance order", () => {
  const segments = [
    { startMs: 0, endMs: 2000, text: "a" }, // overlaps raw speaker 7
    { startMs: 2200, endMs: 4000, text: "b" }, // overlaps raw speaker 3
    { startMs: 4200, endMs: 5000, text: "c" }, // back to raw speaker 7
  ];
  const turns = [
    { startMs: 0, endMs: 2100, speaker: 7 },
    { startMs: 2100, endMs: 4100, speaker: 3 },
    { startMs: 4100, endMs: 5200, speaker: 7 },
  ];
  const count = assignSpeakers(segments, turns);
  assert.equal(count, 2);
  // Raw ids 7,3 → first-appearance order 0,1.
  assert.equal(segments[0].speaker, 0);
  assert.equal(segments[1].speaker, 1);
  assert.equal(segments[2].speaker, 0);
});

test("assignSpeakers falls back to the nearest turn for a segment in a gap", () => {
  const segments = [{ startMs: 5000, endMs: 5100, text: "hi" }]; // no overlap
  const turns = [
    { startMs: 0, endMs: 1000, speaker: 0 },
    { startMs: 5300, endMs: 6000, speaker: 1 }, // nearest to the segment
  ];
  const count = assignSpeakers(segments, turns);
  assert.equal(count, 1);
  assert.equal(segments[0].speaker, 0); // remapped first-appearance
});

test("assignSpeakers with no turns clears speakers and returns null", () => {
  const segments = [{ startMs: 0, endMs: 1000, text: "x", speaker: 4 }];
  assert.equal(assignSpeakers(segments, null), null);
  assert.equal(segments[0].speaker, null);
});

test("abandonActiveRecordings finalizes calls, cancels dictations, releases blockers", async () => {
  const userDataDir = await tempDir("lw-recorder-");
  const held = new Set();
  const service = new RecorderService({
    userDataDir,
    forkWorker: () => new FakeWorker(),
    powerSessions: { acquire: (key) => held.add(key), release: (key) => held.delete(key) },
  });
  service.broadcast = () => {};

  const call = await service.startRecording({
    title: "Client call",
    language: "en",
    modelId: null,
    sources: ["microphone"],
  });
  const dictation = await service.startRecording({
    title: "System dictation",
    language: "en",
    modelId: null,
    sources: ["microphone"],
    ephemeral: true,
  });
  assert.equal(held.size, 2);
  assert.equal(service.activeRecordings.size, 2);

  await service.abandonActiveRecordings();
  assert.equal(held.size, 0, "every abandoned recording released its blocker");
  assert.equal(service.activeRecordings.size, 0);

  // The call recording was finalized (kept); the dictation was cancelled.
  const listed = await service.listRecordings();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, call.id);
  assert.equal((await service.getRecording(dictation.id)), null);
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

test("long recordings append segments while live and keep the final workspace transcript", async () => {
  const userDataDir = await tempDir("lw-long-recording-");
  const workspaceDir = await tempDir("lw-live-workspace-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  const events = [];
  service.broadcast = event => events.push(event);
  try {
    const meta = await service.startRecording({ title: "Long meeting", sources: ["microphone"] });
    service.startLiveTranscript(workspaceDir);
    const startedTarget = service.liveTranscript;
    service.startLiveTranscript(workspaceDir);
    assert.equal(service.liveTranscript, startedTarget, "another chat in the same workspace does not reset the file");
    // Six hours of speech at one segment per 18 seconds, fed as a burst to
    // exercise coalescing and persistence without waiting six wall-clock hours.
    for (let i = 0; i < 1200; i++) service.handleWorkerMessage({
      type: "segment", streamId: meta.id, id: `long-${i}`,
      startMs: i * 18000, endMs: (i + 1) * 18000, text: `Segment ${i}`, speaker: i % 2,
    });
    await service.liveTranscriptWriteQueue;
    const journal = service.activeRecordings.get(meta.id).transcriptStream;
    await new Promise(resolve => journal.write("", resolve));
    const lines = (await fsp.readFile(path.join(meta.folderPath, "transcript.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1200, "segments are saved before Stop");
    assert.equal(JSON.parse(lines[1199]).speaker, 1);
    const livePath = path.join(workspaceDir, RecorderService.LIVE_TRANSCRIPT_FILE);
    const beforeStop = await fsp.readFile(livePath, "utf8");
    assert.match(beforeStop, /Speaker 1: Segment 0/);
    assert.match(beforeStop, /\[5:59:42\].*Speaker 2: Segment 1199/);
    await service.stopRecording(meta.id);
    const final = await fsp.readFile(livePath, "utf8");
    assert.ok(final.startsWith(beforeStop), "stopping appends an end marker without erasing any speech");
    assert.equal(final.match(/Segment \d+/g).length, 1200);
    assert.match(final, /Recording ended/);
    const detail = await service.getRecording(meta.id);
    assert.equal(detail.meta.speakerCount, 2);
    assert.equal(detail.segments[1199].speaker, 1);
    assert.equal(events.filter(event => event.type === "recording-error").length, 0);
  } finally {
    service.dispose();
    await fsp.rm(userDataDir, { recursive: true, force: true });
    await fsp.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("interrupted recordings recover their segment journal and tolerate a torn final line", async () => {
  const userDataDir = await tempDir("lw-recover-recording-");
  const service = new RecorderService({ userDataDir, forkWorker: () => new FakeWorker() });
  service.broadcast = () => {};
  const meta = await service.startRecording({ title: "Interrupted call", sources: ["microphone"] });
  service.handleWorkerMessage({ type: "segment", streamId: meta.id, id: "saved", text: "Saved before interruption", startMs: 0, endMs: 2000, speaker: 0 });
  const entry = service.activeRecordings.get(meta.id);
  await new Promise(resolve => entry.transcriptStream.write("", resolve));
  service.dispose();
  await new Promise(resolve => entry.transcriptStream.on("close", () => resolve(undefined)));
  await fsp.appendFile(path.join(meta.folderPath, "transcript.jsonl"), '{"id":"torn');
  const restarted = new RecorderService({ userDataDir });
  try {
    const listed = await restarted.listRecordings();
    assert.equal(listed[0].status, "error");
    assert.match(listed[0].error, /interrupted/);
    const detail = await restarted.getRecording(meta.id);
    assert.equal(detail.segments.length, 1);
    assert.equal(detail.segments[0].text, "Saved before interruption");
    assert.equal(detail.meta.speakerCount, 1);
    assert.match(await fsp.readFile(path.join(meta.folderPath, "transcript.txt"), "utf8"), /Saved before interruption/);
  } finally { restarted.dispose(); await fsp.rm(userDataDir, { recursive: true, force: true }); }
});

test("workspace transcript copies follow speaker corrections and title changes after restart", async () => {
  const userDataDir = await tempDir("lw-corrected-transcript-");
  const workspaceDir = await tempDir("lw-corrected-workspace-");
  const service = new RecorderService({ userDataDir });
  const restarted = new RecorderService({ userDataDir });
  try {
    const meta = await service.startRecording({ title: "Client call", sources: ["microphone"] });
    service.startLiveTranscript(workspaceDir);
    for (const speaker of [0, 1]) service.handleWorkerMessage({
      type: "segment", streamId: meta.id, id: `turn-${speaker}`, speaker,
      startMs: speaker * 1000, endMs: (speaker + 1) * 1000, text: `Statement ${speaker}`,
    });
    await service.stopRecording(meta.id);
    service.dispose();
    const filePath = path.join(workspaceDir, RecorderService.LIVE_TRANSCRIPT_FILE);
    await restarted.editTranscript(meta.id, { type: "rename-speaker", speaker: 0, name: "Chris" });
    let copy = await fsp.readFile(filePath, "utf8");
    assert.match(copy, /Chris: Statement 0/);
    assert.doesNotMatch(copy, /Speaker 1:/);
    await restarted.editTranscript(meta.id, { type: "assign-segments", segmentIds: ["turn-1"], speaker: 0 });
    copy = await fsp.readFile(filePath, "utf8");
    assert.match(copy, /Chris: Statement 1/);
    await restarted.editTranscript(meta.id, { type: "remove-speaker", speaker: 0, reassignTo: 1 });
    await restarted.renameRecording(meta.id, "Updated client call");
    copy = await fsp.readFile(filePath, "utf8");
    assert.ok(copy.startsWith("# Updated client call\n"), "tracking metadata does not force Markdown source mode");
    assert.doesNotMatch(copy, /<!--/);
    assert.match(copy, /# Updated client call/);
    assert.match(copy, /Speaker 2: Statement 0/);
    assert.match(copy, /Speaker 2: Statement 1/);
    assert.doesNotMatch(copy, /Chris:/);
    assert.equal(copy.match(/Statement \d/g).length, 2, "corrections preserve all transcript text");
    assert.match(await fsp.readFile(path.join(meta.folderPath, "transcript.md"), "utf8"), /# Updated client call/);
  } finally {
    service.dispose();
    restarted.dispose();
    await fsp.rm(userDataDir, { recursive: true, force: true });
    await fsp.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("editing an older recording cannot overwrite a newer call or unrelated workspace file", async () => {
  const userDataDir = await tempDir("lw-transcript-owner-");
  const workspaceDir = await tempDir("lw-transcript-owner-workspace-");
  const service = new RecorderService({ userDataDir });
  try {
    const first = await service.startRecording({ title: "First call", sources: ["microphone"] });
    service.startLiveTranscript(workspaceDir);
    service.handleWorkerMessage({ type: "segment", streamId: first.id, id: "first", speaker: 0, startMs: 0, endMs: 1000, text: "First call text" });
    await service.stopRecording(first.id);
    const second = await service.startRecording({ title: "Second call", sources: ["microphone"] });
    service.startLiveTranscript(workspaceDir);
    // Deliberately race the edit with initialization of the new live file.
    await service.editTranscript(first.id, { type: "rename-speaker", speaker: 0, name: "Old speaker" });
    service.handleWorkerMessage({ type: "segment", streamId: second.id, id: "second", speaker: 0, startMs: 0, endMs: 1000, text: "Second call text" });
    await service.stopRecording(second.id);
    await service.editTranscript(first.id, { type: "rename-speaker", speaker: 0, name: "Still old" });
    const filePath = path.join(workspaceDir, RecorderService.LIVE_TRANSCRIPT_FILE);
    const copy = await fsp.readFile(filePath, "utf8");
    assert.match(copy, /Second call text/);
    assert.doesNotMatch(copy, /First call|Old speaker|Still old/);
    await fsp.writeFile(filePath, "# A manually replaced document\n");
    await service.editTranscript(second.id, { type: "rename-speaker", speaker: 0, name: "New speaker" });
    assert.equal(await fsp.readFile(filePath, "utf8"), "# A manually replaced document\n");
  } finally {
    service.dispose();
    await fsp.rm(userDataDir, { recursive: true, force: true });
    await fsp.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("switching live transcript workspaces does not send subsequent speech to the old workspace", async () => {
  const userDataDir = await tempDir("lw-switch-live-");
  const first = await tempDir("lw-first-");
  const second = await tempDir("lw-second-");
  const service = new RecorderService({ userDataDir });
  service.broadcast = () => {};
  try {
    const meta = await service.startRecording({ sources: ["microphone"] });
    service.startLiveTranscript(first);
    await service.liveTranscriptWriteQueue;
    service.startLiveTranscript(second);
    service.handleWorkerMessage({ type: "segment", streamId: meta.id, id: "new", text: "Only the second workspace", startMs: 0, endMs: 1000 });
    await service.stopRecording(meta.id);
    assert.doesNotMatch(await fsp.readFile(path.join(first, RecorderService.LIVE_TRANSCRIPT_FILE), "utf8"), /Only the second/);
    assert.match(await fsp.readFile(path.join(second, RecorderService.LIVE_TRANSCRIPT_FILE), "utf8"), /Only the second/);
  } finally {
    service.dispose();
    for (const dir of [userDataDir, first, second]) await fsp.rm(dir, { recursive: true, force: true });
  }
});


test("live speaker identities stay stable across turns and have bounded memory", () => {
  const clusters = new SpeakerClusters(0.5, 2);
  assert.equal(clusters.identify(new Float32Array([1, 0, 0])), 0);
  assert.equal(clusters.identify(new Float32Array([0, 1, 0])), 1);
  for (let i = 0; i < 10000; i++) {
    assert.equal(clusters.identify(new Float32Array([0.98, 0.02, 0])), 0);
    assert.equal(clusters.identify(new Float32Array([0.02, 0.98, 0])), 1);
  }
  assert.equal(clusters.identify(new Float32Array([0, 0, 1])), null, "an unknown voice stays unassigned when the cap is reached");
  assert.equal(clusters.identify(new Float32Array([0, 0, 0])), null);
  assert.equal(clusters.voices.length, 2);
});

function liveSpeakerFixture() {
  let turns = [{ start: 0, end: 3, speaker: 0 }];
  let embedding = [1, 0, 0];
  let extracted = 0;
  const detector = new LiveSpeakers({
    OfflineSpeakerDiarization: class { process() { return turns; } },
    SpeakerEmbeddingExtractor: class {
      createStream() { return { acceptWaveform() {}, inputFinished() {} }; }
      isReady() { return true; }
      compute() { extracted++; return Float32Array.from(embedding); }
    },
  }, { segModel: "test", embModel: "test", threshold: 0.5 });
  return {
    detector,
    identify: (voice, seconds = 3, localTurns) => {
      embedding = voice;
      turns = localTurns ?? [{ start: 0, end: seconds, speaker: 0 }];
      return detector.identify(new Float32Array(16000 * seconds));
    },
    extractions: () => extracted,
  };
}

test("live matching tolerates the voice variation that previously split a returning speaker", () => {
  const f = liveSpeakerFixture();
  assert.equal(f.identify([1, 0, 0], 1.6), 0);
  assert.equal(f.identify([0.4, Math.sqrt(0.84), 0]), 1);
  // Recorded same-person turns scored 0.63, below the old live-only 0.75.
  assert.equal(f.identify([0.63, -0.05, Math.sqrt(1 - 0.63 ** 2 - 0.05 ** 2)], 1.7), 0);
  assert.equal(f.detector.clusters.voices.length, 2);
});

test("brief speech can recognize a known voice without creating or moving an identity", () => {
  const f = liveSpeakerFixture();
  assert.equal(f.identify([1, 0, 0], 1.2), null);
  assert.equal(f.detector.clusters.voices.length, 0);
  assert.equal(f.identify([1, 0, 0], 2), 0);
  const original = [...f.detector.clusters.voices[0]];
  assert.equal(f.identify([0.8, 0.6, 0], 1.2), 0);
  assert.deepEqual([...f.detector.clusters.voices[0]], original);
  assert.equal(f.identify([0, 1, 0], 1.2), null);
  assert.equal(f.detector.clusters.voices.length, 1);
});

test("ambiguous matching and overlapping voices stay unassigned without inventing people", () => {
  const f = liveSpeakerFixture();
  assert.equal(f.identify([1, 0, 0]), 0);
  assert.equal(f.identify([0, 1, 0]), 1);
  assert.equal(f.identify([0.7, 0.7, 0]), null);
  assert.equal(f.detector.clusters.voices.length, 2);
  const before = f.extractions();
  assert.equal(f.identify([0, 0, 1], 3, [
    { start: 0, end: 2, speaker: 0 }, { start: 1, end: 3, speaker: 1 },
  ]), null);
  assert.equal(f.extractions(), before);
  assert.equal(f.detector.clusters.voices.length, 2);
});

test("only a segment's dominant voice is enrolled, not every local diarization label", () => {
  const f = liveSpeakerFixture();
  assert.equal(f.identify([1, 0, 0], 5, [
    { start: 0, end: 3.5, speaker: 8 }, { start: 3.5, end: 5, speaker: 12 },
  ]), 0);
  assert.equal(f.extractions(), 1);
  assert.equal(f.detector.clusters.voices.length, 1);
});

for (const modelId of ["whisper-tiny", "gemini-transcribe-live-eu"]) {
  test(`separate inputs preserve audio, identity, overlapping speech and both finalization tails (${modelId})`, async t => {
    const userDataDir = await tempDir("lw-split-inputs-");
    const worker = new FakeWorker();
    worker.postMessage = message => { worker.messages.push(message); };
    const service = new RecorderService({ userDataDir });
    const events = [];
    service.broadcast = event => events.push(event);
    service.worker = worker;
    service.workerReady = true;
    service.loadedModel = { modelId, language: "de" };
    t.after(async () => { service.stopWorker(); await fsp.rm(userDataDir, { recursive: true, force: true }); });
    const meta = await service.startRecording({ modelId, sources: ["microphone", "system"], separateSources: true, diarize: true });
    const mic = `${meta.id}:microphone`;
    const system = `${meta.id}:system`;
    assert.deepEqual(worker.messages.filter(m => m.type === "begin").map(m => m.streamId), modelId.startsWith("gemini") ? [mic, system] : []);
    assert.equal(worker.messages.some(m => m.type === "diarize-begin"), false, "source labels must not be replaced by guessed identities");
    const micPcm = new Float32Array([.25, .5]).buffer;
    const systemPcm = new Float32Array([-.25, -.5]).buffer;
    service.feedPcm(meta.id, micPcm, "microphone");
    service.feedPcm(meta.id, systemPcm, "system");
    service.feedPcm(meta.id, micPcm); // Reject a mixed packet in separated mode.
    assert.deepEqual(worker.messages.filter(m => m.type === "pcm").map(m => [m.streamId, m.buffer]), [[mic, micPcm], [system, systemPcm]]);
    for (const [source, bytes] of [[undefined, "mixed"], ["microphone", "mic"], ["system", "system"]]) {
      service.appendMediaChunk(meta.id, new TextEncoder().encode(bytes).buffer, source);
    }
    // Different upstream streams may reuse segment IDs and finish out of order.
    service.handleWorkerMessage({ type: "segment", streamId: system, id: "same", startMs: 1000, endMs: 2500, text: "Remote words" });
    service.handleWorkerMessage({ type: "partial", streamId: mic, startMs: 900, endMs: 2000, text: "Local words" });
    service.handleWorkerMessage({ type: "partial-clear", streamId: system, endMs: 2500 });
    assert.equal(events.at(-1).source, "system");
    assert.equal(events.at(-1).streamId, meta.id);
    let finished = false;
    const stopping = service.stopRecording(meta.id).then(result => { finished = true; return result; });
    service.handleWorkerMessage({ type: "finalized", streamId: system });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, "must wait for the microphone tail too");
    service.handleWorkerMessage({ type: "segment", streamId: mic, id: "same", startMs: 900, endMs: 2000, text: "Local words" });
    service.handleWorkerMessage({ type: "finalized", streamId: mic });
    const saved = await stopping;
    assert.equal(saved.status, "complete");
    assert.equal(saved.speakerCount, 2);
    assert.equal(saved.sizeBytes, 14);
    const detail = await service.getRecording(meta.id);
    assert.deepEqual(detail.segments.map(s => [s.source, s.speaker, s.text]), [["microphone", 0, "Local words"], ["system", 1, "Remote words"]]);
    assert.equal(new Set(detail.segments.map(s => s.id)).size, 2);
    assert.equal(await fsp.readFile(saved.sourceAudioPaths.microphone, "utf8"), "mic");
    assert.equal(await fsp.readFile(saved.sourceAudioPaths.system, "utf8"), "system");
    assert.equal(await fsp.readFile(saved.audioPath, "utf8"), "mixed");
    const transcript = await fsp.readFile(path.join(saved.folderPath, "transcript.md"), "utf8");
    assert.match(transcript, /Microphone:\*\* Local words/);
    assert.match(transcript, /System audio:\*\* Remote words/);
    assert.equal(service.recordingInputs.size, 0);
    assert.deepEqual(worker.messages.filter(m => m.type === "finalize").map(m => m.streamId), [mic, system]);
  });
}

test("split input reconnection keeps capture active until both caption connections recover", async t => {
  const userDataDir = await tempDir("lw-split-reconnect-");
  const worker = new FakeWorker();
  const service = new RecorderService({ userDataDir });
  const events = [];
  service.worker = worker;
  worker.on("message", message => service.handleWorkerMessage(message));
  service.workerReady = true;
  service.loadedModel = { modelId: "gemini-transcribe-live-eu", language: "de" };
  service.broadcast = event => events.push(event);
  t.after(async () => { service.stopWorker(); await fsp.rm(userDataDir, { recursive: true, force: true }); });
  const meta = await service.startRecording({ modelId: "gemini-transcribe-live-eu", sources: ["microphone", "system"], separateSources: true });
  const microphone = `${meta.id}:microphone`;
  const system = `${meta.id}:system`;
  service.handleWorkerMessage({ type: "stream-reconnecting", streamId: microphone, error: "Network offline" });
  service.handleWorkerMessage({ type: "stream-reconnecting", streamId: system, error: "Network offline" });
  service.handleWorkerMessage({ type: "stream-reconnected", streamId: microphone });
  assert.equal(events.at(-1).reconnecting, true, "the other input is still offline");
  service.handleWorkerMessage({ type: "stream-reconnected", streamId: system });
  assert.deepEqual(events.at(-1), { type: "recording-transcription-status", recordingId: meta.id, reconnecting: false });
  assert.equal(service.activeRecordings.get(meta.id).meta.status, "recording");
  assert.equal(worker.messages.some(message => message.type === "drop" || message.type === "finalize"), false);
  const saved = await service.stopRecording(meta.id);
  assert.equal(saved.status, "complete");
  assert.match(saved.error, /Some speech may be missing/);
});

test("a split input terminal error drops both cloud sessions and retains both audio files", async t => {
  const userDataDir = await tempDir("lw-split-error-");
  const worker = new FakeWorker();
  worker.postMessage = message => { worker.messages.push(message); };
  const service = new RecorderService({ userDataDir });
  service.worker = worker;
  service.workerReady = true;
  service.loadedModel = { modelId: "gemini-transcribe-live-eu", language: "de" };
  t.after(async () => { service.stopWorker(); await fsp.rm(userDataDir, { recursive: true, force: true }); });
  const meta = await service.startRecording({ modelId: "gemini-transcribe-live-eu", sources: ["microphone", "system"], separateSources: true });
  service.handleWorkerMessage({ type: "stream-error", streamId: `${meta.id}:microphone`, error: "Connection failed" });
  const saved = await service.stopRecording(meta.id);
  assert.equal(saved.status, "error");
  assert.equal(saved.error, "Connection failed");
  assert.deepEqual(new Set(worker.messages.filter(m => m.type === "drop").map(m => m.streamId)), new Set([`${meta.id}:microphone`, `${meta.id}:system`]));
  assert.ok(fs.existsSync(saved.sourceAudioPaths.microphone));
  assert.ok(fs.existsSync(saved.sourceAudioPaths.system));
  assert.equal(service.recordingInputs.size, 0);
});

test("speaker processing after Stop updates the whole transcript, workspace mirrors, recovery journal and exports", async t => {
  const userDataDir = await tempDir("lw-cloud-speaker-updates-");
  const workspace = await tempDir("lw-cloud-speaker-workspace-");
  const worker = new FakeWorker();
  worker.postMessage = message => { worker.messages.push(message); };
  const service = new RecorderService({ userDataDir });
  const events = [];
  service.broadcast = event => events.push(event);
  service.worker = worker;
  service.workerReady = true;
  const modelId = "gemini-transcribe-live-eu";
  service.loadedModel = { modelId, language: "de" };
  t.after(async () => { service.stopWorker(); await fsp.rm(userDataDir, { recursive: true, force: true }); await fsp.rm(workspace, { recursive: true, force: true }); });
  const meta = await service.startRecording({ modelId, sources: ["microphone", "system"], separateSources: true, diarize: true });
  const system = `${meta.id}:system`;
  const mic = `${meta.id}:microphone`;
  assert.equal(worker.messages.find(message => message.type === "begin").diarize, true);
  await service.startLiveTranscript(workspace);
  service.handleWorkerMessage({ type: "segment", streamId: system, id: "a", startMs: 0, endMs: 4000, text: "First remote person." });
  service.handleWorkerMessage({ type: "segment", streamId: system, id: "b", startMs: 5000, endMs: 9000, text: "Second remote person." });
  service.handleWorkerMessage({ type: "segment", streamId: mic, id: "a", startMs: 5000, endMs: 9000, text: "Microphone remains separate." });
  service.handleWorkerMessage({ type: "segment", streamId: system, id: "late", startMs: 180000, endMs: 185000, text: "Three minutes later." });
  const stopping = service.stopRecording(meta.id);
  assert.equal(events.some(event => event.type === "recording-diarizing"), false, "cloud speaker work does not block capture controls");
  service.handleWorkerMessage({ type: "speaker-turns", voicesVerified: true, streamId: system, startMs: 0, endMs: 10000,
    turns: [{ startMs: 0, endMs: 4000, speaker: 0 }, { startMs: 5000, endMs: 9000, speaker: 1 }] });
  let detail = await service.getRecording(meta.id);
  assert.deepEqual(detail.segments.filter(segment => segment.source === "system").map(segment => segment.speaker), [1, 2, 1]);
  assert.equal(detail.segments.find(segment => segment.source === "microphone").speaker, 0);
  assert.equal(detail.meta.speakerNames[2], "Speaker 3");
  const update = events.find(event => event.type === "transcript-speakers-updated");
  assert.equal(update.segments.length, 1);
  assert.equal(update.segments[0].text, "Second remote person.");
  await service.writeLiveTranscript();
  const liveMirror = await fsp.readFile(path.join(workspace, RecorderService.LIVE_TRANSCRIPT_FILE), "utf8");
  assert.match(liveMirror, /Speaker 3/);
  assert.doesNotMatch(liveMirror, /Recording ended/);
  // Overlapping updates must preserve the earlier part of a speaker turn.
  service.handleWorkerMessage({ type: "speaker-turns", voicesVerified: true, streamId: system, startMs: 3000, endMs: 15000,
    turns: [{ startMs: 3000, endMs: 4000, speaker: 0 }, { startMs: 5000, endMs: 9000, speaker: 1 }] });
  service.handleWorkerMessage({ type: "segment", streamId: system, id: "d", startMs: 0, endMs: 6500, text: "Long delayed first turn." });
  detail = await service.getRecording(meta.id);
  assert.equal(detail.segments.find(segment => segment.id.endsWith(":d")).speaker, 1);
  // A delayed live segment still receives a previously completed speaker pass.
  service.handleWorkerMessage({ type: "segment", streamId: system, id: "c", startMs: 6000, endMs: 8500, text: "Delayed final words." });
  detail = await service.getRecording(meta.id);
  assert.equal(detail.segments.find(segment => segment.id.endsWith(":c")).speaker, 2);
  // A speaker-only failure is a warning and never changes recording state.
  service.handleWorkerMessage({ type: "diarize-error", streamId: system, error: "Provider is unavailable." });
  assert.equal(events.at(-1).type, "recording-warning");
  assert.equal(detail.meta.status, "recording");
  service.handleWorkerMessage({ type: "finalized", streamId: system });
  service.handleWorkerMessage({ type: "finalized", streamId: mic });
  const saved = await stopping;
  const mirror = await fsp.readFile(path.join(workspace, RecorderService.LIVE_TRANSCRIPT_FILE), "utf8");
  assert.match(mirror, /Speaker 3/);
  assert.match(await fsp.readFile(path.join(saved.folderPath, "transcript.md"), "utf8"), /identified in the cloud/);
  // Force journal recovery. Revisions replace by ID instead of duplicating text.
  await fsp.rm(path.join(saved.folderPath, "transcript.json"));
  detail = await service.getRecording(meta.id);
  assert.equal(detail.segments.length, 6);
  assert.equal(detail.segments.find(segment => segment.id.endsWith(":b")).speaker, 2);
  assert.equal(detail.meta.speakerNames[2], "Speaker 3");
});

test("cloud word timing splits a saved mixed block after Stop; journal recovery keeps only the split text", async t => {
  const userDataDir = await tempDir("lw-cloud-mixed-turn-");
  const worker = new FakeWorker();
  worker.postMessage = message => worker.messages.push(message);
  const service = new RecorderService({ userDataDir });
  const events = [];
  service.broadcast = event => events.push(event);
  service.worker = worker;
  service.workerReady = true;
  const modelId = "gemini-transcribe-live-eu";
  service.loadedModel = { modelId, language: "de" };
  t.after(async () => { service.stopWorker(); await fsp.rm(userDataDir, { recursive: true, force: true }); });
  const meta = await service.startRecording({ modelId, sources: ["microphone", "system"], separateSources: true, diarize: true });
  const mic = `${meta.id}:microphone`;
  const text = "Ich prüfe den Vertrag. Danke, ich übernehme.";
  service.handleWorkerMessage({ type: "segment", streamId: mic, id: "mixed", startMs: 0, endMs: 9000, text });
  assert.equal((await service.getRecording(meta.id)).segments[0].speaker, 0, "the known input is available before speaker detection");
  service.handleWorkerMessage({ type: "partial", streamId: mic, startMs: 9000, endMs: 11000, text: "Nächste Frage" });
  assert.equal(events.at(-1).parts[0].speaker, 0);
  const stopping = service.stopRecording(meta.id);
  const words = ["ich", "prüfe", "den", "Vertrag", "danke", "ich", "übernehme"].map((word, i) =>
    ({ text: word, startMs: 1000 + i * 500, endMs: 1400 + i * 500, speaker: i < 4 ? 0 : 1 }));
  words.push({ text: "Nächste", startMs: 9500, endMs: 9900, speaker: 0 }, { text: "Frage", startMs: 10000, endMs: 10500, speaker: 0 });
  service.handleWorkerMessage({ type: "speaker-turns", voicesVerified: true, streamId: mic, startMs: 0, endMs: 15000, words,
    turns: [{ startMs: 1000, endMs: 2900, speaker: 0 }, { startMs: 3000, endMs: 4400, speaker: 1 }, { startMs: 9500, endMs: 10500, speaker: 0 }] });
  const live = await service.getRecording(meta.id);
  assert.deepEqual(live.segments.map(part => [part.text, part.speaker]), [["Ich prüfe den Vertrag.", 0], ["Danke, ich übernehme.", 2]]);
  const update = events.find(event => event.type === "transcript-speakers-updated");
  assert.deepEqual(update.replacedIds, [`${mic}:mixed`]);
  assert.equal(events.at(-1).type, "transcript-partial");
  assert.equal(events.at(-1).parts[0].speaker, 0);
  service.handleWorkerMessage({ type: "finalized", streamId: mic });
  service.handleWorkerMessage({ type: "finalized", streamId: `${meta.id}:system` });
  const saved = await stopping;
  await fsp.rm(path.join(saved.folderPath, "transcript.json"));
  const recovered = await service.getRecording(meta.id);
  assert.equal(recovered.segments.length, 2);
  assert.equal(recovered.segments.map(part => part.text).join(" "), text);
  assert.deepEqual(recovered.segments.map(part => part.speaker), [0, 2]);
});

async function notesFixture(t, generateMeetingNotes) {
  const userDataDir = await tempDir("lw-meeting-notes-");
  const service = new RecorderService({ userDataDir, generateMeetingNotes });
  const worker = new FakeWorker();
  service.worker = worker;
  service.workerReady = true;
  service.loadedModel = { modelId: "gemini-transcribe-live-eu", language: "de" };
  worker.on("message", message => service.handleWorkerMessage(message));
  const settings = { enabled: true, model: "notes-eu", instructions: "Decisions and deadlines" };
  t.after(async () => {
    service.dispose();
    await Promise.all([...service.summaryJobs.values()].map(job => job.promise));
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });
  const record = async (input = {}) => {
    const meta = await service.startRecording({ modelId: "gemini-transcribe-live-eu", sources: ["microphone", "system"],
      separateSources: true, diarize: false, meetingNotes: settings, ...input });
    service.handleWorkerMessage({ type: "segment", streamId: meta.sourceAudioPaths ? `${meta.id}:microphone` : meta.id,
      id: "words", startMs: 1000, endMs: 2500, text: "The deadline is Friday." });
    await service.stopRecording(meta.id);
    return meta.id;
  };
  return { service, settings, record, userDataDir };
}

test("automatic notes wait for both speaker passes and saved final identities before reporting generation", async t => {
  const gate = () => {
    let release = () => {};
    const promise = new Promise(resolve => { release = () => resolve(undefined); });
    return { promise, release };
  };
  const mic = gate(), system = gate(), saving = gate(), saved = gate(), generating = gate(), response = gate();
  t.after(() => { for (const pending of [mic, system, saving, saved, generating, response]) pending.release(); });
  const calls = [];
  const { service, settings } = await notesFixture(t, async input => {
    calls.push(input);
    generating.release();
    await response.promise;
    return { title: "Complete", summary: "Both final speakers." };
  });
  const meta = await service.startRecording({ modelId: "gemini-transcribe-live-eu", sources: ["microphone", "system"],
    separateSources: true, meetingNotes: settings });
  const recording = service.activeRecordings.get(meta.id);
  for (const source of meta.sources) service.handleWorkerMessage({ type: "segment", streamId: `${meta.id}:${source}`,
    id: "words", startMs: 0, endMs: 2000, text: `${source} words.` });
  recording.speakerPasses = [mic, system].map((pending, id) => {
    const pass = new DeferredCloudSpeakerPass({ recognize: async () => [], onTurns: () => {}, onError: assert.fail });
    pass.finish = async () => {
      await pending.promise;
      recording.meta.speakerNames[id] = id === 0 ? "Chris" : "Johann";
    };
    return pass;
  });
  const sync = service.syncWorkspaceTranscripts.bind(service);
  service.syncWorkspaceTranscripts = async (...args) => {
    if (service.speakerJobs.has(meta.id)) { saving.release(); await saved.promise; }
    return sync(...args);
  };
  await service.stopRecording(meta.id);
  const pending = await service.getRecording(meta.id);
  assert.equal(pending.meta.speakerProcessing, true);
  assert.equal(calls.length, 0);
  mic.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0, "the system input must finish too");
  system.release();
  await saving.promise;
  assert.equal(calls.length, 0, "final speaker metadata and workspace copies must finish saving");
  saved.release();
  await generating.promise;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].speakers, [{ id: 0, label: "Chris" }, { id: 1, label: "Johann" }]);
  const running = await service.getRecording(meta.id);
  assert.equal(running.meta.speakerProcessing, false);
  assert.equal(running.meta.summaryProcessing, true);
  response.release();
  await service.summaryJobs.get(meta.id)?.promise;
  assert.equal((await service.getRecording(meta.id)).meta.summaryProcessing, false);
  assert.equal(pending.meta.summaryProcessing, false, "waiting for speakers must not be reported as summarizing");
});

test("unverified provider voice splits keep source labels while refining timing", async t => {
  const { service } = await notesFixture(t, async () => ({}));
  const meta = await service.startRecording({ modelId: "gemini-transcribe-live-eu", sources: ["microphone", "system"], separateSources: true });
  for (const source of meta.sources) {
    const streamId = `${meta.id}:${source}`;
    service.handleWorkerMessage({ type: "segment", streamId, id: "words", startMs: 0, endMs: 10000, text: "One person continues speaking." });
    service.handleWorkerMessage({ type: "speaker-turns", voicesVerified: false, streamId, startMs: 0, endMs: 10000,
      turns: [{ startMs: 2000, endMs: 4000, speaker: 0 }, { startMs: 4000, endMs: 6000, speaker: 1 }],
      words: ["One", "person", "continues", "speaking"].map((text, i) => ({ text, startMs: 2000+i*1000, endMs: 2900+i*1000, speaker: i<2 ? 0 : 1 })) });
  }
  await service.stopRecording(meta.id);
  const detail = await service.getRecording(meta.id);
  assert.deepEqual(detail.meta.speakerNames, { 0: "Microphone", 1: "System audio" });
  assert.equal(detail.segments.length, 2);
  assert.deepEqual(Object.fromEntries(detail.segments.map(s => [s.source, s.speaker])), { microphone: 0, system: 1 });
  assert.ok(detail.segments.every(s => s.startMs === 2000 && s.endMs === 5900));
});

test("cloud meeting notes update title, summary, JSON, Markdown and the workspace copy after Stop", async t => {
  const calls = [];
  const { service, record, userDataDir, settings } = await notesFixture(t, async input => {
    calls.push(input);
    return { title: "Contract review", summary: "The deadline is Friday.", speakerNames: { 0: "Chris", 99: "Unknown" } };
  });
  const id = await record();
  await service.summaryJobs.get(id)?.promise;
  const detail = await service.getRecording(id);
  assert.equal(detail.meta.summaryProcessing, false);
  assert.equal(detail.meta.title, "Contract review");
  assert.equal(detail.meta.summary, "The deadline is Friday.");
  assert.deepEqual(detail.meta.speakerNames, { 0: "Chris", 1: "System audio" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].settings, settings);
  assert.match(calls[0].transcript, /\[speaker:0\] The deadline is Friday/);
  assert.match(await fsp.readFile(path.join(detail.meta.folderPath, "transcript.md"), "utf8"), /## Summary\n\nThe deadline is Friday/);
  assert.equal(JSON.parse(await fsp.readFile(detail.meta.transcriptPath, "utf8")).summary, detail.meta.summary);
  const copy = await service.saveToWorkspace(id, userDataDir);
  assert.equal(copy.ok, true);
  assert.match(await fsp.readFile(path.join(copy.folderPath, "transcript.md"), "utf8"), /## Summary\n\nThe deadline is Friday/);
  const text = await fsp.readFile(path.join(detail.meta.folderPath, "transcript.txt"), "utf8");
  assert.equal(text.trim(), "Chris: The deadline is Friday.", "naming a speaker preserves the transcript words");
});

test("local recordings, ephemeral dictation and disabled notes never call a cloud notes model", async t => {
  let calls = 0;
  const { service, record, settings } = await notesFixture(t, async () => { calls++; return {}; });
  await record({ meetingNotes: { ...settings, enabled: false } });
  await record({ ephemeral: true, sources: ["microphone"], separateSources: false });
  service.loadedModel = { modelId: "whisper-tiny", language: "de" };
  await record({ modelId: "whisper-tiny" });
  assert.equal(calls, 0);
  assert.equal(service.summaryJobs.size, 0);
});

test("existing summaries resolve known speaker IDs on reopen and in regenerated exports", async t => {
  const { service, record } = await notesFixture(t, async () => ({ title: "Review", summary: "Agreed.", speakerNames: { 0: "Chris" } }));
  const id = await record();
  await service.summaryJobs.get(id)?.promise;
  const detail = await service.getRecording(id);
  const metadata = path.join(detail.meta.folderPath, "meta.json");
  await fsp.writeFile(metadata, JSON.stringify({ ...detail.meta, summary: "Speaker 0 stimmt zu. Speaker 1 antwortet." }));
  assert.equal((await service.getRecording(id)).meta.summary, "Chris stimmt zu. Speaker 1 antwortet.");
  await service.editTranscript(id, { type: "rename-speaker", speaker: 1, name: "Johann" });
  assert.equal((await service.getRecording(id)).meta.summary, "Chris stimmt zu. Johann antwortet.");
  for (const name of ["meta.json", "transcript.json", "transcript.md"]) {
    const exported = await fsp.readFile(path.join(detail.meta.folderPath, name), "utf8");
    assert.ok(exported.includes("Chris stimmt zu. Johann antwortet."));
    assert.ok(!exported.includes("Speaker 0"));
  }
});

test("Smart Meeting Summary runs once after an automatic opt-out and survives duplicate clicks", async t => {
  const calls = [];
  /** @type {(value: { title: string, summary: string, speakerNames: Record<string, string> }) => void} */
  let release = () => { assert.fail("the summary request must have started"); };
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { service, record, settings } = await notesFixture(t, (input, signal) => {
    calls.push(input);
    return new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered();
    });
  });
  const disabled = { ...settings, enabled: false };
  const id = await record({ meetingNotes: disabled });
  assert.equal(calls.length, 0);
  await Promise.all([service.summarizeRecording(id, settings), service.summarizeRecording(id, settings)]);
  await started;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.enabled, true);
  assert.equal(disabled.enabled, false);
  assert.equal((await service.getRecording(id)).meta.summaryProcessing, true);
  release({ title: "Smart title", summary: "Friday deadline", speakerNames: { 0: "Chris" } });
  await service.summaryJobs.get(id)?.promise;
  const detail = await service.getRecording(id);
  assert.equal(detail.meta.title, "Smart title");
  assert.equal(detail.meta.summary, "Friday deadline");
  assert.equal(detail.meta.speakerNames[0], "Chris");
  await service.summarizeRecording(id, settings);
  await service.summaryJobs.get(id)?.promise;
  assert.equal(calls.length, 1, "an existing summary does not trigger a second paid request");
});

test("Smart Meeting Summary retries a failed run and rejects local or active recordings", async t => {
  const { service, record, settings } = await notesFixture(t, async () => { throw new Error("Unavailable"); });
  const id = await record({ meetingNotes: { ...settings, enabled: false } });
  await service.summarizeRecording(id, settings);
  await service.summaryJobs.get(id)?.promise;
  assert.ok((await service.getRecording(id)).meta.summaryError);
  service.generateMeetingNotes = async () => ({ title: "Retried", summary: "Complete" });
  await service.summarizeRecording(id, settings);
  await service.summaryJobs.get(id)?.promise;
  const completed = await service.getRecording(id);
  assert.equal(completed.meta.summaryError, undefined);
  assert.equal(completed.meta.summaryProcessing, false);
  assert.equal(completed.meta.summary, "Complete");
  const live = await service.startRecording({ modelId: "gemini-transcribe-live-eu", sources: ["microphone"] });
  await assert.rejects(service.summarizeRecording(live.id, settings), /Finish recording/);
  await service.stopRecording(live.id);
  await assert.rejects(service.summarizeRecording(live.id, settings), /no transcript/);
  service.loadedModel = { modelId: "whisper-tiny", language: "de" };
  const local = await record({ modelId: "whisper-tiny" });
  await assert.rejects(service.summarizeRecording(local, settings), /requires a cloud recording/);
});

test("summary retry reports a disconnected server and recovers without reopening capture", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  const info = { running: true, baseUrl: "http://127.0.0.1:1234", clientToken: "fixture" };
  const { service, record, settings } = await notesFixture(t, (input, signal) =>
    requestRecorderServer(info, "/transcription/summary", input, signal));
  const id = await record({ meetingNotes: { ...settings, enabled: false } });
  const before = await service.updateSavedTranscript(id, saved => ({ ...saved, meta: { ...saved.meta,
    status: "error", error: "Live transcription was interrupted.", speakerError: "fetch failed" } }));
  await service.summarizeRecording(id, settings);
  await service.summaryJobs.get(id)?.promise;
  const failed = await service.getRecording(id);
  assert.equal(failed.meta.summaryProcessing, false);
  assert.match(failed.meta.summaryError, /disconnected.*Settings.*reconnect/);
  assert.doesNotMatch(failed.meta.summaryError, /model.*settings/);
  assert.equal(service.summaryJobs.has(id), false, "a failed job cannot block the next retry");

  fetchMock.mock.mockImplementation(async () => Response.json({ summary: "Saved transcript summarized." }));
  await service.summarizeRecording(id, settings);
  await service.summaryJobs.get(id)?.promise;
  const retried = await service.getRecording(id);
  assert.equal(retried.meta.summary, "Saved transcript summarized.");
  assert.equal(retried.meta.summaryError, undefined);
  assert.equal(retried.meta.status, "error", "summarizing does not hide the original recording failure");
  assert.deepEqual(retried.segments, before.segments);
  assert.equal(service.activeRecordings.size, 0);
  assert.equal(fetchMock.mock.callCount(), 2, "one request per explicit retry");
});

test("recorder requests distinguish connection loss, access denial and cloud failure without exposing response bodies", async t => {
  const info = { running: true, baseUrl: "http://127.0.0.1:1234", clientToken: "fixture" };
  await assert.rejects(requestRecorderServer({ ...info, running: false }, "/transcription/settings"), /disconnected/);
  const request = t.mock.method(globalThis, "fetch", async () => new Response("private provider error", { status: 403 }));
  await assert.rejects(requestRecorderServer(info, "/transcription/summary", {}), error =>
    error instanceof RecorderRequestError && /access was denied/.test(error.message) && !error.message.includes("private"));
  request.mock.mockImplementation(async () => new Response("private provider error", { status: 503 }));
  await assert.rejects(requestRecorderServer(info, "/transcription/summary", {}), /cloud request failed.*Try again/);
  request.mock.mockImplementation(async () => { throw new TypeError("fetch failed"); });
  const aborted = AbortSignal.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(requestRecorderServer(info, "/transcription/summary", {}, aborted), /Cancelled/);
});

test("deleting a recording cancels manually requested Smart Meeting Summary", async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let aborted = false;
  const { service, record, settings } = await notesFixture(t, (_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    entered();
  }));
  const id = await record({ meetingNotes: { ...settings, enabled: false } });
  await service.summarizeRecording(id, settings);
  await started;
  await service.deleteRecording(id);
  assert.equal(aborted, true);
  assert.equal(service.summaryJobs.size, 0);
  assert.equal(await service.getRecording(id), null);
});

test("manual title and speaker edits survive a pending notes response", async t => {
  /** @type {(value: { title: string, summary: string, speakerNames: Record<string, string> }) => void} */
  let release = (_value) => { assert.fail("the notes request must be waiting for its response"); };
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { service, record } = await notesFixture(t, async () => {
    entered();
    return new Promise(resolve => { release = resolve; });
  });
  const id = await record();
  await started;
  await service.renameRecording(id, "My meeting name");
  await service.editTranscript(id, { type: "rename-speaker", speaker: 0, name: "My speaker name" });
  release({ title: "Automatic name", summary: "Agreed Friday.", speakerNames: { 0: "Automatic speaker" } });
  await service.summaryJobs.get(id).promise;
  const detail = await service.getRecording(id);
  assert.equal(detail.meta.title, "My meeting name");
  assert.equal(detail.meta.summary, "Agreed Friday.");
  assert.equal(detail.meta.speakerNames[0], "My speaker name");
});

test("final acoustic reconciliation merges one input's identities and persists journal corrections", async t => {
  const { service } = await notesFixture(t, async () => ({}));
  const meta = await service.startRecording({ modelId: "gemini-transcribe-live-eu", sources: ["microphone", "system"], separateSources: true });
  const streamId = `${meta.id}:system`;
  service.handleWorkerMessage({ type: "segment", streamId: `${meta.id}:microphone`, id: "mic", text: "Local", startMs: 0, endMs: 4000 });
  for (const { id, startMs } of [{ id: "first", startMs: 0 }, { id: "second", startMs: 8000 }]) {
    service.handleWorkerMessage({ type: "segment", streamId, id, text: id, startMs, endMs: startMs + 4000 });
  }
  service.handleWorkerMessage({ type: "speaker-turns", voicesVerified: true, streamId, startMs: 0, endMs: 16000,
    turns: [{ startMs: 0, endMs: 4000, speaker: 0 }, { startMs: 8000, endMs: 12000, speaker: 1 }] });
  assert.equal((await service.getRecording(meta.id)).segments.at(-1).speaker, 2);
  service.handleWorkerMessage({ type: "speaker-merge", streamId, aliases: { 1: 0 } });
  const saved = await service.stopRecording(meta.id);
  await fsp.rm(path.join(saved.folderPath, "transcript.json"));
  const recovered = await service.getRecording(meta.id);
  assert.deepEqual(recovered.segments.map(s => s.speaker), [0, 1, 1]);
  assert.deepEqual(recovered.meta.speakerNames, { 0: "Microphone", 1: "System audio" });
});

test("late aligned words cannot move after the next caption on the same input", async t => {
  const { service } = await notesFixture(t, async () => ({}));
  const meta = await service.startRecording({ modelId: "gemini-transcribe-live-eu", sources: ["microphone", "system"], separateSources: true });
  const streamId = `${meta.id}:microphone`;
  service.handleWorkerMessage({ type: "segment", streamId, id: "first", text: "First ending.", startMs: 0, endMs: 8000 });
  service.handleWorkerMessage({ type: "segment", streamId, id: "second", text: "Next caption.", startMs: 7000, endMs: 10000 });
  service.handleWorkerMessage({ type: "speaker-turns", voicesVerified: true, streamId, startMs: 0, endMs: 15000,
    turns: [{ startMs: 0, endMs: 2000, speaker: 0 }, { startMs: 8000, endMs: 9000, speaker: 1 }],
    words: [{ text: "First", startMs: 1000, endMs: 2000, speaker: 0 }, { text: "ending", startMs: 8000, endMs: 9000, speaker: 1 }] });
  await service.stopRecording(meta.id);
  const detail = await service.getRecording(meta.id);
  assert.equal(detail.segments.map(segment => segment.text).join(" "), "First ending. Next caption.");
  assert.ok(detail.segments.every((segment, i, segments) => !i || segment.startMs >= segments[i - 1].startMs));
});

test("notes failure preserves the recording and deletion cancels a pending request", async t => {
  const { service, record } = await notesFixture(t, async () => { throw new Error("provider error"); });
  const failed = await record();
  await service.summaryJobs.get(failed)?.promise;
  const detail = await service.getRecording(failed);
  assert.equal(detail.meta.status, "complete");
  assert.equal(detail.meta.summaryProcessing, false);
  assert.ok(detail.meta.summaryError);
  assert.equal(detail.segments[0].text, "The deadline is Friday.");
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  service.generateMeetingNotes = (_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    entered();
  });
  const pending = await record();
  await started;
  await service.deleteRecording(pending);
  assert.equal(await service.getRecording(pending), null);
  assert.equal(service.summaryJobs.size, 0);
});

test("the capture worklet advances both input clocks even when one track has no samples", async () => {
  const source = await fsp.readFile(new URL("../../app/src/react-app/domains/recorder/capture.ts", import.meta.url), "utf8");
  const samples = Number(source.match(/const PCM_BATCH_SAMPLES = (\d+)/)?.[1]);
  const code = source.match(/const PCM_WORKLET_SOURCE = `([\s\S]*?)`;/)?.[1];
  assert.ok(samples && code);
  /** @type {{ processor?: new () => { process(inputs: Float32Array[][]): boolean, port: { onmessage(event: { data: string }): void }, messages: unknown[] } }} */
  const registered = {};
  runInNewContext(code.replaceAll("${PCM_BATCH_SAMPLES}", String(samples)), {
    Float32Array,
    AudioWorkletProcessor: class {
      constructor() { this.messages = []; this.port = { postMessage: message => this.messages.push(message) }; }
    },
    registerProcessor: (_name, constructor) => { registered.processor = constructor; },
  });
  const Processor = registered.processor;
  assert.ok(Processor, "the worklet must register its processor");
  const mic = new Processor();
  const system = new Processor();
  mic.process([[new Float32Array(128).fill(.25)]]);
  mic.process([[]]);
  mic.process([[new Float32Array(128).fill(.5)]]);
  system.process([[new Float32Array(384).fill(.75)]]);
  for (const input of [mic, system]) input.port.onmessage({ data: "flush" });
  const delivered = input => input.messages.filter(message => message instanceof ArrayBuffer).flatMap(buffer => [...new Float32Array(buffer)]);
  assert.equal(delivered(mic).length, delivered(system).length);
  assert.deepEqual(delivered(mic), [...new Float32Array(128).fill(.25), ...new Float32Array(128), ...new Float32Array(128).fill(.5)]);
});
