export type RecorderCommand = {
  action: "status" | "start" | "stop";
  title?: string; projectId?: string; recordingId?: string; sources?: ("microphone" | "system")[];
};

type State = {
  init: () => Promise<void>;
  recording: { id: string; title: string } | null;
  starting: boolean; finalizing: boolean; importing: unknown;
  dictationRecordingId: string | null;
  error: string | null; permissionsNeeded: string[];
  modelId: string | null;
  bootstrap: { models: { id: string; state: string }[] } | null;
  startRecording: (title?: string, options?: { projectId?: string; sources?: ("microphone" | "system")[] }) => Promise<void>;
  stopRecording: () => Promise<void>;
};

export async function controlRecorder(get: () => State, input: RecorderCommand) {
  await get().init();
  const state = get();
  if (input.action === "status") return { ok: true, recording: state.recording, busy: state.starting || state.finalizing || Boolean(state.importing), modelId: state.modelId, permissionsNeeded: state.permissionsNeeded };
  if (state.starting || state.finalizing || state.importing || state.dictationRecordingId) return { ok: false, error: "The recorder is busy. Check status before retrying." };
  if (input.action === "start") {
    if (state.recording) return { ok: false, error: "A recording is already running.", recordingId: state.recording.id };
    if (!state.bootstrap?.models.some(model => model.id === state.modelId && model.state === "installed")) return { ok: false, error: "Choose an installed transcription model in Recorder first." };
    await state.startRecording(input.title, { projectId: input.projectId, sources: input.sources });
    const started = get();
    if (!started.recording) return { ok: false, error: started.error ?? "Recording did not start. Open Recorder to check capture permissions.", permissionsNeeded: started.permissionsNeeded };
    return { ok: true, recording: started.recording };
  }
  if (!input.recordingId || state.recording?.id !== input.recordingId) return { ok: false, error: "That recording is not active. Read status and use its exact ID." };
  await state.stopRecording();
  return get().error ? { ok: false, error: get().error } : { ok: true, recordingId: input.recordingId, stopped: true };
}
