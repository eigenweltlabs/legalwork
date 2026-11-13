import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import DOMPurify from "dompurify";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AudioRecordingDetail, AudioRecordingMeta, AudioTranscriptSegment } from "@legalwork/types/audio";
import { recordingTime, transcriptTurns } from "../src/react-app/domains/recorder/recording-transcript";
import { useRecorderStore } from "../src/react-app/domains/recorder/recorder-store";
import { createPanelTabStore, usePanelTabStore, PANEL_OPEN_TAB_EVENT } from "../src/react-app/domains/session/panel/panel-tab-store";
import { recordingTranscriptTab, requestRecordingTranscript, requestStartedRecordingTranscript, closeRecordingTranscriptTabs } from "../src/react-app/domains/recorder/recording-transcript-tabs";
import { RecordingTranscript, RecordingTranscriptPanel } from "../src/react-app/domains/recorder/recording-transcript-panel";
import { RecordingTranscriptPage } from "../src/react-app/domains/recorder/recording-transcript-page";

let previousWindow: PropertyDescriptor | undefined;
let previousStorage: PropertyDescriptor | undefined;
let previousSessionStorage: PropertyDescriptor | undefined;
let previousPanels = usePanelTabStore.getState();
const events = new EventTarget();
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(events, "location", { value: { href: "http://localhost/#/recorder" } });
Object.defineProperty(events, "localStorage", { value: storage });
Object.defineProperty(events, "sessionStorage", { value: storage });
const initialState = { ...useRecorderStore.getInitialState() };
const setRenderState = (state: Partial<typeof initialState>) => Object.assign(useRecorderStore.getInitialState(), state);
// Bun has no browser DOM. Follow the Markdown renderer tests' scoped stand-in;
// these assertions cover the summary structure, not browser sanitization.
const previousSanitize = Object.getOwnPropertyDescriptor(DOMPurify, "sanitize");
beforeAll(() => Object.defineProperty(DOMPurify, "sanitize", {
  configurable: true, value: (html: string) => html,
}));
afterAll(() => {
  if (previousSanitize) Object.defineProperty(DOMPurify, "sanitize", previousSanitize);
  else Reflect.deleteProperty(DOMPurify, "sanitize");
});
beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  previousPanels = usePanelTabStore.getState();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  setRenderState(initialState);
  usePanelTabStore.setState({ sessions: {}, transcriptArtifactTargets: {} });
});
afterEach(() => {
  setRenderState(initialState);
  usePanelTabStore.setState(previousPanels, true);
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (previousSessionStorage) Object.defineProperty(globalThis, "sessionStorage", previousSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

const recording: AudioRecordingMeta = {
  id: "meeting", title: "Contract review", createdAt: 1, durationMs: 0, language: "auto", modelId: null,
  sources: ["microphone"], folderPath: "", audioPath: null, transcriptPath: null,
  sizeBytes: 0, segmentCount: 0, status: "recording", error: null,
};
const segment = (id: string, text: string, speaker?: number | null): AudioTranscriptSegment => ({
  id, text, speaker, startMs: 1000, endMs: 2000, final: true,
});
const render = (detail?: AudioRecordingDetail, surface: "panel" | "inline" | "page" = "panel") => {
  const client = new QueryClient();
  if (detail) client.setQueryData(["recorder", "transcript", recording.id], detail);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      surface === "page"
        ? React.createElement(RecordingTranscriptPage, { recordingId: recording.id, backLabel: "Recordings", onBack: () => {} })
        : surface === "inline"
        ? React.createElement(RecordingTranscript, { recordingId: recording.id })
        : React.createElement(RecordingTranscriptPanel, { sessionId: "session", tab: recordingTranscriptTab(recording), onClose: () => {} })));
  } finally { client.clear(); }
};

test("saved cloud transcripts offer Summarize even when automatic processing is disabled", () => {
  setRenderState({ meetingNotes: { enabled: false, model: "", instructions: "" } });
  const detail = { meta: { ...recording, status: "complete", transcriptionSource: "cloud", modelId: "gemini-transcribe-live-eu" },
    segments: [segment("saved", "Review the contract.", 0)] } satisfies AudioRecordingDetail;
  for (const surface of ["panel", "inline", "page"] satisfies Array<"panel" | "inline" | "page">) {
    const html = render(detail, surface);
    const button = html.match(/<button[^>]*aria-label="Summarize"[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=""');
  }
  expect(render({ ...detail, meta: { ...detail.meta, summary: "Existing summary" } })).not.toContain("Summarize");
  expect(render({ ...detail, meta: { ...detail.meta, transcriptionSource: "local" } })).not.toContain("Summarize");
  expect(render({ ...detail, segments: [] })).not.toContain("Summarize");
});

test("caption reconnection is visible in every transcript surface and clears when recovered", () => {
  setRenderState({ recording, transcriptionReconnecting: true });
  for (const surface of ["panel", "inline", "page"] satisfies Array<"panel" | "inline" | "page">) {
    expect(render(undefined, surface)).toContain("Audio is still recording. Reconnecting live transcription...");
  }
  setRenderState({ transcriptionReconnecting: false });
  expect(render()).not.toContain("Reconnecting live transcription");
  setRenderState({ recording: null });
  expect(render({ meta: { ...recording, status: "complete", error: "Some speech may be missing from the transcript." }, segments: [] }))
    .toContain("Some speech may be missing from the transcript.");
});

test("Summarize is disabled while processing is in progress", () => {
  for (const processing of [{ summaryProcessing: true }, { speakerProcessing: true }]) {
    const html = render({ meta: { ...recording, status: "complete", transcriptionSource: "cloud", ...processing }, segments: [segment("saved", "Words", 0)] });
    const button = html.match(/<button[^>]*aria-label="Summarize"[^>]*>/)?.[0];
    expect(button).toContain('disabled=""');
  }
});

test("an interrupted cloud recording exposes an enabled summary retry and its connection error", () => {
  const detail = { meta: { ...recording, status: "error", transcriptionSource: "cloud", modelId: "gemini-transcribe-live-eu",
    speakerProcessing: false, summaryProcessing: false, speakerError: "fetch failed",
    summaryError: "LegalWork is disconnected. Open Settings to reconnect, then try again." },
    segments: [segment("saved", "Saved before the interruption.", 0)] } satisfies AudioRecordingDetail;
  for (const surface of ["panel", "inline", "page"] satisfies Array<"panel" | "inline" | "page">) {
    const html = render(detail, surface);
    const button = html.match(/<button[^>]*aria-label="Retry summary"[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=""');
    expect(html).toContain('role="alert">LegalWork is disconnected.');
  }
});

test("speaker detection and summary generation are shown as successive stages", () => {
  const detail = { meta: { ...recording, status: "complete", transcriptionSource: "cloud", summaryProcessing: true },
    segments: [segment("saved", "Words", 0)] } satisfies AudioRecordingDetail;
  const waiting = render({ ...detail, meta: { ...detail.meta, speakerProcessing: true } });
  expect(waiting).not.toContain("Preparing meeting notes");
  expect(waiting).not.toContain("Summarizing");
  const generating = render({ ...detail, meta: { ...detail.meta, speakerProcessing: false } });
  expect(generating).toContain("Preparing meeting notes");
  expect(generating).toContain("Summarizing");
});

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
  expect(transcriptTurns(final, partial).flatMap(turn => turn.segments.map(item => item.text))).toEqual(["Final sentence", "New"]);
  expect(transcriptTurns(final, { ...partial, text: "New sentence" }).flatMap(turn => turn.segments.map(item => item.text))).toEqual(["Final sentence", "New sentence"]);
  expect(transcriptTurns([...final, { ...partial, final: true }], null).flatMap(turn => turn.segments)).toHaveLength(2);
  expect(transcriptTurns(final, partial)).toHaveLength(2);
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
  // The shared store may have been imported without browser storage by another
  // test. Build a fresh persisted store while this test's storage is installed.
  const panels = createPanelTabStore();
  const tab = recordingTranscriptTab(recording);
  panels.getState().openTab("workspace:project", tab);
  const state = panels.getState();
  const persisted = panels.persist.getOptions().partialize?.(state);
  const restored = panels.persist.getOptions().merge?.(persisted, { ...state, sessions: {} });
  expect(restored?.sessions["workspace:project"].tabs).toEqual([tab]);
  expect(restored?.sessions["workspace:project"].activeTabId).toBe(tab.id);
});

test("recording previews replace one another and pinned or live transcript tabs stay open", () => {
  const store = usePanelTabStore.getState();
  const scope = "workspace:project";
  const first = recordingTranscriptTab(recording);
  const second = recordingTranscriptTab({ ...recording, id: "second" });
  const live = recordingTranscriptTab({ ...recording, id: "live" });
  store.openTab(scope, first, undefined, undefined, { preview: true });
  expect(usePanelTabStore.getState().sessions[scope].panes[0].previewTabId).toBe(first.id);
  store.openTab(scope, second, undefined, undefined, { preview: true });
  expect(usePanelTabStore.getState().sessions[scope].tabs.map(tab => tab.id)).toEqual([second.id]);
  store.keepTab(scope, second.id);
  store.openTab(scope, live);
  store.openTab(scope, first, undefined, undefined, { preview: true });
  expect(usePanelTabStore.getState().sessions[scope].tabs.map(tab => tab.id)).toEqual([second.id, live.id, first.id]);
  store.openTab(scope, first, undefined, undefined, { preview: false });
  expect(usePanelTabStore.getState().sessions[scope].panes[0].previewTabId).toBeUndefined();
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

test("only workspace transcript requests open viewer tabs; global recordings and dictation do not", () => {
  const requests: unknown[] = [];
  const listener = (event: Event) => { if (event instanceof CustomEvent) requests.push(event.detail); };
  events.addEventListener(PANEL_OPEN_TAB_EVENT, listener);
  try {
    requestRecordingTranscript({ ...recording, ephemeral: true }, "project");
    expect(requests).toHaveLength(0);
    requestRecordingTranscript(recording);
    requestRecordingTranscript({ ...recording, projectIds: ["linked-project"] }, null);
    requestRecordingTranscript(recording, "");
    expect(requests).toHaveLength(0);
    requestRecordingTranscript(recording, "project");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ ...recordingTranscriptTab(recording), destination: { kind: "workspace", workspaceId: "project" } });
  } finally { events.removeEventListener(PANEL_OPEN_TAB_EVENT, listener); }
});

test("unlinked starts stay in place; choosing a project opens its transcript even from the global recorder", () => {
  const requests: unknown[] = [];
  const listener = (event: Event) => { if (event instanceof CustomEvent) requests.push(event.detail); };
  events.addEventListener(PANEL_OPEN_TAB_EVENT, listener);
  try {
    requestStartedRecordingTranscript(recording);
    requestStartedRecordingTranscript({ ...recording, ephemeral: true, projectIds: ["recording-project"] });
    expect(requests).toHaveLength(0);
    requestStartedRecordingTranscript({ ...recording, projectIds: ["recording-project"] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ destination: { kind: "workspace", workspaceId: "recording-project" }, openBesideChat: true });
    // Explicitly attaching a global recording still opens it beside chat.
    requestRecordingTranscript(recording, "currently-open-workspace");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ destination: { kind: "workspace", workspaceId: "currently-open-workspace" }, openBesideChat: true });
  } finally { events.removeEventListener(PANEL_OPEN_TAB_EVENT, listener); }
});

test("an active transcript renders final and partial speech with recording feedback", () => {
  setRenderState({ recording, recordingStartedAt: Date.now(), segments: [segment("a", "Final speech", 0)], partials: [{ ...segment("b", "Live words", 1), final: false }] });
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
  setRenderState({ recording: { ...recording, id: "dictation", ephemeral: true }, dictationRecordingId: "dictation", segments: [segment("private", "Unrelated dictation")], partials: [segment("private-partial", "Unrelated partial")] });
  const html = render({ meta: { ...recording, status: "complete", durationMs: 65_000 }, segments: [segment("saved", "Saved meeting text", 0)] });
  expect(html).toContain("Saved meeting text");
  expect(html).toContain("1:05");
  expect(html).not.toContain("Unrelated");
  expect(html).not.toContain("Live transcript");
  expect(html).not.toContain("<audio");
});

test("the global Recorder can display saved and live transcripts without a viewer tab", () => {
  const requests: unknown[] = [];
  const listener = (event: Event) => { if (event instanceof CustomEvent) requests.push(event.detail); };
  events.addEventListener(PANEL_OPEN_TAB_EVENT, listener);
  try {
    const html = render({ meta: { ...recording, status: "complete" }, segments: [segment("saved", "Saved meeting", 0)] }, "inline");
    expect(html).toContain("Contract review");
    expect(html).toContain("Saved meeting");
    setRenderState({ recording, recordingStartedAt: Date.now(), segments: [segment("live", "Current meeting")], partials: [{ ...segment("partial", "Still speaking"), final: false }] });
    const live = render(undefined, "inline");
    expect(live).toContain("Current meeting");
    expect(live).toContain("Still speaking");
    expect(live).toContain("Live transcript");
    expect(requests).toHaveLength(0);
    expect(usePanelTabStore.getState().sessions).toEqual({});
  } finally { events.removeEventListener(PANEL_OPEN_TAB_EVENT, listener); }
});

test("transcript tabs use document expand/close controls while full-page details use back navigation", () => {
  const detail = { meta: { ...recording, status: "complete" }, segments: [segment("saved", "Saved meeting", 0)] } satisfies AudioRecordingDetail;
  const panel = render(detail);
  expect(panel).toContain('data-artifact-expanded="false"');
  expect(panel).toContain('aria-label="Expand document"');
  expect(panel).toContain('aria-label="Close tab"');
  const page = render(detail, "page");
  expect(page).toContain("Recordings");
  expect(page).toContain("Saved meeting");
  expect(page).not.toContain('aria-label="Expand document"');
  expect(page).not.toContain('aria-label="Close tab"');
});

test("a split recording shows both simultaneous input labels in chronological order", () => {
  setRenderState({
    recording: { ...recording, speakerNames: { 0: "Microphone", 1: "System audio" } },
    partials: [
      { ...segment("system", "Remote words", 1), startMs: 1200, final: false, source: "system" },
      { ...segment("microphone", "Local words", 0), startMs: 1000, final: false, source: "microphone" },
    ],
  });
  const html = render();
  expect(html).toContain("Microphone");
  expect(html).toContain("System audio");
  expect(html.indexOf("Local words")).toBeLessThan(html.indexOf("Remote words"));
});

test("long monologues and pauses start readable new transcript turns", () => {
  const words = Array.from({ length: 20 }, (_, i) => ({ ...segment(String(i), "A complete sentence. ".repeat(5), 0), startMs: i * 2000, endMs: (i + 1) * 2000 }));
  const turns = transcriptTurns(words, null);
  expect(turns.length).toBeGreaterThan(1);
  expect(turns.every(turn => turn.segments.reduce((n, part) => n + part.text.length, 0) <= 600)).toBe(true);
  expect(turns.flatMap(turn => turn.segments)).toEqual(words);
  expect(transcriptTurns([words[0], { ...words[1], startMs: 10000, endMs: 12000 }], null)).toHaveLength(2);
});

test("saved meeting summaries render separately from the verbatim transcript", () => {
  const html = render({ meta: { ...recording, status: "complete", summary: "Review the draft by Friday." }, segments: [segment("saved", "Um, Friday would work.", 0)] });
  expect(html).toContain("Summary");
  expect(html).toContain("Review the draft by Friday.");
  expect(html).toContain("Um, Friday would work.");
  expect(html.indexOf("Review the draft")).toBeLessThan(html.indexOf("Um, Friday"));
});

test("meeting notes render takeaways, actions and summary paragraphs as structured Markdown", () => {
  const summary = "### Main takeaways\n\n- **Decision:** proceed with the pilot.\n\n### Action items\n\n- Chris will send the draft by Friday.\n\n### Summary\n\nThe team agreed to evaluate the pilot.\n\nResults will inform the next review.";
  const html = render({ meta: { ...recording, status: "complete", summary }, segments: [segment("saved", "Let's proceed.", 0)] });
  expect(html).toMatch(/<h3[^>]*>Main takeaways<\/h3>/);
  expect(html).toMatch(/<h3[^>]*>Action items<\/h3>/);
  expect(html).toMatch(/<h3[^>]*>Summary<\/h3>/);
  expect(html).toContain("<strong>Decision:</strong>");
  expect(html).toMatch(/<li[^>]*>[\s\S]*Chris will send the draft by Friday\./);
  expect(html).toMatch(/<p[^>]*>The team agreed to evaluate the pilot\.<\/p>/);
  expect(html).toMatch(/<p[^>]*>Results will inform the next review\.<\/p>/);
  expect(html).not.toContain("### Main takeaways");
});
