import test from "node:test";
import assert from "node:assert/strict";
import { assistantRecorderLibrary } from "./audio/assistant-recorder.mjs";

test("recording library validates IDs, preserves links and trashes only inactive recordings", async () => {
  const item = { meta: { id: "rec-one", title: "Call", projectIds: ["first"] }, segments: [] };
  const events = [], trashed = [];
  const service = {
    recordingsDir: "/fixture/recordings", activeRecordings: new Map(),
    getRecording: async id => id === "rec-one" ? item : null,
    listRecordings: async () => [item.meta],
    renameRecording: async (_id, title) => { item.meta.title = title; },
    setRecordingProject: async (_id, id, linked) => { item.meta.projectIds = linked ? [...item.meta.projectIds, id] : item.meta.projectIds.filter(project => project !== id); },
    broadcast: event => events.push(event),
  };
  const library = assistantRecorderLibrary({ service: () => service, trashItem: async file => { trashed.push(file); }, control: async input => input });
  await assert.rejects(library.read("../private"), /Invalid/);
  await assert.rejects(library.trash("missing"), /not found/);
  await library.rename("rec-one", "Client call");
  assert.equal(item.meta.title, "Client call");
  await library.link("rec-one", "second", true);
  assert.deepEqual(item.meta.projectIds, ["first", "second"]);
  await library.link("rec-one", "first", false);
  assert.deepEqual(item.meta.projectIds, ["second"]);
  service.activeRecordings.set("rec-one", {});
  await assert.rejects(library.trash("rec-one"), /Stop the recording/);
  assert.deepEqual(trashed, []);
  service.activeRecordings.clear();
  await library.trash("rec-one");
  assert.deepEqual(trashed, ["/fixture/recordings/rec-one"]);
  assert.equal(events.length, 4);
  assert.ok(events.every(event => event.type === "recordings-changed"));
});
