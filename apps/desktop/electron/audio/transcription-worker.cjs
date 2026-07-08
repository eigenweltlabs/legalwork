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

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512; // Silero v4/v5 window at 16 kHz
const MAX_SPEECH_SECONDS = 18; // force-split long monologues (Parakeet caps ~20 s)
const PARTIAL_INTERVAL_SAMPLES = SAMPLE_RATE * 1.5;
const PARTIAL_MAX_SAMPLES = SAMPLE_RATE * 15;

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

function send(message) {
  try {
    port.postMessage(message);
  } catch {
    // parent gone — nothing sensible to do
  }
}

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
  }
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
    const segment = state.vad.front();
    state.vad.pop();
    const startMs = msFromSamples(segment.start);
    const endMs = msFromSamples(segment.start + segment.samples.length);
    const generation = ++state.partialGeneration;
    // The finalized VAD segment supersedes any partial for this speech run.
    state.speechChunks = [];
    state.speechChunkSamples = 0;
    state.samplesSincePartial = 0;
    const samples = segment.samples;
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
  if (!recognizer) return;
  let state = streams.get(message.streamId);
  if (!state) {
    state = new StreamState(message.streamId);
    streams.set(message.streamId, state);
  }
  feedPcm(state, new Float32Array(message.buffer));
}

function handleFinalize(message) {
  const state = streams.get(message.streamId);
  if (!state) {
    send({ type: "finalized", streamId: message.streamId });
    return;
  }
  streams.delete(message.streamId);
  try {
    state.vad.flush();
    drainVadSegments(state);
  } catch {
    // flush is best-effort; segments so far are already out
  }
  // finalized must trail every queued decode of this stream.
  void enqueueDecode(async () => {
    send({ type: "finalized", streamId: message.streamId });
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
    case "finalize":
      handleFinalize(message);
      break;
    case "drop":
      streams.delete(message.streamId);
      break;
    case "stop":
      process.exit(0);
      break;
    default:
      break;
  }
});

send({ type: "booted" });
