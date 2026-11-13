import type { ModelRef } from "@/app/types";

export type ModelSelection = { model: ModelRef | null; variant: string | null };
export type ModelPreferences = {
  defaultModel: ModelRef | null;
  modelVariant: string | null;
  assistantModel?: ModelSelection | null;
};

/** Snapshot the existing default once, including when the first provider connects. */
export function initializeAssistantModel<T extends ModelPreferences>(prefs: T): T {
  if (prefs.assistantModel || !prefs.defaultModel) return prefs;
  return { ...prefs, assistantModel: { model: prefs.defaultModel, variant: prefs.modelVariant } };
}

export function readModelPreference(prefs: ModelPreferences, assistant: boolean): ModelSelection {
  return assistant
    ? prefs.assistantModel ?? { model: null, variant: null }
    : { model: prefs.defaultModel, variant: prefs.modelVariant };
}

export function updateModelPreference<T extends ModelPreferences>(prefs: T, assistant: boolean, selection: ModelSelection): T {
  const initialized = initializeAssistantModel(prefs);
  return assistant
    ? { ...initialized, assistantModel: selection }
    : initializeAssistantModel({ ...initialized, defaultModel: selection.model, modelVariant: selection.variant });
}

export function changeModel(selection: ModelSelection, model: ModelRef): ModelSelection {
  return { model, variant: selection.model?.providerID === model.providerID && selection.model.modelID === model.modelID ? selection.variant : null };
}
