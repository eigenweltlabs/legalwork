import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { DeferredCloudSpeakerPass } from "./deferred-cloud-speakers.mjs";
import { createDictationSpeechDetector } from "./dictation-speech.mjs";

const RATE = 16000;
const MAX_QUEUE = RATE * 2 * 30;
const SPEECH_PREROLL = RATE * 2 * 2;
const ROTATE_MS = 8 * 60_000;
const SPEAKER_TIMEOUT_MS = 55_000;

export function isCloudTranscriptionModel(modelId) {
  return modelId === "gemini-transcribe-live-eu" || modelId === "gemini-transcribe-live-us";
}

export function pcm16(buffer) {
  const samples = new Float32Array(buffer);
  const result = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const value = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
    result.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), index * 2);
  }
  return result;
}

/** Worker-compatible transport, so capture, shortcuts and transcript storage stay shared. */
export class CloudTranscriber extends EventEmitter {
  constructor({ modelId, language, resolveConnection, socketFactory = (url, options) => new WebSocket(url, options), rotateMs = ROTATE_MS, onSpeakerPass = null, createSpeechDetector = createDictationSpeechDetector }) {
    super();
    this.modelId = modelId;
    this.language = language;
    this.resolveConnection = resolveConnection;
    this.socketFactory = socketFactory;
    this.rotateMs = rotateMs;
    this.onSpeakerPass = onSpeakerPass;
    this.createSpeechDetector = createSpeechDetector;
    this.streams = new Map();
    this.stopped = false;
  }

  postMessage(message) {
    if (this.stopped) return;
    if (message.type === "load") queueMicrotask(() => this.emit("message", { type: "ready" }));
    if (message.type === "begin") {
      const stream = { id: message.streamId, mode: message.ephemeral ? "dictation" : "meeting",
        queue: [], queuedBytes: 0, sentSamples: 0, ending: false, rotating: false,
        ready: false, finished: false, cancelled: false, socket: null, timer: null, timeout: null,
        speakerPass: null, speechDetector: null };
      if (message.ephemeral && this.createSpeechDetector) {
        try { stream.speechDetector = this.createSpeechDetector(); }
        catch { console.warn("[transcription] Local speech detection unavailable; using cloud transcription."); }
      }
      if (!message.ephemeral && message.diarize) {
        try {
          stream.speakerPass = new DeferredCloudSpeakerPass({
            recognize: (audio, signal) => this.recognizeSpeakers(audio, signal),
            onTurns: result => this.emit("message", { type: "speaker-turns", streamId: stream.id, ...result }),
            onError: error => this.emit("message", { type: "diarize-error", streamId: stream.id, error }),
          });
        } catch {
          this.emit("message", { type: "diarize-error", streamId: stream.id, error: "Could not prepare speaker detection. Live transcription is still running." });
        }
      }
      this.streams.set(stream.id, stream);
      if (!stream.speechDetector) void this.connect(stream);
    }
    const stream = this.streams.get(message.streamId);
    if (message.type === "pcm" && stream && !stream.cancelled && !stream.finished) {
      const bytes = pcm16(message.buffer);
      stream.speakerPass?.feed(bytes);
      // Keep frames below the server's one-second bound, including imported capture chunks.
      for (let offset = 0; offset < bytes.length; offset += RATE * 2) {
        const frame = bytes.subarray(offset, offset + RATE * 2);
        stream.queue.push(frame);
        stream.queuedBytes += frame.length;
      }
      if (stream.speechDetector) {
        let speech = true;
        try { speech = stream.speechDetector.accept(message.buffer); }
        catch { /* An unavailable detector must never discard speech. */ }
        if (speech) {
          stream.speechDetector = null;
          void this.connect(stream);
        } else {
          // Retain the onset without accumulating minutes of leading silence.
          while (stream.queuedBytes > SPEECH_PREROLL) {
            const frame = stream.queue[0];
            const trim = Math.min(frame.length, stream.queuedBytes - SPEECH_PREROLL);
            if (trim === frame.length) stream.queue.shift();
            else stream.queue[0] = frame.subarray(trim);
            stream.queuedBytes -= trim;
          }
        }
      }
      if (stream.queuedBytes + (stream.socket?.bufferedAmount ?? 0) > MAX_QUEUE) {
        this.fail(stream, "Cloud transcription could not keep up. Your recording is saved on this device.");
      } else this.flush(stream);
    }
    if (message.type === "finalize" && stream) {
      stream.ending = true;
      if (stream.speechDetector) {
        let speech = true;
        try { speech = stream.speechDetector.finish(); }
        catch { /* Preserve the recording if local detection fails. */ }
        stream.speechDetector = null;
        if (!speech) { void this.finish(stream); return; }
        void this.connect(stream);
        return;
      }
      // A quick empty dictation has nothing to drain, even if connection
      // setup is still pending. Never classify quiet PCM as empty audio.
      if (stream.mode === "dictation" && stream.sentSamples === 0 && stream.queuedBytes === 0) void this.finish(stream);
      else this.flush(stream);
    }
    if (message.type === "drop" && stream && !stream.cancelled) {
      stream.cancelled = true;
      stream.speakerPass?.stop();
      clearTimeout(stream.timer);
      if (!stream.socket) { this.dispose(stream); return; }
      if (stream.ready) stream.socket.send(JSON.stringify({ type: "cancel" }));
      else stream.socket?.close();
      stream.timeout = setTimeout(() => this.dispose(stream), 25_000);
    }
    if (message.type === "stop") this.kill();
  }

  async connect(stream) {
    try {
      const connection = await this.resolveConnection(this.modelId);
      if (this.stopped || stream.cancelled || stream.finished) return;
      const url = new URL(connection.url);
      url.searchParams.set("language", this.language);
      url.searchParams.set("mode", stream.mode);
      url.searchParams.set("offsetMs", String(Math.round(stream.sentSamples * 1000 / RATE)));
      const socket = this.socketFactory(url.toString(), { headers: { Authorization: `Bearer ${connection.apiKey}` },
        handshakeTimeout: 15_000, maxPayload: 1024 * 1024, followRedirects: false });
      stream.socket = socket;
      stream.timeout = setTimeout(() => this.fail(stream, "Cloud transcription could not connect."), 25_000);
      socket.on("message", raw => {
        if (stream.socket !== socket || stream.finished) return;
        try {
          const event = JSON.parse(String(raw));
          if (event.type === "ready") {
            clearTimeout(stream.timeout);
            stream.ready = true;
            stream.rotating = false;
            stream.timer = setTimeout(() => {
              if (stream.finished || stream.cancelled || stream.ending) return;
              stream.rotating = true;
              stream.ready = false;
              socket.send(JSON.stringify({ type: "finish" }));
              stream.timeout = setTimeout(() => this.fail(stream, "Cloud transcription could not continue."), 25_000);
            }, this.rotateMs);
            this.flush(stream);
          } else if (event.type === "partial" || event.type === "segment") {
            if (!stream.cancelled && typeof event.text === "string" && Number.isFinite(event.startMs) && Number.isFinite(event.endMs)) {
              this.emit("message", { ...event, streamId: stream.id, speaker: null });
            }
          } else if (event.type === "done") {
            clearTimeout(stream.timer);
            clearTimeout(stream.timeout);
            stream.ready = false;
            stream.socket = null;
            socket.close();
            if (stream.cancelled) this.dispose(stream);
            else if (stream.rotating && (!stream.ending || stream.queue.length)) void this.connect(stream);
            else {
              void this.finish(stream);
            }
          } else if (event.type === "error") {
            this.fail(stream, typeof event.error === "string" ? event.error : "Cloud transcription failed.");
          }
        } catch { this.fail(stream, "Cloud transcription returned an invalid response."); }
      });
      socket.on("error", () => {
        if (stream.socket === socket) this.fail(stream, "Cloud transcription is unavailable. Check your connection or choose local transcription.");
      });
      socket.on("close", () => {
        if (stream.socket === socket && !stream.finished && !stream.cancelled) this.fail(stream, "Cloud transcription disconnected. Your recording is saved on this device.");
      });
    } catch (error) {
      this.fail(stream, error instanceof Error ? error.message : "Cloud transcription is unavailable.");
    }
  }

  async recognizeSpeakers(audio, signal) {
    const connection = await this.resolveConnection(this.modelId);
    if (signal.aborted) throw new Error("Speaker detection cancelled");
    const url = new URL(connection.url);
    if (!url.pathname.endsWith("/transcription/live")) throw new Error("Cloud speaker detection is unavailable.");
    url.pathname = url.pathname.replace(/\/live$/, "/diarize");
    url.searchParams.set("language", this.language);
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(url.toString(), { headers: { Authorization: `Bearer ${connection.apiKey}` },
        handshakeTimeout: 15_000, maxPayload: 1024 * 1024, followRedirects: false });
      let settled = false;
      const finish = (error, words = []) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        socket.close();
        if (error) reject(error);
        else resolve(words);
      };
      const abort = () => finish(new Error("Speaker detection cancelled"));
      const timer = setTimeout(() => finish(new Error("Cloud speaker detection took too long. The transcript will be kept.")), SPEAKER_TIMEOUT_MS);
      signal.addEventListener("abort", abort, { once: true });
      socket.on("open", () => { if (!settled) socket.send(audio); });
      socket.on("message", raw => {
        try {
          const event = JSON.parse(String(raw));
          if (event.type !== "speakers" || !Array.isArray(event.words) || event.words.length > 5000 || event.words.some(word =>
            !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs <= word.startMs ||
            word.endMs > audio.length / 32 + 100 || typeof word.speaker !== "string" || word.speaker.length > 64 ||
            (word.text !== undefined && (typeof word.text !== "string" || word.text.length > 512)))) {
            throw new Error("Cloud speaker detection is unavailable. The transcript will be kept.");
          }
          finish(null, event.words);
        } catch (error) { finish(error); }
      });
      socket.on("error", () => finish(new Error("Cloud speaker detection is unavailable. The transcript will be kept.")));
      socket.on("close", () => finish(new Error("Cloud speaker detection disconnected. The transcript will be kept.")));
    });
  }

  async finish(stream) {
    // The recorder owns detached passes so changing the capture model cannot
    // cancel speaker detection for an earlier, already saved recording.
    if (stream.speakerPass && this.onSpeakerPass && !stream.cancelled) {
      this.onSpeakerPass(stream.id, stream.speakerPass);
      stream.speakerPass = null;
    } else await stream.speakerPass?.finish();
    if (!stream.finished && !stream.cancelled) this.emit("message", { type: "finalized", streamId: stream.id });
    this.dispose(stream);
  }

  flush(stream) {
    if (!stream.ready || stream.cancelled || stream.finished) return;
    while (stream.queue.length) {
      const frame = stream.queue.shift();
      stream.queuedBytes -= frame.length;
      stream.sentSamples += frame.length / 2;
      stream.socket.send(frame);
    }
    if (stream.ending) {
      stream.ready = false;
      clearTimeout(stream.timer);
      stream.socket.send(JSON.stringify({ type: "finish" }));
      stream.timeout = setTimeout(() => this.fail(stream, "Cloud transcription did not finish. Your recording is saved on this device."), 25_000);
    }
  }

  fail(stream, error) {
    if (stream.finished || stream.cancelled) return;
    this.emit("message", { type: "stream-error", streamId: stream.id, error });
    this.dispose(stream);
  }

  dispose(stream) {
    stream.finished = true;
    stream.speechDetector = null;
    stream.speakerPass?.stop();
    clearTimeout(stream.timer);
    clearTimeout(stream.timeout);
    stream.socket?.close();
    stream.queue.length = 0;
    this.streams.delete(stream.id);
  }

  kill() {
    this.stopped = true;
    for (const stream of this.streams.values()) this.dispose(stream);
  }
}
