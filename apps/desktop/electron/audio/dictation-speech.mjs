import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const WINDOW = 512;

export function dictationSpeechModelPath(resourcesPath = process.resourcesPath) {
  const bundled = resourcesPath && path.join(resourcesPath, "speech", "silero_vad_legacy.onnx");
  if (bundled && existsSync(bundled)) return bundled;
  return require.resolve("@ricky0123/vad-web/dist/silero_vad_legacy.onnx");
}

/** Local speech detection only; the original microphone samples are never changed. */
export class DictationSpeechDetector {
  constructor(modelPath = dictationSpeechModelPath()) {
    const { Vad } = require("sherpa-onnx-node");
    this.vad = new Vad({ sileroVad: {
      model: modelPath, threshold: .25, minSpeechDuration: .03,
      minSilenceDuration: .1, maxSpeechDuration: 20, windowSize: WINDOW,
    }, sampleRate: 16000, numThreads: 1, provider: "cpu", debug: 0 }, 1);
    this.pending = new Float32Array(0);
    this.detected = false;
  }

  accept(buffer) {
    if (this.detected) return true;
    const samples = new Float32Array(buffer);
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    let offset = 0;
    while (offset + WINDOW <= joined.length) {
      const frame = joined.slice(offset, offset + WINDOW);
      // Boost only the detector's copy so quiet speech is not mistaken for
      // silence. There is no microphone-volume cutoff and cloud PCM stays raw.
      const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / WINDOW);
      const gain = rms > 0 ? Math.max(1, Math.min(1000, .1 / rms)) : 1;
      for (let i = 0; i < frame.length; i++) frame[i] = Math.max(-1, Math.min(1, frame[i] * gain));
      this.vad.acceptWaveform(frame);
      if (this.vad.isDetected() || !this.vad.isEmpty()) {
        this.detected = true;
        this.pending = new Float32Array(0);
        return true;
      }
      offset += WINDOW;
    }
    this.pending = joined.slice(offset);
    return false;
  }

  finish() {
    // Complete a short final frame and allow the detector's trailing context
    // to settle. Padding is local and is never added to the uploaded audio.
    this.accept(new Float32Array(WINDOW * 10 - this.pending.length).buffer);
    this.vad.flush();
    return this.detected || !this.vad.isEmpty();
  }
}

/** @returns {{ accept: (buffer: ArrayBuffer) => boolean, finish: () => boolean }} */
export function createDictationSpeechDetector() {
  return new DictationSpeechDetector();
}
