import { afterAll, beforeEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createJSONStorage } from "zustand/middleware";
import type { AudioRecordingDetail, AudioRecordingMeta, AudioTranscriptSegment } from "@legalwork/types/audio";
import { recordingTime, transcriptTurns } from "../src/react-app/domains/recorder/recording-transcript";
import { useRecorderStore } from "../src/react-app/domains/recorder/recorder-store";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const events = new EventTarget();
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, "window", { configurable: true, value: events });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
const { usePanelTabStore, PANEL_OPEN_TAB_EVENT } = await import("../src/react-app/domains/session/panel/panel-tab-store");
const { recordingTranscriptTab, requestRecordingTranscript, closeRecordingTranscriptTabs } = await import("../src/react-app/domains/recorder/recording-transcript-tabs");
const { RecordingTranscriptPanel } = await import("../src/react-app/domains/recorder/recording-transcript-panel");
usePanelTabStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
const initialState = { ...useRecorderStore.getInitialState() };
const setRenderState = (state: Partial<typeof initialState>) => Object.assign(useRecorderStore.getInitialState(), state);
beforeEach(() => {
  setRenderState(initialState);
  usePanelTabStore.setState({ sessions: {}, transcriptArtifactTargets: {} });
});
afterAll(() => {
  setRenderState(initialState);
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const recording: AudioRecordingMeta = {
  id: "meeting", title: "Contract review", createdAt: 1, durationMs: 0, language: "auto", modelId: null,
  sources: ["microphone"], folderPath: "", audioPath: null, transcriptPath: null,
  sizeBytes: 0, segmentCount: 0, status: "recording", error: null,
};
const segment = (id: string, text: string, speaker?: number | null): AudioTranscriptSegment => ({
  id, text, speaker, startMs: 1000, endMs: 2000, final: true,
});
const render = (detail?: AudioRecordingDetail) => {
  const client = new QueryClient();
  if (detail) client.setQueryData(["recorder", "transcript", recording.id], detail);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(RecordingTranscriptPanel, { sessionId: "session", tab: recordingTranscriptTab(recording) })));
  } finally { client.clear(); }
};

test("speaker turns group consecutive speech without changing input segments", () => {
  const segments = [segment("a", "First", 0), segment("b", "continued", 0), segment("c", "Reply", 1), segment("d", "Again", 0)];
  const turns = transcriptTurns(segments, null);
  expect(turns.map(turn => turn.segments.map(item => item.id))).toEqual([["a", "b"], ["c"], ["d"]]);
  expect(segments).toHaveLength(4);
  expect(turns.map(turn => turn.speaker)).toEqual([0, 1, 0]);
  expect(transcriptTurns([segment("empty", " "), segment("unknown", "Unlabeled")], null)[0].speaker).toBeNull();
});

test("updated partials replace the live text without accumulating old words", () => {
  const final = [segment("a", "Final sentence")];
  const partial = { ...segment("partial", "New"), final: false };
  expect(transcriptTurns(final, partial)[0].segments.map(item => item.text)).toEqual(["Final sentence", "New"]);
  expect(transcriptTurns(final, { ...partial, text: "New sentence" })[0].segments.map(item => item.text)).toEqual(["Final sentence", "New sentence"]);
  expect(transcriptTurns([...final, { ...partial, final: true }], null)[0].segments).toHaveLength(2);
});

test("recording durations support long meetings", () => {
  expect(recordingTime(-100)).toBe("0:00");
  expect(recordingTime(65_000)).toBe("1:05");
  expect(recordingTime(4_418_000)).toBe("1:13:38");
});

test("recording tabs deduplicate and survive browser and artifact synchronization", () => {
  const store = usePanelTabStore.getState();
  const tab = recordingTranscriptTab(recording);
  store.openTab("session", tab);
  store.openTab("session", recordingTranscriptTab({ ...recording, id: "another" }));
  store.openTab("session", tab);
  store.syncArtifactTargets("session", []);
  store.syncTranscriptArtifacts("session", []);
  store.syncBrowserTabs("session", [], null);
  expect(usePanelTabStore.getState().sessions.session.tabs).toHaveLength(2);
  expect(usePanelTabStore.getState().sessions.session.activeTabId).toBe(tab.id);
});

test("recording tabs survive workspace layout persistence", () => {
  const tab = recordingTranscriptTab(recording);
  usePanelTabStore.getState().openTab("workspace:project", tab);
  const state = usePanelTabStore.getState();
  const persisted = usePanelTabStore.persist.getOptions().partialize?.(state);
  const restored = usePanelTabStore.persist.getOptions().merge?.(persisted, { ...state, sessions: {} });
  expect(restored?.sessions["workspace:project"].tabs).toEqual([tab]);
  expect(restored?.sessions["workspace:project"].activeTabId).toBe(tab.id);
});

test("deleting a recording closes only its transcript tabs across sessions", () => {
  const store = usePanelTabStore.getState();
  const tab = recordingTranscriptTab(recording);
  const other = recordingTranscriptTab({ ...recording, id: "another" });
  store.openTab("first", tab);
  store.openTab("first", other);
  store.openTab("second", tab);
  closeRecordingTranscriptTabs(recording.id);
  expect(usePanelTabStore.getState().sessions.first.tabs).toEqual([other]);
  expect(usePanelTabStore.getState().sessions.second.tabs).toEqual([]);
});

test("opening a transcript requests the viewer and skips ephemeral dictation", () => {
  const requests: unknown[] = [];
  const listener = (event: Event) => { if (event instanceof CustomEvent) requests.push(event.detail); };
  events.addEventListener(PANEL_OPEN_TAB_EVENT, listener);
  try {
    requestRecordingTranscript({ ...recording, ephemeral: true });
    expect(requests).toHaveLength(0);
    requestRecordingTranscript(recording);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject(recordingTranscriptTab(recording));
    requestRecordingTranscript(recording, "project");
    expect(requests[1]).toMatchObject({ ...recordingTranscriptTab(recording), destination: { kind: "workspace", workspaceId: "project" } });
  } finally { events.removeEventListener(PANEL_OPEN_TAB_EVENT, listener); }
});

test("an active transcript renders final and partial speech with recording feedback", () => {
  setRenderState({ recording, recordingStartedAt: Date.now(), segments: [segment("a", "Final speech", 0)], partial: { ...segment("b", "Live words", 1), final: false } });
  const html = render();
  expect(html).toContain("Final speech");
  expect(html).toContain("Live words");
  expect(html).toContain("Speaker 1");
  expect(html).toContain("Speaker 2");
  expect(html).toContain("Live transcript");
  expect(html).not.toContain("<audio");
  expect(html).not.toContain("Summary");
  setRenderState({ finalizing: true });
  const finishing = render();
  expect(finishing).toContain("Final speech");
  expect(finishing).toContain("Finishing transcription");
});

test("a saved transcript stays independent of a subsequent recording or dictation", () => {
  setRenderState({ recording: { ...recording, id: "dictation", ephemeral: true }, dictationRecordingId: "dictation", segments: [segment("private", "Unrelated dictation")], partial: segment("private-partial", "Unrelated partial") });
  const html = render({ meta: { ...recording, status: "complete", durationMs: 65_000 }, segments: [segment("saved", "Saved meeting text", 0)] });
  expect(html).toContain("Saved meeting text");
  expect(html).toContain("1:05");
  expect(html).not.toContain("Unrelated");
  expect(html).not.toContain("Live transcript");
  expect(html).not.toContain("<audio");
});
