import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DictationSpeechDetector, dictationSpeechModelPath } from "./audio/dictation-speech.mjs";

function speech(gain) {
  const samples = new Float32Array(48000);
  for (let i = 0; i < 32000; i++) {
    const t = i / 16000;
    for (let harmonic = 1; harmonic <= 8; harmonic++) {
      samples[8000 + i] += gain * (.55 + .45 * Math.sin(2 * Math.PI * 3.5 * t))
        * Math.sin(2 * Math.PI * 120 * harmonic * (1 + .01 * Math.sin(2 * Math.PI * 5 * t)) * t) / harmonic;
    }
  }
  return samples;
}

function detect(samples) {
  const detector = new DictationSpeechDetector();
  for (let offset = 0; offset < samples.length; offset += 4096) {
    if (detector.accept(samples.slice(offset, offset + 4096).buffer)) return true;
  }
  return detector.finish();
}

test("real local Silero rejects digital silence and low background noise", () => {
  assert.equal(detect(new Float32Array(48000)), false);
  let seed = 1234;
  const noise = Float32Array.from({ length: 48000 }, () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return (seed / 2 ** 32 * 2 - 1) * .001;
  });
  assert.equal(detect(noise), false);
});

test("local detection recognizes normal and very quiet speech without changing input PCM", () => {
  for (const gain of [.25, .025, .0025, .00025]) {
    const samples = speech(gain);
    const original = samples.slice();
    assert.equal(detect(samples), true, `speech gain ${gain}`);
    assert.deepEqual(samples, original);
  }
});

test("local detection keeps an incomplete frame until Stop", () => {
  const detector = new DictationSpeechDetector();
  detector.accept(new Float32Array(100).buffer);
  assert.equal(detector.pending.length, 100);
  assert.equal(detector.finish(), false);
  assert.equal(detector.pending.length, 0);
});

test("packaged speech detection resolves the bundled model without a local model download", async () => {
  const resources = await fsp.mkdtemp(path.join(os.tmpdir(), "lw-speech-resources-"));
  try {
    const desktop = fileURLToPath(new URL("..", import.meta.url));
    const config = parse(await fsp.readFile(path.join(desktop, "electron-builder.yml"), "utf8"));
    const resource = config.extraResources.find(entry => entry.to === "speech/silero_vad_legacy.onnx");
    assert.ok(resource, "packaged dictation needs its local detector model");
    const model = path.join(resources, "speech", "silero_vad_legacy.onnx");
    await fsp.mkdir(path.dirname(model));
    await fsp.copyFile(path.join(desktop, resource.from), model);
    assert.equal(dictationSpeechModelPath(resources), model);
    assert.equal(new DictationSpeechDetector(model).finish(), false);
  } finally { await fsp.rm(resources, { recursive: true, force: true }); }
});
