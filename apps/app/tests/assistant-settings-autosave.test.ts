import { expect, test } from "bun:test";
import { createAssistantSettingsAutosave, getAssistantSettingsAutosave, type AssistantSettingsDraft, type AssistantSettingsSaveStatus } from "../src/react-app/domains/settings/pages/assistant-settings-autosave";

const initial: AssistantSettingsDraft = {
  profile: { name: "Johannes", icon: "bird" },
  settings: { systemPromptAddition: "", resourceIds: [], projectAccess: { mode: "all", projectIds: [] } },
  notifications: true,
};
const rename = (name: string): AssistantSettingsDraft => ({ ...initial, profile: { ...initial.profile, name } });
function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("autosave skips unchanged settings", async () => {
  const calls: AssistantSettingsDraft[] = [];
  const queue = createAssistantSettingsAutosave({ initialValue: initial, onSave: async value => { calls.push(value); }, onStatus: () => {} });
  await queue.save(structuredClone(initial));
  expect(calls).toEqual([]);
});

test("rapid edits serialize writes and coalesce to the newest pending value", async () => {
  const first = gate();
  const calls: AssistantSettingsDraft[] = [];
  const statuses: AssistantSettingsSaveStatus[] = [];
  let active = 0;
  let peak = 0;
  const queue = createAssistantSettingsAutosave({ initialValue: initial, onSave: async value => {
    calls.push(value); peak = Math.max(peak, ++active);
    if (calls.length === 1) await first.promise;
    active--;
  }, onStatus: status => statuses.push(status) });
  const completion = queue.save(rename("First"));
  void queue.save(rename("Second"));
  void queue.save(rename("Latest"));
  expect(calls.map(value => value.profile.name)).toEqual(["First"]);
  first.release();
  await completion;
  expect(calls.map(value => value.profile.name)).toEqual(["First", "Latest"]);
  expect(peak).toBe(1);
  expect(statuses.at(-1)).toBe("idle");
});

test("reverting while a write is in flight restores the original value afterward", async () => {
  const first = gate();
  const calls: AssistantSettingsDraft[] = [];
  const queue = createAssistantSettingsAutosave({ initialValue: initial, onSave: async value => {
    calls.push(value); if (calls.length === 1) await first.promise;
  }, onStatus: () => {} });
  const completion = queue.save(rename("Temporary"));
  void queue.save(initial);
  first.release();
  await completion;
  expect(calls).toEqual([rename("Temporary"), initial]);
});

test("failed drafts are retained for explicit retry", async () => {
  const calls: AssistantSettingsDraft[] = [];
  const statuses: AssistantSettingsSaveStatus[] = [];
  const queue = createAssistantSettingsAutosave({ initialValue: initial, onSave: async value => {
    calls.push(value); if (calls.length === 1) throw new Error("Offline");
  }, onStatus: status => statuses.push(status) });
  await queue.save(rename("Keep this edit"));
  expect(statuses.at(-1)).toBe("error");
  await queue.retry();
  expect(calls).toEqual([rename("Keep this edit"), rename("Keep this edit")]);
  expect(statuses.at(-1)).toBe("idle");
});

test("a partial failure does not make restoring the original snapshot a no-op", async () => {
  const calls: AssistantSettingsDraft[] = [];
  const queue = createAssistantSettingsAutosave({ initialValue: initial, onSave: async value => {
    calls.push(value); if (calls.length === 1) throw new Error("Behavior endpoint failed after profile was saved");
  }, onStatus: () => {} });
  await queue.save(rename("Partially saved"));
  await queue.save(initial);
  expect(calls).toEqual([rename("Partially saved"), initial]);
});

test("a newer pending edit continues after an older request fails", async () => {
  const first = gate();
  const calls: AssistantSettingsDraft[] = [];
  const queue = createAssistantSettingsAutosave({ initialValue: initial, onSave: async value => {
    calls.push(value);
    if (calls.length === 1) { await first.promise; throw new Error("Failed"); }
  }, onStatus: () => {} });
  const completion = queue.save(rename("First"));
  void queue.save(rename("Latest"));
  first.release();
  await completion;
  expect(calls).toEqual([rename("First"), rename("Latest")]);
});

test("unblurred text is staged without writes and flushed when the editor leaves", async () => {
  const calls: AssistantSettingsDraft[] = [];
  const queue = createAssistantSettingsAutosave({ initialValue: initial, onSave: async value => { calls.push(value); }, onStatus: () => {} });
  queue.stage(rename("  New name  "));
  expect(calls).toHaveLength(0);
  await queue.flushDraft();
  expect(calls).toEqual([rename("New name")]);
  expect(queue.getSnapshot().draft.profile.name).toBe("New name");
  await queue.flushDraft();
  expect(calls).toHaveLength(1);
});

test("reopening the same settings scope shares the in-flight queue and latest draft", async () => {
  const first = gate();
  const calls: AssistantSettingsDraft[] = [];
  const options = { initialValue: initial, onSave: async (value: AssistantSettingsDraft) => {
    calls.push(value); if (calls.length === 1) await first.promise;
  }, onStatus: () => {} };
  const queue = getAssistantSettingsAutosave("test-reopen-in-flight", options);
  const completion = queue.save(rename("Before leaving"));
  const reopened = getAssistantSettingsAutosave("test-reopen-in-flight", options);
  expect(reopened).toBe(queue);
  expect(reopened.getSnapshot().draft.profile.name).toBe("Before leaving");
  void reopened.save(rename("After reopening"));
  expect(calls).toHaveLength(1);
  first.release();
  await completion;
  expect(calls.map(value => value.profile.name)).toEqual(["Before leaving", "After reopening"]);
});

test("reopening retains failed drafts and leaving does not silently retry them", async () => {
  const calls: AssistantSettingsDraft[] = [];
  const options = { initialValue: initial, onSave: async (value: AssistantSettingsDraft) => {
    calls.push(value); if (calls.length === 1) throw new Error("Offline");
  }, onStatus: () => {} };
  const queue = getAssistantSettingsAutosave("test-reopen-failed", options);
  await queue.save(rename("Retain me"));
  await queue.flushDraft();
  expect(calls).toHaveLength(1);
  const reopened = getAssistantSettingsAutosave("test-reopen-failed", options);
  expect(reopened.getSnapshot()).toEqual({ draft: rename("Retain me"), status: "error" });
  await reopened.retry();
  expect(calls).toHaveLength(2);
  expect(reopened.getSnapshot().status).toBe("idle");
});

test("an idle reopened scope accepts fresh server state without overwriting an active editor", () => {
  const options = { initialValue: initial, onSave: async () => {}, onStatus: () => {} };
  const queue = getAssistantSettingsAutosave("test-reopen-fresh", options);
  const reopened = getAssistantSettingsAutosave("test-reopen-fresh", { ...options, initialValue: rename("Changed elsewhere") });
  expect(reopened.getSnapshot().draft).toEqual(rename("Changed elsewhere"));
  const unsubscribe = queue.subscribe(() => {});
  getAssistantSettingsAutosave("test-reopen-fresh", { ...options, initialValue: initial });
  expect(reopened.getSnapshot().draft).toEqual(rename("Changed elsewhere"));
  unsubscribe();
});

test("text entered during a slow save is flushed after that write completes", async () => {
  const first = gate();
  const calls: AssistantSettingsDraft[] = [];
  const queue = createAssistantSettingsAutosave({ initialValue: initial, onSave: async value => {
    calls.push(value); if (calls.length === 1) await first.promise;
  }, onStatus: () => {} });
  const completion = queue.save(rename("First"));
  queue.stage(rename("Unblurred text"));
  void queue.flushDraft();
  first.release();
  await completion;
  expect(calls.map(value => value.profile.name)).toEqual(["First", "Unblurred text"]);
});
