import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { AudioCaptureSourceKind, AudioRecorderBootstrap, AudioRecorderEvent, AudioRecordingMeta, AudioMeetingStatus, AudioRecordingStartInput } from "@legalwork/types/audio";
import type { CaptureCallbacks, CaptureHandle } from "../src/react-app/domains/recorder/capture";

const meta: AudioRecordingMeta = {
  id: "dictation-test", title: "System dictation", createdAt: 1, durationMs: 0, language: "en", modelId: "test-model",
  sources: ["microphone"], folderPath: "/tmp/dictation-test", audioPath: null, transcriptPath: null,
  sizeBytes: 0, segmentCount: 0, status: "recording", error: null, ephemeral: true,
};
const bootstrap: AudioRecorderBootstrap = {
  models: [{ id: "test-model", label: "Test", description: "", kind: "whisper", tier: "fastest", plan: "free", languages: "multilingual", approxSizeBytes: 0, files: [], state: "installed", downloadedBytes: 0, totalBytes: 0, installedSizeBytes: 0, error: null }],
  capabilities: { microphone: true, systemAudio: true, appAudio: false }, engine: { available: true, error: null },
  diarization: { installed: false, downloading: false, downloadedBytes: 0, totalBytes: 0, error: null },
  device: { totalMemoryGb: 16, logicalCores: 8, appleSilicon: true, fastDevice: true, recommendedModelId: "test-model" },
  modelsDir: "/tmp/models", recordingsDir: "/tmp/recordings",
};
const status = {
  enabled: true, registered: true, accelerator: "Control+D", defaultAccelerator: "Control+D", customAccelerator: false,
  mode: "hold", supportsHold: true, shortcutCaptureActive: false, platform: "darwin", accessibility: "granted", error: null,
} satisfies NonNullable<ReturnType<typeof store.getState>["systemDictation"]>;

let handleEvent: (event: AudioRecorderEvent) => void = () => {};
const feedback: string[] = [];
const pasted: string[] = [];
const meterPackets: number[] = [];
const meetingPackets: { id: string; level: number }[] = [];
const meetingFeedback: AudioMeetingStatus["state"][] = [];
const recordingInputs: AudioRecordingStartInput[] = [];
let retainedRecordings: AudioRecordingMeta[] = [];
let captureSources: AudioCaptureSourceKind[] = [];
let meetingOpens = 0;
let meetingStatus: AudioMeetingStatus = { detectionEnabled: true, detectionSupported: true, detected: null, state: "idle", recordingId: null, startedAt: null, error: null };
let captureCallbacks: CaptureCallbacks | null = null;
let captureOptions: { dictation?: boolean } | undefined;
let cancelled = 0;
let deleted = 0;
let captureStops = 0;
let captureStarts = 0;
let pasteError: string | null = null;
let transcript = "A dictated sentence.";
const capture: CaptureHandle = { readLevels: () => ({ microphone: 0.5 }), stop: async () => { captureStops += 1; } };
let captureResult = Promise.resolve(capture);
let stopResult = Promise.resolve(meta);
const noop = async () => {};

Object.defineProperty(globalThis, "window", { configurable: true, value: {
  localStorage: { getItem: () => null, setItem: () => {} }, setInterval, clearInterval,
  __LEGALWORK_ELECTRON__: { audio: {
    onEvent: (handler: typeof handleEvent) => { handleEvent = handler; },
    sendDictationLevel: (level: number) => { meterPackets.push(level); },
    sendMeetingLevel: (id: string, level: number) => { meetingPackets.push({ id, level }); },
  } },
} });
mock.module("../src/react-app/domains/recorder/capture", () => ({
  startCapture: (sources: AudioCaptureSourceKind[], callbacks: CaptureCallbacks, options?: { dictation?: boolean }) => {
    captureStarts += 1;
    captureSources = sources;
    captureCallbacks = callbacks; captureOptions = options; return captureResult;
  },
  decodeAudioFileToPcm16k: noop,
}));
mock.module("../src/react-app/domains/recorder/model-tiers", () => ({ MODEL_TIERS: [], isPremiumEntitled: () => true, isPremiumEntitlementKnown: () => true, tierForModelId: () => null }));
mock.module("../src/app/lib/opencode", () => ({ unwrap: (value: unknown) => value }));
mock.module("../src/app/lib/desktop", () => ({
  audioRecordingSetProject: async () => retainedRecordings,
  audioSystemDictationSetState: async (state: string, message: string) => { feedback.push(message ? state + ":" + message : state); return status; },
  audioSystemDictationPaste: async (text: string) => { pasted.push(text); return { pasted: !pasteError, copied: true, error: pasteError }; },
  audioRecordingStart: async (input: AudioRecordingStartInput) => { recordingInputs.push(input); return { ...meta, ephemeral: input.ephemeral === true, sources: input.sources ?? ["microphone"] }; },
  audioRecordingStop: async () => { const result = await stopResult; if (!result.ephemeral) retainedRecordings = [result]; return result; },
  audioRecordingCancel: async () => { cancelled += 1; }, audioRecordingDelete: async () => { deleted += 1; return []; },
  audioRecordingGet: async () => ({ meta, segments: transcript ? [{ id: "s", text: transcript, startMs: 0, endMs: 1000, final: true }] : [] }),
  audioTranscriberStart: async () => ({ state: "ready", modelId: "test-model", error: null }),
  audioRecordingsList: async () => retainedRecordings, audioCapturePermissions: async () => ({ platform: "darwin", packaged: false, microphone: "granted", systemAudio: "granted" }),
  audioMeetingGet: async () => meetingStatus,
  audioMeetingDetectionSet: async (enabled: boolean) => { meetingStatus = { ...meetingStatus, detectionEnabled: enabled }; return meetingStatus; },
  audioMeetingSetState: async (state: AudioMeetingStatus["state"], recordingId?: string, error?: string) => {
    meetingFeedback.push(state); meetingStatus = { ...meetingStatus, state, recordingId: recordingId ?? null, error: error ?? null }; return meetingStatus;
  },
  audioMeetingOpen: async () => { meetingOpens += 1; },
  audioCaptureOpenSettings: noop, audioCapturePermissionsRequest: noop, audioDiarizationDownload: noop,
  audioModelDelete: noop, audioModelDownload: noop, audioModelDownloadCancel: noop, audioOverlaySetVisible: noop, audioRecorderBootstrap: async () => bootstrap,
  audioSystemDictationMicrophonesGet: async () => ({ selection: "auto", selectedName: null, devices: [], resolvedDeviceId: null, activeName: null }),
  audioSystemDictationMicrophonesUpdate: noop, audioSystemDictationMicrophoneSelect: noop, audioSystemDictationMicrophoneActive: noop,
  audioSystemDictationGet: async () => status, audioSystemDictationOpenSettings: noop, audioSystemDictationReadiness: noop,
  audioSystemDictationRepairPermission: noop, audioSystemDictationRequestPermission: noop, audioSystemDictationSetEnabled: noop,
  audioSystemDictationSetShortcut: noop, audioSystemDictationSetShortcutCapture: noop,
  audioLiveTranscriptStart: noop, audioLiveTranscriptStop: noop, audioImportStart: noop, audioImportSource: noop, audioImportFinish: noop,
  audioRecordingRename: noop, audioRecordingSaveToWorkspace: noop, desktopBridge: {},
}));
const { useRecorderStore: store } = await import("../src/react-app/domains/recorder/recorder-store");

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await delay(210); // The shortcut intentionally debounces key bounce for 200 ms.
  feedback.length = 0; pasted.length = 0; cancelled = 0; deleted = 0; captureStops = 0; captureStarts = 0; pasteError = null;
  meterPackets.length = 0; captureCallbacks = null;
  meetingPackets.length = 0; meetingFeedback.length = 0; recordingInputs.length = 0;
  retainedRecordings = []; meetingOpens = 0;
  transcript = "A dictated sentence.";
  captureResult = Promise.resolve(capture); stopResult = Promise.resolve(meta);
  store.setState({ initialized: true, bootstrap, systemDictation: status, modelId: "test-model", recording: null,
    recordingStartedAt: null, dictationRecordingId: null, dictationState: "idle", finalizing: false,
    permissions: { platform: "darwin", packaged: false, microphone: "granted", systemAudio: "granted" }, error: null, recordings: [], sources: ["microphone"] });
  await store.getState().init();
});
afterEach(async () => { if (store.getState().recording) await store.getState().cancelRecording(); });

test("capture readiness controls listening and a single paste on stop", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  const start = store.getState().startSystemDictation();
  await delay(10);
  expect(feedback).toEqual(["starting"]);
  pending.resolve(capture); await start;
  expect(feedback).toEqual(["starting", "listening"]);
  expect(captureOptions?.dictation).toBe(true);
  captureCallbacks?.onMeter?.(0.7);
  expect(meterPackets).toEqual([0.7]);
  const stop = store.getState().stopRecording();
  await store.getState().stopRecording(); // A second stop cannot finalize or paste twice.
  await stop;
  expect(feedback).toEqual(["starting", "listening", "transcribing", "inserting", "success"]);
  expect(pasted).toEqual(["A dictated sentence."]);
  expect(captureStops).toBe(1); expect(deleted).toBe(1);
});

test("a failed capture flush discards the ephemeral worker session without pasting", async () => {
  captureResult = Promise.resolve({
    readLevels: () => ({}),
    stop: async () => { throw new Error("Could not finish capturing audio."); },
  });
  await store.getState().startSystemDictation();
  await store.getState().stopRecording();
  expect(cancelled).toBe(1);
  expect(pasted).toEqual([]);
  expect(store.getState().recording).toBeNull();
  expect(store.getState().finalizing).toBe(false);
  expect(feedback.at(-1)).toBe("error:Could not finish capturing audio.");
});

test("cancel during capture startup rolls back without ever pasting", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  const start = store.getState().startSystemDictation(); await delay(10);
  await store.getState().cancelRecording();
  pending.resolve(capture); await start;
  expect(pasted).toEqual([]); expect(cancelled).toBe(1); expect(captureStops).toBe(1);
  expect(store.getState().dictationState).toBe("idle"); expect(feedback.at(-1)).toBe("cancelled");
});

test("cancel during transcription waits for the flush and suppresses insertion", async () => {
  await store.getState().startSystemDictation();
  const pending = deferred<AudioRecordingMeta>(); stopResult = pending.promise;
  const stop = store.getState().stopRecording(); await delay(10);
  await store.getState().cancelRecording();
  expect(cancelled).toBe(0); // No deletion under a running flush.
  pending.resolve(meta); await stop;
  expect(pasted).toEqual([]); expect(deleted).toBe(1); expect(feedback.at(-1)).toBe("cancelled");
  expect(store.getState().error).toBeNull(); expect(store.getState().finalizing).toBe(false);
});

test("a hold release during startup finishes once capture is ready", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  handleEvent({ type: "system-dictation-press" }); await delay(10);
  handleEvent({ type: "system-dictation-release" }); await delay(10);
  pending.resolve(capture); await delay(20);
  expect(pasted).toEqual(["A dictated sentence."]); expect(feedback.at(-1)).toBe("success");
  expect(captureStops).toBe(1); expect(cancelled).toBe(0);
  expect(store.getState().recording).toBeNull();
});

test("double-tap keeps startup running and one press finishes hands-free capture", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  handleEvent({ type: "system-dictation-press" }); await delay(10);
  // The gesture detector withholds key-up and changes only the HUD hint.
  handleEvent({ type: "system-dictation-status", status: { ...status, mode: "tap" } });
  pending.resolve(capture); await delay(20);
  expect(feedback).toEqual(["starting", "listening"]);
  expect(captureStarts).toBe(1); expect(captureStops).toBe(0);
  handleEvent({ type: "system-dictation-release" }); await delay(20);
  expect(pasted).toEqual(["A dictated sentence."]); expect(captureStops).toBe(1);
});

test("an isolated quick tap cancels capture startup without inserting", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  handleEvent({ type: "system-dictation-press" }); await delay(10);
  handleEvent({ type: "system-dictation-cancel" }); await delay(10);
  pending.resolve(capture); await delay(20);
  expect(pasted).toEqual([]); expect(feedback.at(-1)).toBe("cancelled");
  expect(captureStops).toBe(1); expect(cancelled).toBe(1);
});

test("a short press during startup shows the shortcut hint without an error", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  handleEvent({ type: "system-dictation-press" }); await delay(10);
  handleEvent({ type: "system-dictation-cancel", reason: "short-press" }); await delay(10);
  pending.resolve(capture); await delay(20);
  expect(feedback.at(-1)).toBe("idle:Hold ⌃D and speak");
  expect(store.getState().dictationState).toBe("idle"); expect(store.getState().error).toBeNull();
  expect(pasted).toEqual([]); expect(captureStops).toBe(1); expect(cancelled).toBe(1);
});

test("a short press after capture opens shows guidance and never finalizes or pastes", async () => {
  handleEvent({ type: "system-dictation-press" }); await delay(20);
  handleEvent({ type: "system-dictation-cancel", reason: "short-press" }); await delay(20);
  expect(feedback.at(-1)).toBe("idle:Hold ⌃D and speak");
  expect(pasted).toEqual([]); expect(cancelled).toBe(1); expect(deleted).toBe(0);
  expect(store.getState().recording).toBeNull(); expect(store.getState().error).toBeNull();
});

test("silence quietly returns to idle without entering insertion or touching the clipboard", async () => {
  transcript = "";
  await store.getState().startSystemDictation(); await store.getState().stopRecording();
  expect(feedback).toEqual(["starting", "listening", "transcribing", "idle"]);
  expect(pasted).toEqual([]); expect(deleted).toBe(1);
  expect(store.getState().recording).toBeNull(); expect(store.getState().error).toBeNull();
  expect(store.getState().finalizing).toBe(false);
});

test("blank decoded text is also a quiet no-op", async () => {
  transcript = " \n ";
  await store.getState().startSystemDictation(); await store.getState().stopRecording();
  expect(feedback.at(-1)).toBe("idle"); expect(pasted).toEqual([]);
  expect(store.getState().error).toBeNull();
});

test("one press can finish hands-free dictation while the microphone opens", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  handleEvent({ type: "system-dictation-toggle" }); await delay(10);
  handleEvent({ type: "system-dictation-release" });
  pending.resolve(capture); await delay(20);
  expect(pasted).toEqual(["A dictated sentence."]); expect(captureStops).toBe(1);
});

test("paste failure shows the recovery message and clears the dictation", async () => {
  pasteError = "Text copied. Paste it manually.";
  await store.getState().startSystemDictation(); await store.getState().stopRecording();
  expect(feedback.at(-1)).toBe("error:" + pasteError);
  expect(store.getState().error).toBe(pasteError); expect(store.getState().recording).toBeNull();
});

test("the explicit finish button inserts even within the hold-tap threshold", async () => {
  handleEvent({ type: "system-dictation-press" }); await delay(20);
  handleEvent({ type: "system-dictation-stop" }); await delay(20);
  expect(pasted).toEqual(["A dictated sentence."]);
  expect(feedback.at(-1)).toBe("success");
});

test("ordinary recording sends its meter without changing dictation feedback", async () => {
  await store.getState().startRecording("Meeting"); await store.getState().stopRecording();
  expect(feedback).toEqual([]); expect(pasted).toEqual([]);
  captureCallbacks?.onMeter?.(0.4);
  expect(meetingPackets).toEqual([{ id: meta.id, level: 0.4 }]);
  expect(meterPackets).toEqual([]);
  expect(captureCallbacks?.onMicrophone).toBeUndefined();
  expect(captureOptions?.dictation).toBe(false);
});

test("the floating meeting request captures both sources and retains its recording without pasting", async () => {
  stopResult = Promise.resolve({ ...meta, ephemeral: false, status: "complete", sources: ["microphone", "system"] });
  handleEvent({ type: "meeting-recording-start", title: "Zoom" }); await delay(20);
  expect(captureSources).toEqual(["microphone", "system"]);
  expect(recordingInputs[0].ephemeral).toBe(false);
  expect(recordingInputs[0].title).toBe("Zoom");
  expect(captureOptions?.dictation).toBe(false);
  captureCallbacks?.onMeter?.(0.6);
  expect(meetingPackets).toEqual([{ id: meta.id, level: 0.6 }]);
  handleEvent({ type: "meeting-recording-stop" }); await delay(20);
  expect(meetingFeedback).toEqual(["starting", "recording", "saving"]);
  expect(store.getState().recordings[0].ephemeral).toBe(false);
  expect(pasted).toEqual([]); expect(deleted).toBe(0);
});

test("duplicate meeting clicks and dictation shortcuts cannot open concurrent capture graphs", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  const first = store.getState().startMeetingRecording(); await delay(10);
  await store.getState().startMeetingRecording(); await store.getState().startSystemDictation();
  expect(captureStarts).toBe(1);
  pending.resolve(capture); await first;
  expect(feedback).toEqual([]); expect(recordingInputs.length).toBe(1);
});

test("a meeting click during model discovery waits for bootstrap instead of reporting a missing model", async () => {
  store.setState({ bootstrap: null });
  await store.getState().startMeetingRecording();
  expect(store.getState().recording?.ephemeral).toBe(false);
  expect(captureStarts).toBe(1); expect(meetingOpens).toBe(0);
});

test("meeting capture failure rolls back and opens the recorder for recovery", async () => {
  captureResult = Promise.reject(new Error("Device unavailable"));
  await store.getState().startMeetingRecording();
  expect(cancelled).toBe(1); expect(meetingFeedback.at(-1)).toBe("error");
  expect(meetingOpens).toBe(1); expect(store.getState().recording).toBeNull();
});

test("a failed final capture packet still saves the meeting audio already on disk", async () => {
  captureResult = Promise.resolve({ readLevels: () => ({}), stop: async () => { throw new Error("Capture tail failed"); } });
  stopResult = Promise.resolve({ ...meta, ephemeral: false, status: "complete" });
  await store.getState().startMeetingRecording(); await store.getState().stopRecording();
  expect(store.getState().recordings[0].ephemeral).toBe(false);
  expect(store.getState().error).toBe("Capture tail failed");
  expect(cancelled).toBe(0); expect(deleted).toBe(0); expect(store.getState().finalizing).toBe(false);
});
