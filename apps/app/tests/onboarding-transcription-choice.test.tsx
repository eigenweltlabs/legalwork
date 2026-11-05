import { afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AudioRecorderBootstrap } from "@legalwork/types/audio";
import { confirmTranscriptionChoice, TranscriptionChoices } from "../src/react-app/domains/onboarding/transcription-choice";
import { useRecorderStore } from "../src/react-app/domains/recorder/recorder-store";

const previous = useRecorderStore.getState();
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const writes = new Map<string, string>();
const downloads: string[] = [];
const bootstrap: AudioRecorderBootstrap = {
  models: [{ id: "whisper-small", label: "Standard", description: "", kind: "whisper", tier: "balanced", plan: "free", languages: "multilingual", approxSizeBytes: 0, files: [], state: "installed", downloadedBytes: 0, totalBytes: 0, installedSizeBytes: 0, error: null }],
  capabilities: { microphone: true, systemAudio: true, appAudio: false }, engine: { available: true, error: null },
  diarization: { installed: false, downloading: false, downloadedBytes: 0, totalBytes: 0, error: null },
  device: { totalMemoryGb: 16, logicalCores: 8, appleSilicon: true, fastDevice: true, recommendedModelId: "whisper-small" },
  cloud: { models: [{ model: "cloud-eu", name: "Cloud", region: "EU", enabled: true, available: true }], error: null },
  modelsDir: "", recordingsDir: "",
};
beforeEach(() => {
  writes.clear();
  downloads.length = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => writes.get(key) ?? null,
    setItem: (key: string, value: string) => writes.set(key, value),
  } });
  useRecorderStore.setState({ ...previous, bootstrap, transcriptionSource: "cloud", cloudModelId: "cloud-eu", modelId: "whisper-small",
    prewarm: async () => {}, downloadModel: async id => { downloads.push(id); },
  });
});
afterEach(() => {
  useRecorderStore.setState(previous, true);
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("an unselected draft does not infer a choice from the saved profile or write preferences", () => {
  const html = renderToStaticMarkup(<TranscriptionChoices value={null} options={[
    { source: "local", modelId: "whisper-small", title: "On this device", description: "Local" },
    { source: "cloud", modelId: "cloud-eu", title: "Cloud · Europe", description: "Cloud" },
  ]} onChange={() => { throw new Error("Rendering must not choose for the user"); }} />);
  expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
  expect(html).not.toContain('aria-checked="true"');
  expect(writes.size).toBe(0);
  expect(useRecorderStore.getState().transcriptionSource).toBe("cloud");
});

test("continuing without choosing leaves the current configuration untouched", async () => {
  expect(await confirmTranscriptionChoice(null)).toBe(false);
  expect(writes.size).toBe(0);
  expect(useRecorderStore.getState().cloudModelId).toBe("cloud-eu");
});

test("confirming an installed local model switches source without downloading again", async () => {
  expect(await confirmTranscriptionChoice({ source: "local", modelId: "whisper-small" })).toBe(true);
  expect(useRecorderStore.getState().transcriptionSource).toBe("local");
  expect(writes.size).toBeGreaterThan(0);
  expect(downloads).toEqual([]);
});

test("confirming cloud works without a local engine or installed model", async () => {
  useRecorderStore.setState({ transcriptionSource: "local", bootstrap: { ...bootstrap, models: [], engine: { available: false, error: "unavailable" } } });
  expect(await confirmTranscriptionChoice({ source: "cloud", modelId: "cloud-eu" })).toBe(true);
  expect(useRecorderStore.getState().transcriptionSource).toBe("cloud");
  expect(downloads).toEqual([]);
});

test("cloud availability is rechecked on Continue, without a silent regional fallback", async () => {
  useRecorderStore.setState({ bootstrap: { ...bootstrap, cloud: { models: [], error: null } } });
  expect(await confirmTranscriptionChoice({ source: "cloud", modelId: "cloud-eu" })).toBe(false);
  expect(writes.size).toBe(0);
});

test("a missing local model starts one download and stays in setup until installed", async () => {
  useRecorderStore.setState({ bootstrap: { ...bootstrap, models: bootstrap.models.map(model => ({ ...model, state: "not-installed" })) } });
  expect(await confirmTranscriptionChoice({ source: "local", modelId: "whisper-small" })).toBe(false);
  expect(downloads).toEqual(["whisper-small"]);
  useRecorderStore.setState({ bootstrap: { ...bootstrap, models: bootstrap.models.map(model => ({ ...model, state: "downloading" })) } });
  expect(await confirmTranscriptionChoice({ source: "local", modelId: "whisper-small" })).toBe(false);
  expect(downloads).toHaveLength(1);
  useRecorderStore.setState({ bootstrap });
  expect(await confirmTranscriptionChoice({ source: "local", modelId: "whisper-small" })).toBe(true);
  expect(downloads).toHaveLength(1);
});

test("a refused model selection cannot use the old ready cloud choice to advance", async () => {
  useRecorderStore.setState({ setModelId: () => {} });
  expect(await confirmTranscriptionChoice({ source: "local", modelId: "whisper-small" })).toBe(false);
  expect(downloads).toEqual([]);
  expect(writes.size).toBe(0);
});

test("setup does not change configuration while capture is starting", async () => {
  useRecorderStore.setState({ starting: true });
  expect(await confirmTranscriptionChoice({ source: "local", modelId: "whisper-small" })).toBe(false);
  expect(writes.size).toBe(0);
});
