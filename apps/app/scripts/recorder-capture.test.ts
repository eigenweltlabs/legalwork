import { beforeEach, expect, mock, test } from "bun:test";
import type { AudioCaptureSourceKind } from "@legalwork/types/audio";

mock.module("../src/app/lib/desktop", () => ({ audioLoopbackEnable: async () => {}, audioLoopbackDisable: async () => {} }));
mock.module("../src/react-app/domains/recorder/dictation-microphone", () => ({ refreshDictationMicrophones: async () => ({}) }));
mock.module("../src/i18n", () => ({ t: (key: string) => key }));
const { startCapture } = await import("../src/react-app/domains/recorder/capture");

class Track extends EventTarget {
  readyState = "live";
  muted = false;
  stop() { this.readyState = "ended"; }
}
class Stream {
  track = new Track();
  constructor(public kind: string) {}
  getAudioTracks() { return [this.track]; }
  getVideoTracks() { return []; }
  getTracks() { return [this.track]; }
}
class GraphNode {
  connections: GraphNode[] = [];
  fftSize = 512;
  gain = { value: 1 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  stream = new Stream("destination");
  connect(node: GraphNode) { this.connections.push(node); }
  disconnect() {}
  getFloatTimeDomainData(samples: Float32Array) { samples.fill(0); }
}
const contexts: Context[] = [];
class Context {
  state = "running";
  inputs: { source: Stream; node: GraphNode }[] = [];
  audioWorklet = { addModule: async () => {} };
  constructor() { contexts.push(this); }
  async suspend() { this.state = "suspended"; }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
  createMediaStreamSource(source: Stream) { const node = new GraphNode(); this.inputs.push({ source, node }); return node; }
  createGain() { return new GraphNode(); }
  createAnalyser() { return new GraphNode(); }
  createDynamicsCompressor() { return new GraphNode(); }
  createMediaStreamDestination() { return new GraphNode(); }
}
const worklets: Worklet[] = [];
class Worklet extends GraphNode {
  port = {
    onmessage: (event: { data: ArrayBuffer | string }) => {},
    close() {},
    postMessage: (message: string) => {
      if (message === "flush") {
        this.port.onmessage({ data: new Float32Array([.125]).buffer });
        this.port.onmessage({ data: "flushed" });
      }
    },
  };
  constructor(context: Context) { super(); expect(context.state).toBe("suspended"); worklets.push(this); }
}
const recorders: Recorder[] = [];
class Recorder extends EventTarget {
  static isTypeSupported() { return true; }
  state = "inactive";
  ondataavailable = (event: { data: Blob }) => {};
  constructor(public stream: Stream) { super(); recorders.push(this); }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable({ data: new Blob(["tail"]) });
    this.dispatchEvent(new Event("stop"));
  }
}
beforeEach(() => {
  contexts.length = 0; worklets.length = 0; recorders.length = 0;
  Object.assign(globalThis, { AudioContext: Context, AudioWorkletNode: Worklet, MediaRecorder: Recorder });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    getUserMedia: async () => new Stream("microphone"), getDisplayMedia: async () => new Stream("system"),
  } } });
});

test("microphone and system PCM never share a worklet; stop flushes both and all three audio files", async () => {
  const pcm: { source?: AudioCaptureSourceKind; samples: number[] }[] = [];
  const media: (AudioCaptureSourceKind | undefined)[] = [];
  const capture = await startCapture(["microphone", "system"], {
    onPcm: (chunk, source) => { pcm.push({ source, samples: [...new Float32Array(chunk)] }); },
    onMediaChunk: (_chunk, source) => { media.push(source); }, onSourceEnded: () => {},
  });
  expect(worklets).toHaveLength(2);
  expect(recorders).toHaveLength(3);
  const [mic, system] = contexts[0].inputs;
  expect(mic.node.connections).toContain(worklets[0]);
  expect(mic.node.connections).not.toContain(worklets[1]);
  expect(system.node.connections).toContain(worklets[1]);
  expect(system.node.connections).not.toContain(worklets[0]);
  worklets[0].port.onmessage({ data: new Float32Array([.5]).buffer });
  worklets[1].port.onmessage({ data: new Float32Array([-.5]).buffer });
  await capture.stop();
  expect(pcm).toEqual([
    { source: "microphone", samples: [.5] }, { source: "system", samples: [-.5] },
    { source: "microphone", samples: [.125] }, { source: "system", samples: [.125] },
  ]);
  expect(new Set(media)).toEqual(new Set([undefined, "microphone", "system"]));
  expect(contexts[0].state).toBe("closed");
  expect(contexts[0].inputs.every(input => input.source.track.readyState === "ended")).toBe(true);
  await capture.stop();
  expect(media).toHaveLength(3);
});

test("single microphone retains the dictation protocol and one recording file", async () => {
  const sources: (AudioCaptureSourceKind | undefined)[] = [];
  const capture = await startCapture(["microphone"], {
    onPcm: (_chunk, source) => { sources.push(source); }, onMediaChunk: () => {}, onSourceEnded: () => {},
  });
  expect(worklets).toHaveLength(1);
  expect(recorders).toHaveLength(1);
  await capture.stop();
  expect(sources).toEqual([undefined]);
});

test("canceling a pending microphone request releases startup and stops a late stream", async () => {
  let resolveMicrophone: (stream: Stream) => void = () => {};
  const microphone = new Promise<Stream>(resolve => { resolveMicrophone = resolve; });
  Object.assign(navigator.mediaDevices, { getUserMedia: () => microphone });
  const controller = new AbortController();
  const stream = new Stream("late microphone");
  const start = startCapture(["microphone"], {
    onPcm: () => {}, onMediaChunk: () => {}, onSourceEnded: () => {},
  }, { dictation: true, signal: controller.signal });
  const outcome = start.then(() => "started", error => error.name);
  let next: Awaited<ReturnType<typeof startCapture>> | null = null;
  try {
    controller.abort();
    expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("pending"), 30))])).toBe("AbortError");
    expect(contexts[0].state).toBe("closed");
    Object.assign(navigator.mediaDevices, { getUserMedia: async () => new Stream("next microphone") });
    next = await startCapture(["microphone"], { onPcm: () => {}, onMediaChunk: () => {}, onSourceEnded: () => {} });
  } finally {
    resolveMicrophone(stream);
    const handle = await start.catch(() => null);
    await handle?.stop();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(stream.track.readyState).toBe("ended");
  expect(contexts[1].state).toBe("running");
  await next?.stop();
});

test("cancellation interrupts a suspended audio context whose resume never completes", async () => {
  let resume: () => void = () => {};
  const pending = new Promise<void>(resolve => { resume = resolve; });
  class SuspendedContext extends Context {
    state = "suspended";
    async resume() { await pending; this.state = "running"; }
  }
  Object.assign(globalThis, { AudioContext: SuspendedContext });
  const controller = new AbortController();
  const starting = startCapture(["microphone"], { onPcm: () => {}, onMediaChunk: () => {}, onSourceEnded: () => {} }, { dictation: true, signal: controller.signal });
  const outcome = starting.then(() => "started", error => error.name);
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("pending"), 30))])).toBe("AbortError");
    expect(contexts[0].state).toBe("closed");
  } finally {
    resume();
    await (await starting.catch(() => null))?.stop();
  }
});

test("a suspended context opens the microphone before resuming audio", async () => {
  let microphoneOpened = false;
  const resumeOrder: boolean[] = [];
  class SuspendedContext extends Context {
    state = "suspended";
    async resume() { resumeOrder.push(microphoneOpened); this.state = "running"; }
  }
  Object.assign(globalThis, { AudioContext: SuspendedContext });
  Object.assign(navigator.mediaDevices, { getUserMedia: async () => { microphoneOpened = true; return new Stream("microphone"); } });
  const capture = await startCapture(["microphone"], { onPcm: () => {}, onMediaChunk: () => {}, onSourceEnded: () => {} }, { dictation: true });
  try { expect(resumeOrder).toEqual([true]); }
  finally { await capture.stop(); }
});

test("cancel immediately closes the microphone even when the encoder never acknowledges Stop", async () => {
  const controller = new AbortController();
  const capture = await startCapture(["microphone"], { onPcm: () => {}, onMediaChunk: () => {}, onSourceEnded: () => {} }, { dictation: true, signal: controller.signal });
  recorders[0].stop = () => { recorders[0].state = "inactive"; };
  const stopping = capture.stop().then(() => "stopped", error => error.name);
  controller.abort();
  expect(contexts[0].inputs[0].source.track.readyState).toBe("ended");
  expect(contexts[0].state).toBe("closed");
  expect(await Promise.race([stopping, new Promise(resolve => setTimeout(() => resolve("pending"), 30))])).toBe("AbortError");
});

test("finishing dictation flushes transcription without waiting for the playback encoder", async () => {
  const pcm: number[] = [];
  const media: ArrayBuffer[] = [];
  const capture = await startCapture(["microphone"], { onPcm: chunk => pcm.push(...new Float32Array(chunk)), onMediaChunk: chunk => media.push(chunk), onSourceEnded: () => {} }, { dictation: true });
  recorders[0].stop = () => { recorders[0].state = "inactive"; };
  const stopping = capture.stop();
  try {
    expect(await Promise.race([stopping.then(() => "stopped"), new Promise(resolve => setTimeout(() => resolve("pending"), 30))])).toBe("stopped");
    expect(pcm).toEqual([.125]);
    expect(media).toEqual([]);
    expect(contexts[0].state).toBe("closed");
  } finally {
    recorders[0].dispatchEvent(new Event("stop"));
    await stopping;
  }
});

test("finishing dictation bounds a suspended audio context even when resume never acknowledges", async () => {
  const capture = await startCapture(["microphone"], { onPcm: () => {}, onMediaChunk: () => {}, onSourceEnded: () => {} }, { dictation: true });
  let releaseResume = () => {};
  const pending = new Promise<void>(resolve => { releaseResume = resolve; });
  contexts[0].state = "suspended";
  contexts[0].resume = () => pending;
  Object.assign(window, { setTimeout: (callback: () => void, ms: number) => setTimeout(callback, Math.min(ms, 10)) });
  const stopping = capture.stop();
  try {
    const outcome = stopping.then(() => "stopped", error => error.message);
    expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("pending"), 50))])).toBe("recorder.capture_finish_failed");
    expect(contexts[0].inputs[0].source.track.readyState).toBe("ended");
    expect(contexts[0].state).toBe("closed");
  } finally {
    releaseResume();
    await stopping.catch(() => {});
  }
});
