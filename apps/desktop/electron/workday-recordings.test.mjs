import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createWorkdayRecordingReporter } from "./workday-recordings.mjs";
import { RecorderService } from "./audio/recorder-service.mjs";

test("only a completed retained recording begun after consent contributes metadata, and retry survives reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workday-recordings-"));
  const directory = join(dir, "outbox");
  const owner = { profileId: "a".repeat(64), epoch: 4, enabled: false };
  const state = { reads: 0, offline: false, writes: [] };
  const serverInfo = async () => ({ running: true, baseUrl: "http://127.0.0.1:9", hostToken: "local" });
  const request = async (_info, route, body) => {
    assert.equal(route, "/private-timesheet/meeting-recording");
    if (!body) { state.reads++; return { ...owner }; }
    if (state.offline) throw Error("offline");
    state.writes.push(body);
    return { added: 1 };
  };
  const reporter = () => createWorkdayRecordingReporter({ directory, serverInfo, request });
  const service = new RecorderService({ userDataDir: dir, workdayRecordings: reporter() });
  try {
    const disabled = await service.startRecording({ title: "Untracked" });
    service.appendMediaChunk(disabled.id, new Uint8Array([1]).buffer);
    owner.enabled = true;
    await service.stopRecording(disabled.id);
    const reads = state.reads;
    const dictation = await service.startRecording({ ephemeral: true, title: "Private dictation" });
    await service.stopRecording(dictation.id);
    assert.equal(state.reads, reads);
    const cancelled = await service.startRecording({ title: "Cancelled" });
    await service.cancelRecording(cancelled.id);
    const empty = await service.startRecording({ title: "No audio" });
    await service.stopRecording(empty.id);
    const revoked = await service.startRecording({ title: "Revoked during meeting" });
    service.appendMediaChunk(revoked.id, new Uint8Array([1]).buffer);
    owner.epoch++;
    await service.stopRecording(revoked.id);
    const failed = await service.startRecording({ title: "Failed" });
    service.activeRecordings.get(failed.id).meta.status = "error";
    await service.stopRecording(failed.id);
    const imported = await service.importFileStart({ fileName: "Historical media.mp3" });
    await service.importFileFinish(imported.id, 60000);
    const call = await service.startRecording({ title: "Client meeting", projectId: "project" });
    service.appendMediaChunk(call.id, new TextEncoder().encode("SYNTHETIC MEDIA").buffer);
    state.offline = true;
    await new Promise(resolve => setTimeout(resolve, 10));
    const finished = await service.stopRecording(call.id);
    assert.deepEqual(state.writes, []);
    assert.equal((await readdir(directory)).length, 1);
    state.offline = false;
    owner.profileId = "b".repeat(64);
    await reporter().flush();
    assert.equal(state.writes.length, 0);
    owner.profileId = "a".repeat(64);
    await reporter().flush();
    await reporter().flush();
    assert.equal(state.writes.length, 1);
    const [item] = state.writes;
    assert.deepEqual(Object.keys(item).sort(), ["id", "title", "projectId", "epoch", "profileId", "startedAt", "stoppedAt"].sort());
    assert.equal(item.title, "Client meeting");
    assert.equal(item.projectId, "project");
    assert.equal(item.stoppedAt - item.startedAt, finished.durationMs);

    const remote = createWorkdayRecordingReporter({ directory, serverInfo: async () => ({ running: true, hostToken: "private", baseUrl: "https://example.test" }),
      request: () => { throw Error("Unexpected request"); } });
    assert.equal(await remote.begin(), undefined);
  } finally { await service.dispose(); await rm(dir, { recursive: true, force: true }); }
});
