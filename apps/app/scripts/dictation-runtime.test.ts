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
const cloudBootstrap: AudioRecorderBootstrap = { ...bootstrap, cloud: { models: [
  { model: "gemini-transcribe-live-eu", name: "Cloud", region: "EU", enabled: true, available: true },
] } };
let bootstrapResult = () => Promise.resolve(bootstrap);
const status = {
  appearance: "app", enabled: true, registered: true, accelerator: "Control+D", defaultAccelerator: "Control+D", customAccelerator: false,
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
let captureOptions: { dictation?: boolean; signal?: AbortSignal } | undefined;
let cancelled = 0;
let deleted = 0;
let liveShareStarts: string[] = [];
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
  startCapture: (sources: AudioCaptureSourceKind[], callbacks: CaptureCallbacks, options?: { dictation?: boolean; signal?: AbortSignal }) => {
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
  audioModelDelete: noop, audioModelDownload: noop, audioModelDownloadCancel: noop, audioOverlaySetVisible: noop, audioRecorderBootstrap: () => bootstrapResult(),
  audioSystemDictationMicrophonesGet: async () => ({ selection: "auto", selectedName: null, devices: [], resolvedDeviceId: null, activeName: null }),
  audioSystemDictationMicrophonesUpdate: noop, audioSystemDictationMicrophoneSelect: noop, audioSystemDictationMicrophoneActive: noop,
  audioSystemDictationGet: async () => status, audioSystemDictationOpenSettings: noop, audioSystemDictationReadiness: noop,
  audioSystemDictationRepairPermission: noop, audioSystemDictationRequestPermission: noop, audioSystemDictationSetEnabled: noop,
  audioSystemDictationSetAppearance: noop, audioSystemDictationSetShortcut: noop, audioSystemDictationSetShortcutCapture: noop,
  audioLiveTranscriptStart: async (root: string) => { liveShareStarts.push(root); return { ok: true, fileName: "live-call-transcript.md" }; }, audioLiveTranscriptStop: noop, audioImportStart: noop, audioImportSource: noop, audioImportFinish: noop,
  audioRecordingRename: noop, audioRecordingSaveToWorkspace: noop, desktopBridge: {},
}));
const { useRecorderStore: store, isCloudAvailabilityError, isTranscriptionReady } = await import("../src/react-app/domains/recorder/recorder-store");

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
  retainedRecordings = []; meetingOpens = 0; liveShareStarts = [];
  transcript = "A dictated sentence.";
  captureResult = Promise.resolve(capture); stopResult = Promise.resolve(meta);
  bootstrapResult = () => Promise.resolve(bootstrap);
  store.setState({ transcriptionSource: "local", cloudModelId: "gemini-transcribe-live-eu", liveTranscriptWorkspacePath: null, liveTranscriptSessionId: null, liveTranscriptNotifiedSessions: [], liveTranscriptDismissedPaths: [], initialized: true, bootstrap, systemDictation: status, modelId: "test-model", recording: null,
    recordingStartedAt: null, dictationRecordingId: null, dictationState: "idle", composerDictation: null, composerDictationLevel: 0, finalizing: false,
    permissions: { platform: "darwin", packaged: false, microphone: "granted", systemAudio: "granted" }, error: null, recordings: [], sources: ["microphone"],
    transcriber: { state: "idle", modelId: null, error: null } });
  await store.getState().init();
});
afterEach(async () => { if (store.getState().recording) await store.getState().cancelRecording(); });

test("a navigation availability check can fail without adding a sticky recording error", async () => {
  store.setState({ transcriptionSource: "cloud", bootstrap: cloudBootstrap });
  bootstrapResult = async () => { throw new Error("Cloud transcription is unavailable."); };
  await store.getState().refreshBootstrap();
  expect(store.getState().error).toBeNull();
  expect(isTranscriptionReady(store.getState())).toBe(true);
});

test("availability recovery clears the cloud warning without a manual dismissal", async () => {
  const warning = "Cloud transcription is unavailable. Sign in and check your organisation’s model settings.";
  store.setState({ transcriptionSource: "cloud", bootstrap: cloudBootstrap, error: warning });
  expect(isCloudAvailabilityError(store.getState())).toBe(true);
  bootstrapResult = async () => ({ ...bootstrap, cloud: { models: [], error: "Check failed" } });
  await store.getState().refreshBootstrap();
  expect(store.getState().error).toBe(warning);
  expect(isTranscriptionReady(store.getState())).toBe(true);
  bootstrapResult = async () => cloudBootstrap;
  await store.getState().refreshBootstrap();
  expect(store.getState().error).toBeNull();
});

test("an unavailable or different cloud model does not clear the selected model's warning", async () => {
  const warning = "Cloud transcription is currently unavailable.";
  store.setState({ transcriptionSource: "cloud", error: warning });
  bootstrapResult = async () => ({ ...bootstrap, cloud: { models: [] } });
  await store.getState().refreshBootstrap();
  expect(store.getState().error).toBe(warning);
  expect(isTranscriptionReady(store.getState())).toBe(false);
  bootstrapResult = async () => cloudBootstrap;
  store.setState({ cloudModelId: "gemini-transcribe-live-us" });
  await store.getState().refreshBootstrap();
  expect(store.getState().error).toBe(warning);
});

test("a late unavailable response cannot overwrite a newer healthy availability check", async () => {
  store.setState({ transcriptionSource: "cloud", error: "Cloud transcription is unavailable." });
  const pending = deferred<AudioRecorderBootstrap>();
  bootstrapResult = () => pending.promise;
  const stale = store.getState().refreshBootstrap();
  bootstrapResult = async () => cloudBootstrap;
  await store.getState().refreshBootstrap();
  pending.resolve({ ...bootstrap, cloud: { models: [] } });
  await stale;
  expect(isTranscriptionReady(store.getState())).toBe(true);
  expect(store.getState().error).toBeNull();
});

test("only captions from the active cloud recording clear an availability warning", async () => {
  store.setState({ transcriptionSource: "cloud", bootstrap: cloudBootstrap });
  await store.getState().startRecording("Cloud meeting");
  const warning = "Cloud transcription is unavailable. Check your connection or choose local transcription.";
  store.setState({ error: warning });
  const segment = { id: "s", text: "Hello", startMs: 0, endMs: 1000, final: false };
  handleEvent({ type: "transcriber-status", status: { state: "ready", modelId: "gemini-transcribe-live-eu", error: null } });
  expect(store.getState().error).toBe(warning);
  handleEvent({ type: "transcript-partial", streamId: "previous-recording", segment });
  expect(store.getState().error).toBe(warning);
  handleEvent({ type: "transcript-partial", streamId: meta.id, segment });
  expect(store.getState().error).toBeNull();
  store.setState({ error: warning });
  handleEvent({ type: "transcript-segment", streamId: meta.id, segment: { ...segment, final: true } });
  expect(store.getState().error).toBeNull();
});

test("healthy cloud settings and captions do not hide capture or speaker failures", async () => {
  store.setState({ transcriptionSource: "cloud", bootstrap: cloudBootstrap });
  await store.getState().startRecording("Cloud meeting");
  bootstrapResult = async () => cloudBootstrap;
  for (const error of ["Disk is full", "Cloud transcription disconnected. Your recording is saved on this device.", "Speaker detection is unavailable."]) {
    store.setState({ error });
    await store.getState().refreshBootstrap();
    handleEvent({ type: "transcript-segment", streamId: meta.id, segment: { id: error, text: "Hello", startMs: 0, endMs: 1000, final: true } });
    expect(store.getState().error).toBe(error);
    expect(isCloudAvailabilityError(store.getState())).toBe(false);
  }
});

test("a settings refresh cannot clear an error while cloud capture is starting or stopping", async () => {
  const warning = "Cloud transcription is unavailable.";
  store.setState({ transcriptionSource: "cloud", error: warning, starting: true });
  bootstrapResult = async () => cloudBootstrap;
  await store.getState().refreshBootstrap();
  expect(store.getState().error).toBe(warning);
  store.setState({ starting: false, finalizing: true });
  await store.getState().refreshBootstrap();
  expect(store.getState().error).toBe(warning);
  store.setState({ finalizing: false });
});

test("choosing a local model switches away from cloud for the next recording", async () => {
  store.setState({ bootstrap: { ...bootstrap, cloud: { models: [
    { model: "gemini-transcribe-live-eu", name: "Gemini", region: "EU", enabled: true, available: true },
  ] } } });
  store.getState().setTranscriptionSource("cloud", "gemini-transcribe-live-eu");
  expect(store.getState().transcriptionSource).toBe("cloud");
  store.getState().setModelId("test-model");
  expect(store.getState().transcriptionSource).toBe("local");
  await store.getState().startRecording("Local meeting");
  expect(recordingInputs[0].modelId).toBe("test-model");
});

test("model selection cannot switch transcription engines during capture startup", () => {
  store.setState({ transcriptionSource: "cloud", starting: true });
  try {
    store.getState().setModelId("test-model");
    expect(store.getState().transcriptionSource).toBe("cloud");
  } finally { store.setState({ starting: false }); }
});

test("background speaker processing leaves Record enabled and old updates do not change the next capture", async () => {
  const previous = { ...meta, id: "previous-meeting", ephemeral: false, status: "complete", speakerProcessing: true } satisfies AudioRecordingMeta;
  stopResult = Promise.resolve(previous);
  await store.getState().startRecording("First meeting");
  await store.getState().stopRecording();
  expect(store.getState().finalizing).toBe(false);
  expect(store.getState().recording).toBeNull();
  expect(store.getState().recordings[0].speakerProcessing).toBe(true);

  await store.getState().startRecording("Next meeting");
  expect(captureStarts).toBe(2);
  const current = store.getState().recording;
  handleEvent({ type: "transcript-speakers-updated", streamId: previous.id, segments: [], speakerNames: { "0": "Old speaker" } });
  handleEvent({ type: "recording-warning", recordingId: previous.id, error: "Old provider failed" });
  handleEvent({ type: "recording-updated", meta: { ...previous, speakerProcessing: false, speakerCount: 2 } });
  expect(store.getState().recording).toBe(current);
  expect(store.getState().finalizing).toBe(false);
  expect(store.getState().error).toBeNull();
  expect(store.getState().recordings[0].speakerProcessing).toBe(false);
  expect(store.getState().recordings[0].speakerCount).toBe(2);
});

test("cloud dictation works without an installed local model and uses the selected regional alias", async () => {
  store.setState({ transcriptionSource: "cloud", bootstrap: { ...bootstrap, models: [], engine: { available: false, error: "Not installed" },
    cloud: { models: [{ model: "gemini-transcribe-live-eu", name: "Gemini", region: "EU", enabled: true, available: true }] } } });
  const inserted: string[] = [];
  await store.getState().startComposerDictation("chat-one", text => inserted.push(text));
  expect(recordingInputs[0].modelId).toBe("gemini-transcribe-live-eu");
  await store.getState().stopRecording();
  expect(inserted).toEqual([transcript]);
});

test("a cloud transcription error never inserts a partial transcript", async () => {
  stopResult = Promise.resolve({ ...meta, status: "error", error: "Cloud disconnected" });
  const inserted: string[] = [];
  await store.getState().startComposerDictation("chat-one", text => inserted.push(text));
  await store.getState().stopRecording();
  expect(inserted).toEqual([]);
  expect(pasted).toEqual([]);
  expect(store.getState().error).toBe("Cloud disconnected");
});

test("an unavailable cloud choice does not fall back or start capture", async () => {
  store.setState({ transcriptionSource: "cloud", bootstrap: { ...bootstrap, cloud: { models: [] } } });
  await store.getState().startRecording("Cloud meeting");
  expect(captureStarts).toBe(0);
  expect(recordingInputs).toEqual([]);
  expect(store.getState().error).not.toBeNull();
});

test("composer dictation inserts into its draft without native paste, HUD or a retained recording", async () => {
  const inserted: string[] = [];
  store.setState({ systemDictation: { ...status, enabled: false, registered: false } });
  await store.getState().startComposerDictation("chat-one", text => inserted.push(text));
  expect(store.getState().composerDictation?.ownerId).toBe("chat-one");
  expect(recordingInputs[0].ephemeral).toBe(true);
  expect(captureSources).toEqual(["microphone"]);
  expect(captureOptions?.dictation).toBe(true);
  captureCallbacks?.onMeter?.(.6);
  expect(store.getState().composerDictationLevel).toBe(.6);
  expect(meterPackets).toEqual([]);
  await store.getState().stopRecording();
  expect(inserted).toEqual([transcript]);
  expect(pasted).toEqual([]); expect(feedback).toEqual([]); expect(meetingFeedback).toEqual([]);
  expect(store.getState().recordings).toEqual([]); expect(deleted).toBe(1);
  expect(store.getState().composerDictation).toBeNull();
});

test("canceling composer dictation during startup releases capture without inserting", async () => {
  const inserted: string[] = [];
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  const start = store.getState().startComposerDictation("chat-one", text => inserted.push(text));
  await delay(10); await store.getState().cancelRecording();
  pending.resolve(capture); await start;
  expect(captureStops).toBe(1); expect(cancelled).toBe(1);
  expect(inserted).toEqual([]); expect(pasted).toEqual([]); expect(feedback).toEqual([]);
  expect(store.getState().composerDictation).toBeNull();
});

test("canceling while the final transcript is pending does not insert into a departed composer", async () => {
  const inserted: string[] = [];
  await store.getState().startComposerDictation("chat-one", text => inserted.push(text));
  const pending = deferred<AudioRecordingMeta>(); stopResult = pending.promise;
  const finish = store.getState().stopRecording();
  await delay(10); await store.getState().cancelRecording();
  pending.resolve(meta); await finish;
  expect(inserted).toEqual([]); expect(deleted).toBe(1); expect(feedback).toEqual([]);
  expect(store.getState().composerDictation).toBeNull();
});

test("silent composer dictation ends without an error or inserting text", async () => {
  transcript = "";
  const inserted: string[] = [];
  await store.getState().startComposerDictation("chat-one", text => inserted.push(text));
  await store.getState().stopRecording();
  expect(inserted).toEqual([]); expect(store.getState().error).toBeNull(); expect(feedback).toEqual([]);
});

test("transcribe-and-send waits for transcription and sends exactly once while completion is pending", async () => {
  const sent: string[] = [];
  const transcriptReady = deferred<AudioRecordingMeta>();
  const sendReady = deferred<void>();
  stopResult = transcriptReady.promise;
  await store.getState().startComposerDictation("chat-one", async text => {
    sent.push(text);
    await sendReady.promise;
  });
  const finish = store.getState().stopRecording();
  await delay(10);
  expect(sent).toEqual([]);
  transcriptReady.resolve(meta);
  await delay(10);
  expect(sent).toEqual([transcript]);
  await store.getState().stopRecording();
  expect(sent).toHaveLength(1);
  expect(store.getState().finalizing).toBe(true);
  sendReady.resolve();
  await finish;
  expect(store.getState().composerDictation).toBeNull();
  expect(deleted).toBe(1);
});

test("a failed asynchronous composer completion reports the error and releases capture", async () => {
  await store.getState().startComposerDictation("chat-one", async () => { throw new Error("Message could not be sent"); });
  await store.getState().stopRecording();
  expect(store.getState().error).toBe("Message could not be sent");
  expect(store.getState().composerDictation).toBeNull();
  expect(deleted).toBe(1);
  expect(pasted).toEqual([]);
});

test("a canceled composer start cannot acquire the microphone after initialization", async () => {
  const controller = new AbortController();
  const start = store.getState().startComposerDictation("chat-one", () => {}, controller.signal);
  controller.abort(); await start;
  expect(captureStarts).toBe(0); expect(store.getState().composerDictation).toBeNull();
});

test("composer dictation cannot replace another capture or its completion target", async () => {
  const inserted: string[] = [];
  await store.getState().startComposerDictation("chat-one", text => inserted.push(text));
  await expect(store.getState().startComposerDictation("chat-two", () => {})).rejects.toThrow();
  expect(store.getState().composerDictation?.ownerId).toBe("chat-one");
  expect(captureStarts).toBe(1);
  await store.getState().stopRecording(); expect(inserted).toEqual([transcript]);
});

test("composer dictation capture failure clears ownership and never opens a native error HUD", async () => {
  captureResult = Promise.reject(new Error("Device unavailable"));
  await expect(store.getState().startComposerDictation("chat-one", () => {})).rejects.toThrow("Device unavailable");
  expect(store.getState().composerDictation).toBeNull(); expect(feedback).toEqual([]);
  expect(store.getState().recording).toBeNull(); expect(cancelled).toBe(1);
});

test("a composer capture flush failure clears ownership without native feedback or a paste", async () => {
  captureResult = Promise.resolve({ readLevels: () => ({}), stop: async () => { throw new Error("Capture tail failed"); } });
  await store.getState().startComposerDictation("chat-one", () => {});
  await store.getState().stopRecording();
  expect(store.getState().composerDictation).toBeNull(); expect(store.getState().error).toBe("Capture tail failed");
  expect(feedback).toEqual([]); expect(pasted).toEqual([]); expect(cancelled).toBe(1);
});

test("composer dictation reports a missing model without starting capture", async () => {
  store.setState({ modelId: "not-installed" });
  await expect(store.getState().startComposerDictation("chat-one", () => {})).rejects.toThrow();
  expect(captureStarts).toBe(0); expect(store.getState().composerDictation).toBeNull();
});

test("composer dictation refreshes pending model discovery before starting", async () => {
  store.setState({ bootstrap: null });
  await store.getState().startComposerDictation("chat-one", () => {});
  expect(captureStarts).toBe(1); expect(store.getState().composerDictation?.ownerId).toBe("chat-one");
});

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

test("a hold release during startup cancels instead of finalizing an unopened microphone", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  handleEvent({ type: "system-dictation-press" }); await delay(10);
  handleEvent({ type: "system-dictation-release" }); await delay(10);
  pending.resolve(capture); await delay(20);
  expect(pasted).toEqual([]); expect(feedback.at(-1)).toBe("cancelled");
  expect(captureStops).toBe(1); expect(cancelled).toBe(1);
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

test("a third tap before capture is ready cancels instead of transcribing an unopened microphone", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  handleEvent({ type: "system-dictation-press" }); await delay(10);
  handleEvent({ type: "system-dictation-status", status: { ...status, mode: "tap" } });
  handleEvent({ type: "system-dictation-release" });
  handleEvent({ type: "system-dictation-release" });
  expect(captureOptions?.signal?.aborted).toBe(true);
  pending.resolve(capture); await delay(20);
  expect(store.getState().dictationState).toBe("idle");
  expect(store.getState().error).toBeNull();
  expect(feedback).not.toContain("transcribing");
  expect(pasted).toEqual([]);
  expect(cancelled).toBe(1);
  expect(captureStops).toBe(1);
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

test("one press cancels hands-free startup and a later dictation can finish normally", async () => {
  const pending = deferred<CaptureHandle>(); captureResult = pending.promise;
  handleEvent({ type: "system-dictation-toggle" }); await delay(10);
  handleEvent({ type: "system-dictation-release" });
  pending.resolve(capture); await delay(20);
  expect(pasted).toEqual([]); expect(captureStops).toBe(1);
  expect(feedback.at(-1)).toBe("cancelled");
  await delay(210);
  captureResult = Promise.resolve(capture);
  handleEvent({ type: "system-dictation-press" }); await delay(20);
  handleEvent({ type: "system-dictation-release" }); await delay(20);
  expect(pasted).toEqual(["A dictated sentence."]);
  expect(feedback.at(-1)).toBe("success");
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
  expect(meetingFeedback).toEqual(["starting", "recording", "saving", "idle"]);
  expect(store.getState().meeting?.state).toBe("idle");
  expect(store.getState().recording).toBeNull();
  expect(meetingOpens).toBe(0);
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

test("meeting capture failure reports the error without opening or navigating the app", async () => {
  captureResult = Promise.reject(new Error("Device unavailable"));
  await store.getState().startMeetingRecording();
  expect(cancelled).toBe(1); expect(meetingFeedback.at(-1)).toBe("error");
  expect(meetingOpens).toBe(0); expect(store.getState().recording).toBeNull();
});

test("a failed final capture packet still saves the meeting audio already on disk", async () => {
  captureResult = Promise.resolve({ readLevels: () => ({}), stop: async () => { throw new Error("Capture tail failed"); } });
  stopResult = Promise.resolve({ ...meta, ephemeral: false, status: "complete" });
  await store.getState().startMeetingRecording(); await store.getState().stopRecording();
  expect(store.getState().recordings[0].ephemeral).toBe(false);
  expect(store.getState().error).toBe("Capture tail failed");
  expect(cancelled).toBe(0); expect(deleted).toBe(0); expect(store.getState().finalizing).toBe(false);
});


test("automatic live attachment respects opt-out and starts fresh for the next recording", async () => {
  await store.getState().startRecording("Meeting", { projectId: "project-a" });
  expect(await store.getState().startLiveTranscriptShare("chat-a", "/workspace-a", undefined, undefined, true)).toBe(true);
  expect(store.getState().liveTranscriptWorkspacePath).toBe("/workspace-a");
  await store.getState().stopLiveTranscriptShare();
  expect(await store.getState().startLiveTranscriptShare("chat-b", "/workspace-a", undefined, undefined, true)).toBe(false);
  expect(liveShareStarts).toEqual(["/workspace-a"]);
  expect(await store.getState().startLiveTranscriptShare("chat-b", "/workspace-a")).toBe(true);
  await store.getState().stopLiveTranscriptShare();
  await store.getState().cancelRecording();
  await store.getState().startRecording("Next meeting", { projectId: "project-a" });
  expect(await store.getState().startLiveTranscriptShare("chat-a", "/workspace-a", undefined, undefined, true)).toBe(true);
});

test("dictation cannot be shared as a live meeting", async () => {
  await store.getState().startRecording("Dictation", { systemDictation: true });
  expect(await store.getState().startLiveTranscriptShare("chat", "/workspace")).toBe(false);
  expect(liveShareStarts).toEqual([]);
});


test("Stop immediately marks a meeting as finishing, then clears both recording indicators", async () => {
  const pending = deferred<AudioRecordingMeta>();
  stopResult = pending.promise;
  await store.getState().startMeetingRecording();
  const stopping = store.getState().stopRecording();
  await delay(10);
  expect(captureStops).toBe(1);
  expect(store.getState().finalizing).toBe(true);
  expect(meetingFeedback.at(-1)).toBe("saving");
  await store.getState().stopRecording();
  expect(captureStops).toBe(1);
  pending.resolve({ ...meta, ephemeral: false, status: "complete" });
  await stopping;
  expect(store.getState().recording).toBeNull();
  expect(store.getState().finalizing).toBe(false);
  expect(store.getState().meeting?.state).toBe("idle");
  expect(meetingOpens).toBe(0);
});

test("simultaneous input partials survive the other input finishing or clearing", async () => {
  await store.getState().startMeetingRecording();
  expect(recordingInputs[0].separateSources).toBe(true);
  const segment = { id: "mic-partial", text: "Local speech", startMs: 1000, endMs: 2000, final: false, source: "microphone", speaker: 0 } satisfies import("@legalwork/types/audio").AudioTranscriptSegment;
  const remote = { ...segment, id: "system-partial", text: "Remote speech", source: "system", speaker: 1 } satisfies import("@legalwork/types/audio").AudioTranscriptSegment;
  handleEvent({ type: "transcript-partial", streamId: meta.id, segment });
  handleEvent({ type: "transcript-partial", streamId: meta.id, segment: remote });
  expect(store.getState().partials).toHaveLength(2);
  handleEvent({ type: "transcript-partial", streamId: meta.id, segment: { ...segment, text: "Local speech updated" } });
  expect(store.getState().partials).toHaveLength(2);
  handleEvent({ type: "transcript-segment", streamId: meta.id, segment: { ...remote, final: true } });
  expect(store.getState().partials.map(s => s.text)).toEqual(["Local speech updated"]);
  handleEvent({ type: "transcript-partial-clear", streamId: meta.id, source: "system", endMs: 3000 });
  expect(store.getState().partials).toHaveLength(1);
  handleEvent({ type: "transcript-partial-clear", streamId: meta.id, source: "microphone", endMs: 3000 });
  expect(store.getState().partials).toHaveLength(0);
});

test("cloud meetings enable the second speaker pass without local models and apply revisions without stopping", async () => {
  store.setState({ transcriptionSource: "cloud", bootstrap: { ...bootstrap, cloud: { models: [
    { model: "gemini-transcribe-live-eu", name: "Cloud", region: "EU", enabled: true, available: true },
  ] } } });
  await store.getState().startMeetingRecording();
  expect(recordingInputs[0].diarize).toBe(true);
  const segment = { id: "remote", text: "Remote speech", startMs: 1000, endMs: 2000, final: true, source: "system", speaker: 1 } satisfies import("@legalwork/types/audio").AudioTranscriptSegment;
  handleEvent({ type: "transcript-segment", streamId: meta.id, segment });
  handleEvent({ type: "transcript-speakers-updated", streamId: meta.id, segments: [{ ...segment, speaker: 2 }], speakerNames: { 2: "System audio 2" } });
  expect(store.getState().segments).toHaveLength(1);
  expect(store.getState().segments[0].speaker).toBe(2);
  expect(store.getState().recording?.speakerNames?.[2]).toBe("System audio 2");
  const first = { ...segment, id: "remote:w0", text: "Remote", speaker: 2 };
  const second = { ...segment, id: "remote:w1", text: "speech", speaker: 3 };
  handleEvent({ type: "transcript-speakers-updated", streamId: meta.id, replacedIds: [segment.id], segments: [first, second], speakerNames: { 2: "One", 3: "Two" } });
  expect(store.getState().segments.map(item => item.id)).toEqual([first.id, second.id]);
  handleEvent({ type: "transcript-partial", streamId: meta.id, segment: { ...segment, final: false }, parts: [{ ...first, final: false }, { ...second, final: false }] });
  expect(store.getState().partials.map(item => item.speaker)).toEqual([2, 3]);
  handleEvent({ type: "recording-warning", recordingId: meta.id, error: "Speaker detection is unavailable." });
  expect(store.getState().recording?.id).toBe(meta.id);
  expect(captureStops).toBe(0);
});
