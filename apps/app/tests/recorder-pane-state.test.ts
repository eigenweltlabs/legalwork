import { afterAll, beforeEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AudioRecorderBootstrap, AudioRecordingMeta } from "@legalwork/types/audio";
import { useRecorderStore } from "../src/react-app/domains/recorder/recorder-store";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = { getItem: (key: string) => key === "legalwork.recorder.setupDismissed" ? "1" : null };
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  localStorage: storage,
  __LEGALWORK_ELECTRON__: { invokeDesktop: async () => { throw new Error("No native calls in a render test"); } },
} });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
const { RecorderPane } = await import("../src/react-app/domains/recorder/recorder-pane");
const initialState = { ...useRecorderStore.getInitialState() };
// Render the supplied runtime state as the server snapshot, without starting capture.
const setRenderState = (state: Partial<typeof initialState>) => Object.assign(useRecorderStore.getInitialState(), state);
afterAll(() => {
  setRenderState(initialState);
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
const bootstrap: AudioRecorderBootstrap = {
  models: [{ id: "whisper-small", label: "Standard", description: "", kind: "whisper", tier: "balanced", plan: "free", languages: "multilingual", approxSizeBytes: 0, files: [], state: "installed", downloadedBytes: 0, totalBytes: 0, installedSizeBytes: 0, error: null }],
  capabilities: { microphone: true, systemAudio: true, appAudio: false }, engine: { available: true, error: null },
  diarization: { installed: false, downloading: false, downloadedBytes: 0, totalBytes: 0, error: null },
  device: { totalMemoryGb: 16, logicalCores: 8, appleSilicon: true, fastDevice: true, recommendedModelId: "whisper-small" },
  modelsDir: "", recordingsDir: "",
};
beforeEach(() => setRenderState({ ...initialState, initialized: true, bootstrap, modelId: "whisper-small", recordings: [] }));
const recording: AudioRecordingMeta = {
  id: "capture", title: "Test capture", createdAt: 1, durationMs: 0, language: "auto", modelId: null,
  sources: ["microphone"], folderPath: "", audioPath: null, transcriptPath: null,
  sizeBytes: 0, segmentCount: 0, status: "recording", error: null,
};
const render = () => renderToStaticMarkup(React.createElement(MemoryRouter, null,
  React.createElement(RecorderPane, { workspacePath: null })));
const expectNoRecordingUI = (html: string) => {
  expect(html).not.toContain("Recording in progress");
  expect(html).not.toContain("Finishing transcription");
  expect(html).not.toContain('role="meter"');
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  expect(buttons.some((button) => button.replace(/<[^>]*>/g, "").trim() === "Stop")).toBe(false);
  const recordButton = buttons.find((button) => button.replace(/<[^>]*>/g, "").trim() === "Record");
  expect(recordButton).toMatch(/<button\b[^>]*\sdisabled=/);
};

test("dictation capture and finalization do not appear as meeting recording", () => {
  setRenderState({ recording: { ...recording, ephemeral: true }, dictationRecordingId: recording.id, dictationState: "listening" });
  expectNoRecordingUI(render());
  setRenderState({ finalizing: true, dictationState: "transcribing" });
  expectNoRecordingUI(render());
});
test("a temporary capture stays hidden even without a dictation id", () => {
  setRenderState({ recording: { ...recording, ephemeral: true } });
  expectNoRecordingUI(render());
});
test("dictation startup locks capture without showing recording feedback", () => {
  setRenderState({ dictationState: "starting" });
  expectNoRecordingUI(render());
});
test("retained recordings still show recording and finishing feedback", () => {
  setRenderState({ recording, recordingStartedAt: Date.now(), levels: { microphone: .5 } });
  expect(render()).toContain("Recording in progress");
  expect(render()).toContain('role="meter"');
  setRenderState({ finalizing: true });
  expect(render()).toContain("Finishing transcription");
});
