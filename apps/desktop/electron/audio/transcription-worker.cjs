/**
 * Local transcription worker — runs inside an Electron utilityProcess.
 *
 * Loads sherpa-onnx (native N-API addon, prebuilt per platform) and turns a
 * 16 kHz mono Float32 PCM stream into transcript segments using the same
 * recipe as MacWhisper's live captions:
 *
 *   PCM → Silero VAD (speech segmentation) → offline recognizer
 *   (Whisper or NVIDIA Parakeet) → final segments with timestamps.
 *
 * While speech is still in progress the current speech buffer is re-decoded
 * every ~1.5 s of audio to produce partial captions, which the final VAD
 * segment then replaces. Runs out-of-process so a native crash or a slow
 * decode can never wedge the Electron main process.
 *
 * Protocol (postMessage both ways):
 *   in : { type: "load", model, vadPath, language, numThreads }
 *   in : { type: "pcm", streamId, buffer: ArrayBuffer }   // Float32 samples
 *   in : { type: "finalize", streamId }                   // flush + close stream
 *   in : { type: "drop", streamId }                       // discard stream state
 *   out: { type: "ready" } | { type: "load-error", error }
 *   out: { type: "partial" | "segment", streamId, text, startMs, endMs }
 *   out: { type: "finalized", streamId }
 */

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");

const SAMPLE_RATE = 16000;
// Reading the whole recording back for diarization costs ~4 bytes/sample of
// RAM plus a copy; cap so a marathon recording can't OOM the worker. Beyond
// this, transcription still completes — only speaker labels are skipped.
const MAX_DIARIZE_SAMPLES = SAMPLE_RATE * 60 * 60; // 60 minutes
const VAD_WINDOW = 512; // Silero v4/v5 window at 16 kHz
const MAX_SPEECH_SECONDS = 18; // force-split long monologues (Parakeet caps ~20 s)
const PARTIAL_INTERVAL_SAMPLES = SAMPLE_RATE * 1.5;
const PARTIAL_MAX_SAMPLES = SAMPLE_RATE * 15;
// Silero cuts speech at the exact on/offset, so a transducer loses the first
// ~100-300 ms of a word and drops or garbles it. Decode a little raw audio
// from before/after each VAD segment (kept in a rolling ring) so onsets and
// tails survive; the reported timestamps still cover only the speech itself.
const PREROLL_SAMPLES = Math.round(SAMPLE_RATE * 0.3);
const HANGOVER_SAMPLES = Math.round(SAMPLE_RATE * 0.3);
const RING_SAMPLES = SAMPLE_RATE * 30; // covers maxSpeech (18 s) + padding

// Electron utilityProcess exposes process.parentPort; plain-node forks (unit
// tests) fall back to the classic child-process channel with the same shape.
const port = process.parentPort ?? {
  postMessage: (message) => process.send?.(message),
  on: (eventName, callback) => {
    if (eventName === "message") process.on("message", (data) => callback({ data }));
  },
};

let sherpa = null;
let recognizer = null;
let vadConfig = null;
let decodeQueue = Promise.resolve();
/** @type {Map<string, StreamState>} */
const streams = new Map();
let segmentCounter = 0;
/**
 * Per-stream diarization sinks: while a recording is diarize-armed, its raw
 * 16 kHz mono PCM is teed to a temp .f32 file, then read back and run through
 * OfflineSpeakerDiarization at finalize.
 * @type {Map<string, { path: string, stream: import('node:fs').WriteStream, segModel: string, embModel: string, threshold: number, samples: number }>}
 */
const diarSinks = new Map();
/** Cache diarizers by model+threshold so back-to-back recordings reuse them. */
const diarizers = new Map();

function send(message) {
  try {
    port.postMessage(message);
  } catch {
    // parent gone — nothing sensible to do
  }
}

// A native-addon throw (e.g. Electron's "External buffers are not allowed")
// must reach the UI as a readable error, not a silent exit-code-1. Report,
// then die so the service can respawn a clean process.
process.on("uncaughtException", (error) => {
  send({ type: "load-error", error: `Transcriber crashed: ${error?.message ?? String(error)}` });
  setTimeout(() => process.exit(1), 50);
});

class StreamState {
  constructor(streamId) {
    this.streamId = streamId;
    this.vad = new sherpa.Vad(vadConfig, 120);
    this.pending = new Float32Array(0); // < VAD_WINDOW leftover
    this.totalSamples = 0;
    this.speechChunks = [];
    this.speechChunkSamples = 0;
    this.speechStartSample = 0;
    this.inSpeech = false;
    this.samplesSincePartial = 0;
    this.partialGeneration = 0;
    // Rolling raw-audio ring for onset/tail padding (see PREROLL_SAMPLES).
    this.ring = new Float32Array(RING_SAMPLES);
    this.ringHead = 0;
    this.ringCount = 0;
  }
}

/** Append a window of raw samples to the stream's rolling ring buffer. */
function pushRing(state, window) {
  const ring = state.ring;
  const size = ring.length;
  let head = state.ringHead;
  for (let i = 0; i < window.length; i++) {
    ring[head] = window[i];
    head = head + 1 === size ? 0 : head + 1;
  }
  state.ringHead = head;
  state.ringCount = Math.min(state.ringCount + window.length, size);
}

/**
 * Read absolute sample range [startAbs, endAbs) from the ring, clamped to
 * what it still holds (the newest RING_SAMPLES ending at state.totalSamples).
 */
function ringSlice(state, startAbs, endAbs) {
  const ring = state.ring;
  const size = ring.length;
  const ringEndAbs = state.totalSamples;
  const ringStartAbs = ringEndAbs - state.ringCount;
  const a = Math.max(startAbs, ringStartAbs, 0);
  const b = Math.min(endAbs, ringEndAbs);
  if (b <= a) return new Float32Array(0);
  const out = new Float32Array(b - a);
  for (let i = 0; i < out.length; i++) {
    let pos = (state.ringHead - (ringEndAbs - (a + i))) % size;
    if (pos < 0) pos += size;
    out[i] = ring[pos];
  }
  return out;
}

function configureRecognizer(model, language, numThreads) {
  const common = {
    tokens: model.files["tokens.txt"],
    numThreads: Math.max(1, numThreads | 0),
    provider: "cpu",
    debug: 0,
  };
  if (model.kind === "whisper") {
    return {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        ...common,
        whisper: {
          encoder: model.files["encoder.int8.onnx"],
          decoder: model.files["decoder.int8.onnx"],
          language: language === "auto" ? "" : language,
          task: "transcribe",
          tailPaddings: -1,
        },
      },
    };
  }
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      ...common,
      modelType: "nemo_transducer",
      transducer: {
        encoder: model.files["encoder.int8.onnx"],
        decoder: model.files["decoder.int8.onnx"],
        joiner: model.files["joiner.int8.onnx"],
      },
    },
  };
}

// Test hook: real VAD, canned recognizer — lets CI exercise the whole
// worker pipeline without gigabyte ASR models (see audio-recorder.test.mjs).
const FAKE_ASR = process.env.LEGALWORK_TRANSCRIBER_FAKE_ASR === "1";

async function handleLoad(message) {
  try {
    if (!sherpa) {
      // Lazy require so a missing platform package reports through
      // load-error instead of crashing the process at startup.
      sherpa = require("sherpa-onnx-node");
    }
    vadConfig = {
      sileroVad: {
        model: message.vadPath,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.5,
        maxSpeechDuration: MAX_SPEECH_SECONDS,
        windowSize: VAD_WINDOW,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    };
    if (FAKE_ASR) {
      recognizer = { fake: true };
    } else {
      const config = configureRecognizer(message.model, message.language, message.numThreads ?? 2);
      recognizer = await sherpa.OfflineRecognizer.createAsync(config);
    }
    streams.clear();
    send({ type: "ready" });
  } catch (error) {
    recognizer = null;
    send({ type: "load-error", error: error instanceof Error ? error.message : String(error) });
  }
}

/** Serialize decodes — one at a time keeps CPU predictable during calls. */
function enqueueDecode(task) {
  decodeQueue = decodeQueue.then(task, task);
  return decodeQueue;
}

async function decodeSamples(samples) {
  if (FAKE_ASR) {
    return `[decoded ${samples.length} samples]`;
  }
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  const result = await recognizer.decodeAsync(stream);
  return typeof result?.text === "string" ? result.text.trim() : "";
}

function concatChunks(chunks, totalLength) {
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function msFromSamples(sampleIndex) {
  return Math.round((sampleIndex / SAMPLE_RATE) * 1000);
}

function drainVadSegments(state) {
  while (!state.vad.isEmpty()) {
    // enableExternalBuffer=false: Electron forbids N-API external buffers
    // ("External buffers are not allowed"), and the default (true) made this
    // call throw — killing the worker on the first speech frame. The copy
    // into a V8-owned buffer is trivial next to the decode that follows.
    const segment = state.vad.front(false);
    state.vad.pop();
    const startMs = msFromSamples(segment.start);
    const endMs = msFromSamples(segment.start + segment.samples.length);
    const generation = ++state.partialGeneration;
    // The finalized VAD segment supersedes any partial for this speech run.
    state.speechChunks = [];
    state.speechChunkSamples = 0;
    state.samplesSincePartial = 0;
    // Decode the segment plus a little raw pre-roll/hangover so the first and
    // last words aren't clipped; fall back to the bare VAD samples if the ring
    // no longer holds the padded range.
    const speech = segment.samples;
    const padded = ringSlice(
      state,
      segment.start - PREROLL_SAMPLES,
      segment.start + speech.length + HANGOVER_SAMPLES,
    );
    const samples = padded.length >= speech.length ? padded : speech;
    void enqueueDecode(async () => {
      if (!recognizer) return;
      try {
        const text = await decodeSamples(samples);
        if (text) {
          send({
            type: "segment",
            streamId: state.streamId,
            id: `seg-${++segmentCounter}`,
            generation,
            text,
            startMs,
            endMs,
          });
        } else {
          // Nothing decodable (noise/music) — tell consumers so a partial
          // emitted for this speech run doesn't stay on screen forever.
          send({ type: "partial-clear", streamId: state.streamId, endMs });
        }
      } catch (error) {
        send({ type: "decode-error", streamId: state.streamId, error: String(error) });
      }
    });
  }
}

function maybeEmitPartial(state) {
  if (!state.inSpeech || state.samplesSincePartial < PARTIAL_INTERVAL_SAMPLES) return;
  if (state.speechChunkSamples < SAMPLE_RATE * 0.8) return;
  state.samplesSincePartial = 0;
  const generation = state.partialGeneration;
  let samples = concatChunks(state.speechChunks, state.speechChunkSamples);
  let startSample = state.speechStartSample;
  if (samples.length > PARTIAL_MAX_SAMPLES) {
    startSample += samples.length - PARTIAL_MAX_SAMPLES;
    samples = samples.subarray(samples.length - PARTIAL_MAX_SAMPLES);
  }
  const startMs = msFromSamples(startSample);
  const endMs = msFromSamples(state.speechStartSample + state.speechChunkSamples);
  void enqueueDecode(async () => {
    if (!recognizer) return;
    // A final segment landed while we waited — the partial is stale.
    if (generation !== state.partialGeneration) return;
    try {
      const text = await decodeSamples(samples);
      if (text && generation === state.partialGeneration) {
        send({ type: "partial", streamId: state.streamId, text, startMs, endMs });
      }
    } catch {
      // partials are best-effort
    }
  });
}

function feedPcm(state, samples) {
  // Stitch leftovers so the VAD always sees exact windows.
  let merged = samples;
  if (state.pending.length > 0) {
    merged = new Float32Array(state.pending.length + samples.length);
    merged.set(state.pending, 0);
    merged.set(samples, state.pending.length);
  }
  let offset = 0;
  while (offset + VAD_WINDOW <= merged.length) {
    const window = merged.subarray(offset, offset + VAD_WINDOW);
    state.vad.acceptWaveform(window);
    pushRing(state, window);
    const wasInSpeech = state.inSpeech;
    state.inSpeech = state.vad.isDetected();
    if (state.inSpeech) {
      if (!wasInSpeech) {
        state.speechChunks = [];
        state.speechChunkSamples = 0;
        state.speechStartSample = state.totalSamples;
        state.samplesSincePartial = 0;
        state.partialGeneration += 1;
      }
      state.speechChunks.push(Float32Array.from(window));
      state.speechChunkSamples += window.length;
      state.samplesSincePartial += window.length;
    }
    state.totalSamples += VAD_WINDOW;
    offset += VAD_WINDOW;
    drainVadSegments(state);
  }
  state.pending = merged.length > offset ? Float32Array.from(merged.subarray(offset)) : new Float32Array(0);
  maybeEmitPartial(state);
}

function handlePcm(message) {
  const sink = diarSinks.get(message.streamId);
  if (sink && sink.samples < MAX_DIARIZE_SAMPLES) {
    // Tee the raw Float32 bytes to disk verbatim (little-endian, 16 kHz mono).
    sink.stream.write(Buffer.from(message.buffer));
    sink.samples += message.buffer.byteLength / 4;
  }
  if (!recognizer) return;
  let state = streams.get(message.streamId);
  if (!state) {
    state = new StreamState(message.streamId);
    streams.set(message.streamId, state);
  }
  feedPcm(state, new Float32Array(message.buffer));
}

function handleDiarizeBegin(message) {
  if (diarSinks.has(message.streamId)) return;
  try {
    const stream = fs.createWriteStream(message.pcmPath);
    stream.on("error", () => {}); // disk error → diarization silently skipped
    diarSinks.set(message.streamId, {
      path: message.pcmPath,
      stream,
      segModel: message.segModel,
      embModel: message.embModel,
      threshold: typeof message.threshold === "number" ? message.threshold : 0.5,
      samples: 0,
    });
  } catch {
    // Couldn't open the sink — finalize just won't diarize.
  }
}

function diarizerFor(segModel, embModel, threshold) {
  const key = `${segModel}|${embModel}|${threshold}`;
  let diarizer = diarizers.get(key);
  if (!diarizer) {
    diarizer = new sherpa.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: segModel }, numThreads: 2, provider: "cpu", debug: 0 },
      embedding: { model: embModel, numThreads: 2, provider: "cpu", debug: 0 },
      clustering: { numClusters: -1, threshold },
      minDurationOn: 0.2,
      minDurationOff: 0.5,
    });
    diarizers.set(key, diarizer);
  }
  return diarizer;
}

/**
 * Read the teed PCM back and run diarization. Returns speaker turns in ms, or
 * null when diarization was not armed / not possible.
 * @returns {Promise<{ startMs: number, endMs: number, speaker: number }[] | null>}
 */
async function runDiarization(streamId) {
  const sink = diarSinks.get(streamId);
  if (!sink) return null;
  diarSinks.delete(streamId);
  await new Promise((resolve) => sink.stream.end(resolve));
  try {
    if (!sherpa) return null;
    if (sink.samples < SAMPLE_RATE || sink.samples > MAX_DIARIZE_SAMPLES) return null;
    const raw = await fsp.readFile(sink.path);
    // Copy into an aligned buffer whose length is a whole number of floats so
    // the Float32 view is always valid (a truncated tail float is dropped).
    const wholeBytes = raw.byteLength - (raw.byteLength % 4);
    const aligned = raw.buffer.slice(raw.byteOffset, raw.byteOffset + wholeBytes);
    const samples = new Float32Array(aligned);
    const diarizer = diarizerFor(sink.segModel, sink.embModel, sink.threshold);
    const turns = diarizer.process(samples);
    return (turns ?? []).map((turn) => ({
      startMs: Math.round(turn.start * 1000),
      endMs: Math.round(turn.end * 1000),
      speaker: turn.speaker | 0,
    }));
  } catch (error) {
    send({ type: "diarize-error", streamId, error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    void fsp.rm(sink.path, { force: true }).catch(() => {});
  }
}

function handleFinalize(message) {
  const state = streams.get(message.streamId);
  if (state) {
    streams.delete(message.streamId);
    try {
      state.vad.flush();
      drainVadSegments(state);
    } catch {
      // flush is best-effort; segments so far are already out
    }
  }
  // finalized must trail every queued decode of this stream, and the
  // (blocking) diarization pass runs after decoding so it never competes for
  // CPU with the transcript.
  void enqueueDecode(async () => {
    const speakers = await runDiarization(message.streamId);
    send({ type: "finalized", streamId: message.streamId, speakers });
  });
}

port.on("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "load":
      void handleLoad(message);
      break;
    case "pcm":
      handlePcm(message);
      break;
    case "diarize-begin":
      handleDiarizeBegin(message);
      break;
    case "finalize":
      handleFinalize(message);
      break;
    case "drop": {
      streams.delete(message.streamId);
      const sink = diarSinks.get(message.streamId);
      if (sink) {
        diarSinks.delete(message.streamId);
        sink.stream.end(() => void fsp.rm(sink.path, { force: true }).catch(() => {}));
      }
      break;
    }
    case "stop":
      process.exit(0);
      break;
    default:
      break;
  }
});

send({ type: "booted" });
