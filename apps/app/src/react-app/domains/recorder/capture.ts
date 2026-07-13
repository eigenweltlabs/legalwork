/**
 * Audio capture engine for the Recorder tab.
 *
 * Builds one WebAudio graph per recording:
 *
 *   microphone (getUserMedia) ─┐
 *                              ├→ mix → MediaStreamDestination → MediaRecorder (audio.webm on disk)
 *   system audio (loopback) ───┘        └→ AudioWorklet → 16 kHz mono Float32 PCM → local transcriber
 *
 * The AudioContext itself runs at 16 kHz so Chromium does the resampling and
 * the worklet only has to batch mono frames. System audio arrives through
 * `getDisplayMedia` with a loopback track: on Windows Chromium's WASAPI
 * loopback handles it natively; on macOS/Linux the main process enables the
 * matching Chromium feature flags and answers the request via
 * `setDisplayMediaRequestHandler` (see apps/desktop/electron/audio/loopback.mjs).
 */

import { audioLoopbackDisable, audioLoopbackEnable } from "@/app/lib/desktop";
import type { AudioCaptureSourceKind } from "@legalwork/types/audio";

const TARGET_SAMPLE_RATE = 16000;
const PCM_BATCH_SAMPLES = 4096; // 256 ms at 16 kHz

/** Inline worklet: batch mono 128-frame quanta into PCM_BATCH_SAMPLES chunks. */
const PCM_WORKLET_SOURCE = `
class LegalworkPcmBatcher extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${PCM_BATCH_SAMPLES});
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(read, read + take), this.offset);
      this.offset += take;
      read += take;
      if (this.offset === this.buffer.length) {
        const out = this.buffer;
        this.port.postMessage(out.buffer, [out.buffer]);
        this.buffer = new Float32Array(${PCM_BATCH_SAMPLES});
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("legalwork-pcm-batcher", LegalworkPcmBatcher);
`;

/**
 * Decode an imported audio file (mp3/wav/m4a/aac/flac/ogg/webm…) to 16 kHz mono
 * Float32 PCM using Web Audio — the same shape the live capture worklet emits,
 * so the transcription worker treats it identically. The main process has no
 * bundled audio decoder, which is why this happens in the renderer.
 */
export async function decodeAudioFileToPcm16k(
  file: Blob,
): Promise<{ pcm: Float32Array; durationMs: number }> {
  const bytes = await file.arrayBuffer();
  // decodeAudioData detaches its input; hand it a copy so `bytes` stays usable.
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes.slice(0));
  } finally {
    await decodeCtx.close().catch(() => {});
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  // OfflineAudioContext(1, …, 16000) downmixes to mono AND resamples to 16 kHz.
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return { pcm: rendered.getChannelData(0), durationMs: Math.round(decoded.duration * 1000) };
}

export type CaptureLevels = Partial<Record<AudioCaptureSourceKind, number>>;

export type CaptureHandle = {
  stop: () => Promise<void>;
  readLevels: () => CaptureLevels;
};

export type CaptureCallbacks = {
  onPcm: (chunk: ArrayBuffer) => void;
  onMediaChunk: (chunk: ArrayBuffer) => void;
  /** A source track ended outside our control (e.g. device unplugged). */
  onSourceEnded: (source: AudioCaptureSourceKind) => void;
};

/**
 * Microphone constraints tuned for ASR, not telephony. Chromium's
 * autoGainControl / noiseSuppression / echoCancellation non-linearly distort
 * the waveform (gain pumping, spectral smearing) and measurably hurt
 * transcription accuracy — native dictation tools (Handy, OpenWhispr) capture
 * raw audio with none of it. So for microphone-only capture we turn all three
 * off. When system/app audio is also captured (call recording), the speaker
 * output can leak back into the mic, so echo cancellation earns its place
 * there; noise suppression / AGC stay off to protect accuracy.
 */
function micConstraints(withEchoCancellation: boolean): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: withEchoCancellation,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  };
}

/** Resolve once the track is delivering audio, or false if it never does. */
function waitForLiveTrack(track: MediaStreamTrack): Promise<boolean> {
  if (track.readyState === "live" && !track.muted) return Promise.resolve(true);
  if (track.readyState === "ended") return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const settle = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      track.removeEventListener("unmute", onUnmute);
      track.removeEventListener("ended", onEnded);
      resolve(value);
    };
    const onUnmute = () => settle(true);
    const onEnded = () => settle(false);
    const timer = setTimeout(() => settle(track.readyState === "live" && !track.muted), 600);
    track.addEventListener("unmute", onUnmute);
    track.addEventListener("ended", onEnded);
  });
}

/**
 * After the machine sat idle or woke from sleep, getUserMedia can hand back a
 * track that stays muted or is already ended and yields pure silence. Wait
 * briefly for it to come alive; if it doesn't, reacquire the device once and
 * re-check. If it still isn't delivering audio, fail loudly rather than
 * record silence — startRecording's rollback then surfaces it to the user.
 */
async function ensureLiveMicStream(
  stream: MediaStream,
  constraints: MediaStreamConstraints,
): Promise<MediaStream> {
  const track = stream.getAudioTracks()[0];
  if (!track) return stream;
  if (await waitForLiveTrack(track)) return stream;

  for (const stale of stream.getTracks()) stale.stop();
  const retry = await navigator.mediaDevices.getUserMedia(constraints);
  const retryTrack = retry.getAudioTracks()[0];
  if (retryTrack && (await waitForLiveTrack(retryTrack))) return retry;

  for (const stale of retry.getTracks()) stale.stop();
  throw new Error(
    "The microphone did not start delivering audio. This can happen right after the computer wakes. Try dictating again.",
  );
}

async function requestMicStream(withEchoCancellation: boolean): Promise<MediaStream> {
  const ask = window.__LEGALWORK_ELECTRON__?.system?.askMicrophoneAccess;
  if (ask) {
    const result = await ask();
    if (result.platform === "darwin" && !result.granted) {
      throw new Error(
        "macOS denied microphone access. Enable LegalWork under System Settings → Privacy & Security → Microphone, then restart.",
      );
    }
  }
  const constraints = micConstraints(withEchoCancellation);
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return ensureLiveMicStream(stream, constraints);
}

async function requestSystemStream(): Promise<MediaStream> {
  await audioLoopbackEnable();
  try {
    // Chromium requires video:true on getDisplayMedia even when only the
    // loopback audio track is wanted; the video track is stopped right away.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    if (stream.getAudioTracks().length === 0) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error(
        "System audio track unavailable. On macOS 13+ allow Screen & System Audio Recording for LegalWork; on older systems system audio capture is not supported.",
      );
    }
    return stream;
  } finally {
    // Restore default screen-share behavior for the rest of the app.
    await audioLoopbackDisable().catch(() => {});
  }
}

export async function startCapture(
  sources: AudioCaptureSourceKind[],
  callbacks: CaptureCallbacks,
): Promise<CaptureHandle> {
  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const streams = new Map<AudioCaptureSourceKind, MediaStream>();
  const analysers = new Map<AudioCaptureSourceKind, AnalyserNode>();
  let recorder: MediaRecorder | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let stopped = false;

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    try {
      workletNode?.port.close();
      workletNode?.disconnect();
    } catch {
      // context teardown races are fine
    }
    for (const stream of streams.values()) {
      for (const track of stream.getTracks()) track.stop();
    }
    streams.clear();
    await context.close().catch(() => {});
  };

  try {
    // A context created while every window is hidden/unfocused can start out
    // suspended; the graph would build fine and record silence.
    if (context.state === "suspended") await context.resume().catch(() => {});

    const workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    // Echo cancellation on the mic only matters when the machine is also
    // playing captured system audio that could leak back into it.
    const hasOtherSources = sources.includes("system");
    if (sources.includes("microphone")) {
      streams.set("microphone", await requestMicStream(hasOtherSources));
    }
    if (sources.includes("system")) {
      streams.set("system", await requestSystemStream());
    }
    if (streams.size === 0) throw new Error("No audio sources selected.");

    const mix = context.createGain();
    for (const [kind, stream] of streams) {
      const sourceNode = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      sourceNode.connect(analyser);
      sourceNode.connect(mix);
      analysers.set(kind, analyser);
      const audioTrack = stream.getAudioTracks()[0];
      audioTrack?.addEventListener("ended", () => {
        if (!stopped) callbacks.onSourceEnded(kind);
      });
    }

    // When several sources are summed, two loud ones can overshoot [-1,1] and
    // Web Audio hard-clips at the destination — square-wave distortion the ASR
    // reads as garbage. Trim and limit the mix so peaks are caught, not
    // clipped. A single clean source is left untouched (no dynamics change).
    let bus: AudioNode = mix;
    const multiSource = sources.length > 1;
    if (multiSource) {
      const trim = context.createGain();
      trim.gain.value = 0.7;
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      mix.connect(trim);
      trim.connect(limiter);
      bus = limiter;
    }

    // PCM branch → local transcriber.
    workletNode = new AudioWorkletNode(context, "legalwork-pcm-batcher", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    workletNode.port.onmessage = (event) => {
      if (!stopped && event.data instanceof ArrayBuffer) callbacks.onPcm(event.data);
    };
    bus.connect(workletNode);

    // Compressed branch → audio.webm on disk.
    const destination = context.createMediaStreamDestination();
    bus.connect(destination);
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    recorder = new MediaRecorder(destination.stream, { mimeType, audioBitsPerSecond: 48_000 });
    // Track in-flight blob→ArrayBuffer conversions so stop() can await the
    // final chunk (the one carrying the webm cues) before tearing down.
    const pendingChunkWrites = new Set<Promise<void>>();
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const write = event.data
        .arrayBuffer()
        .then((buffer) => callbacks.onMediaChunk(buffer))
        .catch(() => {})
        .finally(() => pendingChunkWrites.delete(write));
      pendingChunkWrites.add(write);
    };
    recorder.start(1000);

    const levelData = new Uint8Array(256);
    return {
      readLevels: () => {
        const levels: CaptureLevels = {};
        for (const [kind, analyser] of analysers) {
          analyser.getByteTimeDomainData(levelData);
          let peak = 0;
          for (const value of levelData) {
            peak = Math.max(peak, Math.abs(value - 128) / 128);
          }
          levels[kind] = peak;
        }
        return levels;
      },
      stop: async () => {
        // Flush the encoder before the graph goes away so the final webm
        // chunk (containing the cues) reaches disk.
        const activeRecorder = recorder;
        if (activeRecorder && activeRecorder.state !== "inactive") {
          await new Promise<void>((resolve) => {
            activeRecorder.addEventListener("stop", () => resolve(), { once: true });
            activeRecorder.stop();
          });
        }
        // The last ondataavailable resolves its blob asynchronously — wait
        // for every queued chunk before the caller finalizes the file.
        while (pendingChunkWrites.size > 0) {
          await Promise.all(Array.from(pendingChunkWrites));
        }
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
