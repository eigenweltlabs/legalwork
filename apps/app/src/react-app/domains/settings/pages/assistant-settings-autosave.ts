import type { AssistantProfile, AssistantSettings } from "@legalwork/types/main-assistant";

export type AssistantSettingsDraft = { profile: AssistantProfile; settings: AssistantSettings; notifications: boolean };
export type AssistantSettingsSaveStatus = "idle" | "saving" | "error";
type Snapshot = { draft: AssistantSettingsDraft; status: AssistantSettingsSaveStatus };
type Options = {
  initialValue: AssistantSettingsDraft;
  onSave: (value: AssistantSettingsDraft) => Promise<void>;
  onStatus: (status: AssistantSettingsSaveStatus) => void;
};

const scopedAutosaves = new Map<string, ReturnType<typeof createAssistantSettingsAutosave>>();

export function getAssistantSettingsAutosave(scope: string, options: Options) {
  const existing = scopedAutosaves.get(scope);
  if (existing) {
    existing.refresh(options.initialValue);
    existing.setOnSave(options.onSave);
    return existing;
  }
  const autosave = createAssistantSettingsAutosave(options);
  scopedAutosaves.set(scope, autosave);
  return autosave;
}

// Only one request may be in flight. New edits replace the pending snapshot,
// so a slow earlier response cannot overwrite a more recent selection.
export function createAssistantSettingsAutosave({ initialValue, onSave, onStatus }: Options) {
  let saved: AssistantSettingsDraft | null = initialValue;
  let pending: AssistantSettingsDraft | null = null;
  let latest = initialValue;
  let requested = initialValue;
  let running = false;
  let snapshot: Snapshot = { draft: initialValue, status: "idle" };
  const listeners = new Set<() => void>();

  function publish(status = snapshot.status) {
    snapshot = { draft: latest, status };
    for (const listener of listeners) listener();
  }
  function status(value: AssistantSettingsSaveStatus) { publish(value); onStatus(value); }
  function stage(value: AssistantSettingsDraft) { latest = value; publish(); }

  async function flush() {
    if (running) return;
    running = true;
    try {
      while (pending) {
        const value = pending;
        pending = null;
        if (JSON.stringify(value) === JSON.stringify(saved)) continue;
        status("saving");
        try {
          await onSave(value);
          saved = value;
        } catch {
          // Profile and behavior use separate endpoints. A failed save may
          // have persisted part of the snapshot, so no value is a safe no-op.
          saved = null;
          // A newer edit can recover the failed write. Otherwise leave the
          // draft intact and let the user retry it explicitly.
          if (pending) continue;
          status("error");
          return;
        }
      }
      status("idle");
    } finally {
      running = false;
    }
  }

  function save(value: AssistantSettingsDraft) {
    const normalized = { ...value, profile: { ...value.profile, name: value.profile.name?.trim() || null } };
    requested = normalized;
    stage(normalized);
    pending = normalized;
    return flush();
  }

  return {
    stage,
    save,
    retry: () => save(latest),
    flushDraft: () => JSON.stringify(latest) !== JSON.stringify(requested) ? save(latest) : Promise.resolve(),
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setOnSave: (persist: Options["onSave"]) => { onSave = persist; },
    refresh: (value: AssistantSettingsDraft) => {
      // Fresh server data can replace an idle snapshot. Retain in-flight,
      // unblurred, and failed drafts when the settings page is reopened.
      if (listeners.size === 0 && !running && saved && JSON.stringify(latest) === JSON.stringify(saved)) {
        saved = value;
        latest = value;
        requested = value;
        publish("idle");
      }
    },
  };
}
