import { expect, test } from "bun:test";
import { controlRecorder } from "../src/react-app/domains/recorder/assistant-recorder-control";

test("recorder control reports actual capture, refuses duplicate starts and stops only the named recording", async () => {
  let recording: { id: string; title: string } | null = null;
  let allowCapture = false, starts = 0, stops = 0;
  const get = () => ({
    init: async () => {}, recording, starting: false, finalizing: false, importing: null, dictationRecordingId: null,
    error: null, permissionsNeeded: allowCapture ? [] : ["microphone"], modelId: "local", bootstrap: { models: [{ id: "local", state: "installed" }] },
    startRecording: async () => { starts++; if (allowCapture) recording = { id: "rec-one", title: "Call" }; },
    stopRecording: async () => { stops++; recording = null; },
  });
  expect(await controlRecorder(get, { action: "status" })).toMatchObject({ ok: true, recording: null });
  expect(starts).toBe(0);
  expect(await controlRecorder(get, { action: "start" })).toMatchObject({ ok: false, permissionsNeeded: ["microphone"] });
  allowCapture = true;
  expect(await controlRecorder(get, { action: "start" })).toMatchObject({ ok: true, recording: { id: "rec-one" } });
  expect(await controlRecorder(get, { action: "start" })).toMatchObject({ ok: false });
  expect(starts).toBe(2);
  expect(await controlRecorder(get, { action: "stop", recordingId: "other" })).toMatchObject({ ok: false });
  expect(stops).toBe(0);
  expect(await controlRecorder(get, { action: "stop", recordingId: "rec-one" })).toMatchObject({ ok: true, stopped: true });
  expect(stops).toBe(1);
  expect(await controlRecorder(() => ({ ...get(), importing: {} }), { action: "start" })).toMatchObject({ ok: false });
  expect(await controlRecorder(() => ({ ...get(), bootstrap: null }), { action: "start" })).toMatchObject({ ok: false });
  expect(starts).toBe(2);
});
