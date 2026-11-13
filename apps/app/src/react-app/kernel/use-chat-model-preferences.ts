import { useEffect } from "react";
import type { ModelRef, ProviderListView } from "@/app/types";
import { getConnectedProviderItems, isModelAvailableInConnectedProviders } from "../infra/provider-list-query";
import { useLocal } from "./local-provider";
import { changeModel, readModelPreference, updateModelPreference, type ModelSelection } from "./model-preferences";

export function useChatModelPreferences(assistant: boolean, providers?: ProviderListView) {
  const { prefs, setPrefs } = useLocal();
  const selection = readModelPreference(prefs, assistant);
  const unavailable = Boolean(selection.model && providers && !isModelAvailableInConnectedProviders(providers, selection.model));
  // Match regular chats' first-model/recovery behavior, without changing their default.
  useEffect(() => {
    if (!assistant || !providers || (selection.model && !unavailable)) return;
    const provider = getConnectedProviderItems(providers).find(item => item.id === "eigenwelt");
    if (!provider) return;
    const preferred = providers.default?.[provider.id];
    const modelID = preferred && provider.models[preferred] ? preferred : Object.keys(provider.models)[0];
    if (!modelID) return;
    setPrefs(previous => updateModelPreference(previous, true, { model: { providerID: provider.id, modelID }, variant: null }));
  }, [assistant, providers, selection.model, unavailable, setPrefs]);
  return {
    ...selection,
    unavailable,
    onModelChange: (model: ModelRef) => setPrefs(previous => updateModelPreference(previous, assistant, changeModel(readModelPreference(previous, assistant), model))),
    onVariantChange: (variant: string | null) => setPrefs(previous => updateModelPreference(previous, assistant, { ...readModelPreference(previous, assistant), variant })),
    onSelectionChange: (next: ModelSelection) => setPrefs(previous => updateModelPreference(previous, assistant, next)),
  };
}
