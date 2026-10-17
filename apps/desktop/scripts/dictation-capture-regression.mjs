import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { app, BrowserWindow, session } from "electron";
import { installMediaPermissionHandlers } from "../electron/media-permissions.mjs";

const require = createRequire(new URL("../../app/package.json", import.meta.url));
const { build } = require("esbuild");
const directory = mkdtempSync(path.join(os.tmpdir(), "legalwork-dictation-capture-"));
app.setPath("userData", directory);
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  let window;
  try {
    // Exercise the actual inline processor with exact input samples. Short
    // recordings and non-batch-aligned endings must retain every sample.
    const captureSource = await readFile(new URL("../../app/src/react-app/domains/recorder/capture.ts", import.meta.url), "utf8");
    const batchSamples = Number(captureSource.match(/const PCM_BATCH_SAMPLES = (\d+)/)?.[1]);
    const processorSource = captureSource.match(/const PCM_WORKLET_SOURCE = `([\s\S]*?)`;/)?.[1];
    assert.ok(processorSource && batchSamples, "the production PCM processor is available");
    let Processor;
    runInNewContext(processorSource.replaceAll("${PCM_BATCH_SAMPLES}", String(batchSamples)), {
      Float32Array,
      AudioWorkletProcessor: class {
        constructor() { this.port = { postMessage: message => this.messages.push(message) }; this.messages = []; }
      },
      registerProcessor: (_name, constructor) => { Processor = constructor; },
    });
    for (const count of [0, 128, batchSamples, 5632, batchSamples * 2 + 128]) {
      const processor = new Processor();
      const input = Float32Array.from({ length: count }, (_, index) => (index + 1) / 16_000);
      for (let offset = 0; offset < input.length; offset += 128) processor.process([[input.subarray(offset, offset + 128)]]);
      processor.port.onmessage({ data: "flush" });
      assert.equal(processor.messages.at(-1), "flushed", "the acknowledgement follows the final audio");
      const delivered = processor.messages.filter(message => message instanceof ArrayBuffer).flatMap(buffer => [...new Float32Array(buffer)]);
      assert.deepEqual(delivered, [...input], `all ${count} input samples reach transcription, including the last sample`);
      const messages = processor.messages.length;
      assert.equal(processor.process([[new Float32Array(128)]]), false);
      assert.equal(processor.messages.length, messages, "no audio arrives after the flush acknowledgement");
    }
    await build({
      entryPoints: [fileURLToPath(new URL("../../app/src/react-app/domains/recorder/capture.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      outfile: path.join(directory, "capture.js"),
      plugins: [{
        name: "capture-test-bridge",
        setup(builder) {
          builder.onResolve({ filter: /^@\/(app\/lib\/desktop|i18n)$/ }, ({ path }) => ({ path, namespace: "capture-test" }));
          builder.onLoad({ filter: /.*/, namespace: "capture-test" }, ({ path }) => ({
            contents: path === "@/i18n"
              ? "export const t = key => key;"
              : `export const audioLoopbackEnable = async () => {};
                 export const audioLoopbackDisable = async () => {};
                 export const audioSystemDictationMicrophonesGet = async () => window.testMicrophones;
                 export const audioSystemDictationMicrophonesUpdate = async (inputs, defaultId) => {
                   const id = inputs.find(input => input.name === 'Fake Audio Input 1')?.id;
                   return { ...window.testMicrophones, devices: inputs, resolvedDeviceId: window.testMicrophones.selection === 'missing' ? null : id };
                 };`,
          }));
        },
      }],
    });
    await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Dictation capture regression</title>");
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    installMediaPermissionHandlers(session, () => window);
    await window.loadFile(path.join(directory, "index.html"));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const contexts = [];
      const streams = [];
      const pcm = [];
      const media = [];
      const requestedInputs = [];
      const microphoneNames = [];
      const shortPcmFrames = [];
      let delayNextEnumeration = false;
      let microphoneLookupPending = false;
      let pcmDuringMicrophoneLookup = false;
      window.testMicrophones = { selection: "auto", selectedName: null, activeName: null };
      window.__LEGALWORK_ELECTRON__ = { system: { askMicrophoneAccess: async () => ({ platform: 'darwin', granted: true }) } };
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor(options) { super(options); contexts.push(this); }
      };
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        requestedInputs.push(constraints.audio.deviceId?.exact ?? null);
        const stream = await getUserMedia(constraints);
        streams.push(stream);
        if (streams.length === 1) delayNextEnumeration = true;
        return stream;
      };
      const enumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = async () => {
        if (delayNextEnumeration) {
          delayNextEnumeration = false;
          microphoneLookupPending = true;
          await new Promise(resolve => setTimeout(resolve, 500));
          microphoneLookupPending = false;
        }
        return enumerateDevices();
      };
      const { startCapture } = await import('./capture.js');
      const preferredInput = (await navigator.mediaDevices.enumerateDevices()).find(device => device.kind === 'audioinput' && device.label === 'Fake Audio Input 1' && device.deviceId !== 'default');
      const handle = await startCapture(['microphone'], {
        onPcm: chunk => {
          pcm.push(new Float32Array(chunk));
          if (microphoneLookupPending) pcmDuringMicrophoneLookup = true;
        },
        onMediaChunk: chunk => media.push(chunk),
        onSourceEnded: () => {},
        onMicrophone: name => microphoneNames.push(name),
      }, { dictation: true });
      await new Promise(resolve => setTimeout(resolve, 1_300));
      await handle.stop();
      // Verify system default, an explicit device, and a missing explicit
      // device using the real Chromium capture path, never physical hardware.
      for (const selection of ['default', preferredInput.deviceId]) {
        window.testMicrophones.selection = selection;
        let frames = 0;
        const extra = await startCapture(['microphone'], {
          onPcm: chunk => { frames += chunk.byteLength / 4; }, onMediaChunk: () => {}, onSourceEnded: () => {},
          onMicrophone: name => microphoneNames.push(name),
        }, { dictation: true });
        await new Promise(resolve => setTimeout(resolve, 80));
        await Promise.all([extra.stop(), extra.stop()]);
        shortPcmFrames.push(frames);
      }
      window.testMicrophones.selection = 'missing';
      let missingError;
      try {
        await startCapture(['microphone'], { onPcm: () => {}, onMediaChunk: () => {}, onSourceEnded: () => {} }, { dictation: true });
      } catch (error) { missingError = error.message; }
      let meetingFrames = 0;
      let meetingMeterPackets = 0;
      const meeting = await startCapture(['microphone'], {
        onPcm: chunk => { meetingFrames += chunk.byteLength / 4; }, onMediaChunk: () => {}, onSourceEnded: () => {},
        onMeter: () => { meetingMeterPackets += 1; },
      });
      const meetingSink = contexts.at(-1).sinkId;
      await new Promise(resolve => setTimeout(resolve, 120));
      await meeting.stop();
      // An unresponsive worklet must produce a bounded error and release
      // the microphone, rather than hanging or silently losing the tail.
      const NativeAudioWorkletNode = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends NativeAudioWorkletNode {
        constructor(...args) { super(...args); this.port.postMessage = () => {}; }
      };
      window.testMicrophones.selection = 'auto';
      const unresponsive = await startCapture(['microphone'], { onPcm: () => {}, onMediaChunk: () => {}, onSourceEnded: () => {} }, { dictation: true });
      let flushError;
      try { await unresponsive.stop(); } catch (error) { flushError = error.message; }
      const offline = new OfflineAudioContext(1, 16_000, 16_000);
      const recording = await offline.decodeAudioData(await new Blob(media, { type: 'audio/webm' }).arrayBuffer());
      const samples = pcm.flatMap(chunk => [...chunk]);
      return {
        sink: typeof contexts[0].sinkId === 'string' ? contexts[0].sinkId : { type: contexts[0].sinkId.type },
        sampleRate: contexts[0].sampleRate,
        preferredInput: preferredInput?.deviceId,
        requestedInputs, microphoneNames, missingError, flushError,
        meetingFrames, meetingMeterPackets, meetingSink: { type: meetingSink.type },
        pcmDuringMicrophoneLookup, shortPcmFrames,
        closed: contexts.every(context => context.state === 'closed'),
        released: streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')),
        pcmFrames: samples.length,
        pcmEnergy: samples.reduce((sum, sample) => sum + sample * sample, 0),
        pcmFinite: samples.every(Number.isFinite),
        duration: recording.duration,
        recordingEnergy: recording.getChannelData(0).reduce((sum, sample) => sum + sample * sample, 0),
      };
    })()`);
    assert.deepEqual(result.sink, { type: "none" }, "capture never opens an audio output device");
    assert.equal(result.sampleRate, 16_000);
    assert.ok(result.preferredInput, "the preferred input is available before capture opens a microphone");
    assert.deepEqual(result.requestedInputs, [result.preferredInput, null, result.preferredInput, null, result.preferredInput], "Automatic and explicit selections target a device; meetings follow the system default");
    assert.deepEqual(result.meetingSink, { type: "none" }, "meeting capture also avoids opening playback");
    assert.ok(result.meetingFrames > 0 && result.meetingMeterPackets > 0, "retained capture delivers transcription audio and the live microphone meter");
    assert.equal(result.missingError, "recorder.dictation_mic_missing", "a missing explicit input never opens another microphone");
    assert.equal(result.flushError, "recorder.capture_finish_failed", "a missing flush acknowledgement reports an error instead of discarding audio");
    assert.equal(result.microphoneNames.length, 3);
    assert.deepEqual(result.microphoneNames, ["Fake Audio Input 1", "Fake Default Audio Input", "Fake Audio Input 1"], "capture reports each actual input, including the system default");
    assert.ok(result.pcmFrames >= 16_000, "the silent sink still clocks transcription PCM");
    assert.equal(result.pcmDuringMicrophoneLookup, true, "a slow microphone-name lookup never delays capture");
    assert.ok(result.shortPcmFrames.every(frames => frames > 0), "stopping before a full PCM batch still delivers the captured audio");
    assert.ok(result.pcmFinite && result.pcmEnergy > 0, "captured microphone audio is finite and audible");
    assert.ok(result.duration > 1 && result.recordingEnergy > 0, "the final WebM chunk flushes and decodes");
    assert.equal(result.closed, true, "capture closes its audio context");
    assert.equal(result.released, true, "capture releases every microphone track");
    console.log("PASS: dictation preserves the final PCM samples, starts during metadata lookup, flushes WebM, and releases input without opening playback");
  } finally {
    window?.destroy();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch(error => console.warn("Temporary capture test cleanup:", error.message));
  }
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
