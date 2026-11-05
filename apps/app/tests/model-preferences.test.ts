import { describe, expect, test } from "bun:test";
import { changeModel, initializeAssistantModel, readModelPreference, updateModelPreference, type ModelPreferences } from "../src/react-app/kernel/model-preferences";
import { chatModelKey, useSessionModelStore } from "../src/react-app/domains/session/chat/session-model-store";

const initial = { providerID: "provider", modelID: "initial" };
const regular = { providerID: "provider", modelID: "regular" };
const personal = { providerID: "provider", modelID: "personal" };
const legacy: ModelPreferences = { defaultModel: initial, modelVariant: "high" };

describe("independent Assistant model preferences", () => {
  test("existing preferences are captured once and survive subsequent regular chat choices and reloads", () => {
    const migrated = initializeAssistantModel(legacy);
    expect(readModelPreference(migrated, true)).toEqual({ model: initial, variant: "high" });
    const updated = updateModelPreference(migrated, false, { model: regular, variant: "medium" });
    const reloaded: ModelPreferences = JSON.parse(JSON.stringify(updated));
    expect(readModelPreference(initializeAssistantModel(reloaded), true)).toEqual({ model: initial, variant: "high" });
    expect(readModelPreference(reloaded, false)).toEqual({ model: regular, variant: "medium" });
    expect(legacy).toEqual({ defaultModel: initial, modelVariant: "high" });
  });

  test("changing the shared default preserves the old Assistant choice even before migration", () => {
    const updated = updateModelPreference(legacy, false, { model: regular, variant: null });
    expect(readModelPreference(updated, true)).toEqual({ model: initial, variant: "high" });
  });

  test("Assistant model and effort edits do not change the regular default", () => {
    let prefs = updateModelPreference(legacy, true, changeModel(readModelPreference(initializeAssistantModel(legacy), true), personal));
    expect(readModelPreference(prefs, true)).toEqual({ model: personal, variant: null });
    prefs = updateModelPreference(prefs, true, { model: personal, variant: "low" });
    prefs = updateModelPreference(prefs, false, { model: regular, variant: "medium" });
    expect(readModelPreference(prefs, true)).toEqual({ model: personal, variant: "low" });
    expect(readModelPreference(prefs, false)).toEqual({ model: regular, variant: "medium" });
  });

  test("fresh installs initialize once when a model becomes available", () => {
    const empty: ModelPreferences = { defaultModel: null, modelVariant: null, assistantModel: null };
    expect(readModelPreference(initializeAssistantModel(empty), true).model).toBeNull();
    const first = updateModelPreference(empty, false, { model: initial, variant: null });
    const second = updateModelPreference(first, false, { model: regular, variant: "medium" });
    expect(readModelPreference(second, true)).toEqual({ model: initial, variant: null });
  });

  test("an explicit Assistant choice is retained when the first regular model connects", () => {
    const empty: ModelPreferences = { defaultModel: null, modelVariant: null };
    const chosen = updateModelPreference(empty, true, { model: personal, variant: "high" });
    const connected = updateModelPreference(chosen, false, { model: regular, variant: null });
    expect(readModelPreference(connected, true)).toEqual({ model: personal, variant: "high" });
  });

  test("reselecting a model keeps effort, changing model or provider resets it", () => {
    const selection = { model: initial, variant: "high" };
    expect(changeModel(selection, { ...initial }).variant).toBe("high");
    expect(changeModel(selection, personal).variant).toBeNull();
    expect(changeModel(selection, { ...initial, providerID: "other" }).variant).toBeNull();
  });

  test("regular chats still seed new chats from their shared default while existing chats and the Assistant stay independent", () => {
    useSessionModelStore.setState({ selections: {} });
    const store = useSessionModelStore.getState();
    const oldChat = chatModelKey("server", "project", "old");
    const newChat = chatModelKey("server", "project", "new");
    store.initialize(oldChat, { model: initial, variant: "high" });
    const prefs = updateModelPreference(legacy, false, { model: regular, variant: "medium" });
    const defaults = readModelPreference(prefs, false);
    if (!defaults.model) throw new Error("Regular model must be available");
    store.initialize(newChat, { model: defaults.model, variant: defaults.variant });
    expect(useSessionModelStore.getState().selections[oldChat]).toEqual({ model: initial, variant: "high" });
    expect(useSessionModelStore.getState().selections[newChat]).toEqual({ model: regular, variant: "medium" });
    expect(readModelPreference(prefs, true)).toEqual({ model: initial, variant: "high" });
  });
});
