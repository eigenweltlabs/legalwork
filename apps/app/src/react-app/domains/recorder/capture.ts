/**
 * Audio capture engine for the Recorder tab.
 *
 * Builds one WebAudio graph per recording:
 *
 * Each input has its own PCM worklet and compressed recording. A separate
 * playback mix feeds audio.webm; transcription never consumes that mix when
 * multiple inputs are captured. All branches share the same 16 kHz clock.
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
import { t } from "@/i18n";
import { dictationMeterLevel } from "./dictation-meter";
import { refreshDictationMicrophones } from "./dictation-microphone";

const TARGET_SAMPLE_RATE = 16000;
const PCM_BATCH_SAMPLES = 4096; // 256 ms at 16 kHz

/** Inline worklet: batch mono 128-frame quanta into PCM_BATCH_SAMPLES chunks. */
const PCM_WORKLET_SOURCE = `
class LegalworkPcmBatcher extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${PCM_BATCH_SAMPLES});
    this.offset = 0;
    this.flushed = false;
    this.port.onmessage = ({ data }) => {
      if (data !== "flush") return;
      this.flushed = true;
      if (this.offset > 0) {
        const tail = this.buffer.slice(0, this.offset);
        this.port.postMessage(tail.buffer, [tail.buffer]);
        this.offset = 0;
      }
      this.port.postMessage("flushed");
    };
  }
  process(inputs) {
    if (this.flushed) return false;
    // Missing/muted input still advances the shared capture clock. Skipping
    // those quanta shifts this source ahead of the other person's audio.
    const channel = inputs[0]?.[0] ?? new Float32Array(128);
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

/** Normalized display levels, independent of the recorded audio signal. */
export type CaptureLevels = Partial<Record<AudioCaptureSourceKind, number>>;

export type CaptureHandle = {
  stop: () => Promise<void>;
  readLevels: () => CaptureLevels;
};

export type CaptureCallbacks = {
  onPcm: (chunk: ArrayBuffer, source?: AudioCaptureSourceKind) => void;
  onMediaChunk: (chunk: ArrayBuffer, source?: AudioCaptureSourceKind) => void;
  /** Live dictation feedback, independent of transcription's 256 ms PCM batches. */
  onMeter?: (level: number) => void;
  onMicrophone?: (name: string) => void;
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

async function requestMicStream(withEchoCancellation: boolean, dictation: boolean): Promise<MediaStream> {
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
  if (dictation && ask) {
    const state = await refreshDictationMicrophones();
    if (!state.resolvedDeviceId && state.selection !== "default") {
      throw new Error(t(state.selection === "auto" ? "recorder.dictation_mic_none" : "recorder.dictation_mic_missing"));
    }
    if (state.selection !== "default" && state.resolvedDeviceId && typeof constraints.audio === "object") {
      constraints.audio.deviceId = { exact: state.resolvedDeviceId };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      return await ensureLiveMicStream(stream, constraints);
    } catch (error) {
      if (!["auto", "default"].includes(state.selection) && error instanceof DOMException
        && ["NotFoundError", "OverconstrainedError"].includes(error.name)) {
        throw new Error(t("recorder.dictation_mic_missing"));
      }
      // Automatic can recover if a device disappears between discovery and
      // opening. An explicit choice must never silently use a different input.
      if (state.selection !== "auto" || (error instanceof DOMException && error.name === "NotAllowedError")) throw error;
      if (typeof constraints.audio === "object") delete constraints.audio.deviceId;
    }
  }
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
  options: { dictation?: boolean; signal?: AbortSignal } = {},
): Promise<CaptureHandle> {
  options.signal?.throwIfAborted();
  // Recording processes input without opening the playback device. A silent
  // sink still clocks the worklet, and avoids disturbing Bluetooth playback.
  // Chromium supports sinkId; our DOM typings do not include it yet.
  const contextOptions: AudioContextOptions & { sinkId?: { type: "none" } } = {
    sampleRate: TARGET_SAMPLE_RATE,
    sinkId: { type: "none" },
  };
  const context = new AudioContext(contextOptions);
  const streams = new Map<AudioCaptureSourceKind, MediaStream>();
  const analysers = new Map<AudioCaptureSourceKind, AnalyserNode>();
  const recorders: MediaRecorder[] = [];
  const worklets: AudioWorkletNode[] = [];
  const pcmFlushes = new Map<AudioWorkletNode, () => void>();
  let meterTimer: number | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  const signal = options.signal;
  const interruptible = <T>(operation: Promise<T>): Promise<T> => {
    if (!signal) return operation;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", abortCapture);
    if (meterTimer !== null) window.clearInterval(meterTimer);
    for (const recorder of recorders) {
      try { if (recorder.state !== "inactive") recorder.stop(); }
      catch { /* An encoder failure must not prevent releasing our inputs. */ }
    }
    for (const node of worklets) {
      node.port.close();
      node.disconnect();
    }
    for (const stream of streams.values()) {
      for (const track of stream.getTracks()) track.stop();
    }
    streams.clear();
    await context.close().catch(() => {});
  };
  const abortCapture = () => { void cleanup().catch(() => {}); };
  signal?.addEventListener("abort", abortCapture, { once: true });

  try {
    const loadWorklet = async () => {
      const workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
    };

    // Echo cancellation on the mic only matters when the machine is also
    // playing captured system audio that could leak back into it.
    const hasOtherSources = sources.includes("system");
    const openMicrophone = async () => {
      if (sources.includes("microphone")) {
        const stream = await requestMicStream(hasOtherSources, options.dictation === true);
        // getUserMedia cannot be aborted. Cancellation may have already
        // closed this graph while the OS was still opening the device.
        if (stopped) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streams.set("microphone", stream);
      }
    };
    if (options.dictation) {
      // Cancel startup without waiting for an OS microphone request. A late
      // stream is released above, and both preparation failures are observed.
      const preparation = Promise.allSettled([loadWorklet(), openMicrophone()]);
      const results = await interruptible(preparation);
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    } else {
      await loadWorklet();
      await openMicrophone();
    }
    if (sources.includes("system")) {
      streams.set("system", await requestSystemStream());
    }
    if (streams.size === 0) throw new Error(t("recorder.no_audio_sources"));

    // Build every branch while paused, then start on one shared clock. This
    // keeps timestamps aligned even when opening the second device took time.
    await interruptible(context.suspend());
    const inputs = new Map<AudioCaptureSourceKind, MediaStreamAudioSourceNode>();
    const mix = context.createGain();
    for (const [kind, stream] of streams) {
      const sourceNode = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      sourceNode.connect(analyser);
      sourceNode.connect(mix);
      inputs.set(kind, sourceNode);
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

    const pendingChunkWrites = new Set<Promise<void>>();
    let chunkWriteError: unknown;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";
    const recordAudio = (input: AudioNode, source?: AudioCaptureSourceKind) => {
      const destination = context.createMediaStreamDestination();
      input.connect(destination);
      const recorder = new MediaRecorder(destination.stream, { mimeType, audioBitsPerSecond: 48_000 });
      recorder.ondataavailable = (event) => {
        // Dictation is ephemeral: only its PCM reaches transcription. Waiting
        // for discarded playback bytes can stall an otherwise empty recording.
        if (options.dictation || event.data.size === 0) return;
        const write = event.data.arrayBuffer()
          .then(buffer => callbacks.onMediaChunk(buffer, source))
          .catch(error => { chunkWriteError = error; })
          .finally(() => pendingChunkWrites.delete(write));
        pendingChunkWrites.add(write);
      };
      recorders.push(recorder);
      recorder.start(1000);
    };
    const transcribeAudio = (input: AudioNode, source?: AudioCaptureSourceKind) => {
      const node = new AudioWorkletNode(context, "legalwork-pcm-batcher", {
        numberOfInputs: 1, numberOfOutputs: 0,
        channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
      });
      node.port.onmessage = (event) => {
        if (!stopped && event.data instanceof ArrayBuffer) callbacks.onPcm(event.data, source);
        if (event.data === "flushed") pcmFlushes.get(node)?.();
      };
      worklets.push(node);
      input.connect(node);
    };
    // Keep the existing playback file, plus the original inputs for future
    // processing. Single-input dictation/imports retain their existing protocol.
    recordAudio(bus);
    if (multiSource) {
      for (const [source, input] of inputs) {
        recordAudio(input, source);
        transcribeAudio(input, source);
      }
    } else {
      transcribeAudio(bus);
    }
    // Open the microphone before resuming. A background context can otherwise
    // wait for capture/user activation while preventing capture from starting.
    await interruptible(context.resume());
    options.signal?.throwIfAborted();

    const onMicrophone = callbacks.onMicrophone;
    if (options.dictation && onMicrophone) {
      const track = streams.get("microphone")?.getAudioTracks()[0];
      const name = track?.label || "";
      onMicrophone(name);
      // Resolving the physical name behind "default" is UI metadata. Do it
      // after capture starts so discovery cannot swallow the first words.
      const settings = track?.getSettings();
      void navigator.mediaDevices.enumerateDevices().then(devices => {
        const physical = devices.filter(device => device.kind === "audioinput"
          && device.deviceId !== "default" && device.deviceId !== "communications");
        const input = physical.find(device => device.deviceId === settings?.deviceId)
          ?? physical.find(device => settings?.groupId && device.groupId === settings.groupId);
        if (!stopped && input?.label && input.label !== name) onMicrophone(input.label);
      }).catch(() => {});
    }

    const flushPcm = async () => {
      let timeout: number | undefined;
      try {
        // Resuming can itself stall. The deadline covers the entire flush,
        // including that wait, so Stop always releases the microphone.
        await Promise.race([
          new Promise<never>((_resolve, reject) => {
            timeout = window.setTimeout(() => reject(new Error(t("recorder.capture_finish_failed"))), 1500);
          }),
          (async () => {
            if (context.state === "suspended") await context.resume();
            if (stopped) return;
            await Promise.all(worklets.map(node => new Promise<void>(resolve => {
              pcmFlushes.set(node, resolve);
              node.port.postMessage("flush");
            })));
          })(),
        ]);
      } finally {
        for (const node of worklets) pcmFlushes.delete(node);
        if (timeout !== undefined) window.clearTimeout(timeout);
      }
    };

    const onMeter = callbacks.onMeter;
    const meterAnalyser = analysers.get("microphone");
    if (onMeter && meterAnalyser) {
      const samples = new Float32Array(meterAnalyser.fftSize);
      meterTimer = window.setInterval(() => {
        if (stopped) return;
        meterAnalyser.getFloatTimeDomainData(samples);
        onMeter(dictationMeterLevel(samples));
      }, 16);
    }

    // Use the floating meter's display scale. Linear, 8-bit peaks make quiet
    // speech nearly invisible and quantize low input to the same tiny step.
    const levelData = new Float32Array(512);
    return {
      readLevels: () => {
        const levels: CaptureLevels = {};
        for (const [kind, analyser] of analysers) {
          analyser.getFloatTimeDomainData(levelData);
          levels[kind] = dictationMeterLevel(levelData);
        }
        return levels;
      },
      stop: () => {
        stopPromise ??= (async () => {
          let timeout: number | undefined;
          try {
            await Promise.race([
              new Promise<never>((_resolve, reject) => {
                timeout = window.setTimeout(() => reject(new Error(t("recorder.capture_finish_failed"))), 5000);
              }),
              (async () => {
                // Flush the encoder before the graph goes away so the final
                // webm chunk (containing the cues) reaches disk.
                await Promise.all(recorders.map(async recorder => {
                  if (recorder.state === "inactive") return;
                  if (options.dictation) {
                    recorder.stop();
                    return;
                  }
                  await new Promise<void>(resolve => {
                    recorder.addEventListener("stop", () => resolve(), { once: true });
                    recorder.stop();
                  });
                }));
                if (stopped) return;
                // The acknowledgement trails the final partial PCM batch on
                // the same port. Finalize transcription only after it is sent.
                await flushPcm();
                // Blob conversions are asynchronous: wait for the final WebM
                // chunk before the caller finalizes the file.
                while (pendingChunkWrites.size > 0) {
                  await Promise.all(Array.from(pendingChunkWrites));
                }
                if (chunkWriteError) throw chunkWriteError;
              })(),
            ]);
          } finally {
            if (timeout !== undefined) window.clearTimeout(timeout);
            await cleanup();
          }
        })();
        return interruptible(stopPromise);
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
