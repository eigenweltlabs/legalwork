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
