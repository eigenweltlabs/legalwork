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

import { audioLoopbackDisable, audioLoopbackEnable, audioTapStart, audioTapStop } from "@/app/lib/desktop";
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

async function requestMicStream(): Promise<MediaStream> {
  const ask = window.__LEGALWORK_ELECTRON__?.system?.askMicrophoneAccess;
  if (ask) {
    const result = await ask();
    if (result.platform === "darwin" && !result.granted) {
      throw new Error(
        "macOS denied microphone access. Enable LegalWork under System Settings → Privacy & Security → Microphone, then restart.",
      );
    }
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
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

export type CaptureOptions = {
  /** Process IDs for macOS per-app capture (empty = whole system mixdown). */
  appPids?: number[];
};

export async function startCapture(
  sources: AudioCaptureSourceKind[],
  callbacks: CaptureCallbacks,
  options: CaptureOptions = {},
): Promise<CaptureHandle> {
  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const streams = new Map<AudioCaptureSourceKind, MediaStream>();
  const analysers = new Map<AudioCaptureSourceKind, AnalyserNode>();
  let recorder: MediaRecorder | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let stopAppTap: (() => void) | null = null;
  let stopped = false;

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    try {
      stopAppTap?.();
    } catch {
      // tap teardown is best-effort
    }
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

  /**
   * macOS per-app audio: the native tap streams mono Float32 PCM at its own
   * rate; schedule it as back-to-back AudioBuffers (WebAudio resamples each
   * buffer to the 16 kHz context) feeding a gain node in the mix.
   */
  const startAppAudio = async (mix: GainNode) => {
    const result = await audioTapStart(options.appPids ?? []);
    if (!result.ok) {
      throw new Error(result.error ?? "App audio capture failed to start.");
    }
    const appGain = context.createGain();
    appGain.connect(mix);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    appGain.connect(analyser);
    analysers.set("app", analyser);

    let nextStart = 0;
    const unsubscribe = window.__LEGALWORK_ELECTRON__?.audio?.onAppPcm?.((payload) => {
      if (stopped || payload.buffer.byteLength < 4) return;
      // Main re-frames to whole samples, but never trust alignment across IPC.
      const samples = new Float32Array(payload.buffer, 0, Math.floor(payload.buffer.byteLength / 4));
      const buffer = context.createBuffer(1, samples.length, payload.sampleRate || 48000);
      buffer.copyToChannel(samples, 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(appGain);
      const now = context.currentTime;
      // Keep a small jitter cushion; resync if we fell behind.
      if (nextStart < now + 0.05) nextStart = now + 0.08;
      node.start(nextStart);
      nextStart += buffer.duration;
    });
    stopAppTap = () => {
      unsubscribe?.();
      void audioTapStop().catch(() => {});
    };
  };

  try {
    const workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    if (sources.includes("microphone")) {
      streams.set("microphone", await requestMicStream());
    }
    if (sources.includes("system")) {
      streams.set("system", await requestSystemStream());
    }
    if (streams.size === 0 && !sources.includes("app")) throw new Error("No audio sources selected.");

    const mix = context.createGain();
    if (sources.includes("app")) {
      await startAppAudio(mix);
    }
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
    mix.connect(workletNode);

    // Compressed branch → audio.webm on disk.
    const destination = context.createMediaStreamDestination();
    mix.connect(destination);
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
