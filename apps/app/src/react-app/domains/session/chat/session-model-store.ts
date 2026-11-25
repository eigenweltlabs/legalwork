import { create } from "zustand";
import { persist } from "zustand/middleware";
import { localWorkdayModel } from "@legalwork/types/time-capture";
import type { ModelRef, ProviderListView } from "@/app/types";
import { getAvailableDefaultModel, isModelAvailableInConnectedProviders } from "../../../infra/provider-list-query";

export type ChatModelSelection = { model: ModelRef; variant: string | null };
export function isOnDeviceTimekeepingModel(model?: ModelRef) {
  return model?.providerID === localWorkdayModel.providerID && model.modelID === localWorkdayModel.modelID;
}
export function resolveTimekeepingChatModel(providers: ProviderListView | undefined, session: ChatModelSelection | undefined,
  saved: ModelRef | undefined, defaults: ChatModelSelection): ChatModelSelection {
  const savedSelection = saved && {
    model: saved,
    variant: saved.providerID === defaults.model.providerID && saved.modelID === defaults.model.modelID ? defaults.variant : null,
  };
  // Local reconstruction can exist without a corresponding chat provider. A
  // previous session selection must never move its future runs to the cloud.
  if (savedSelection && isOnDeviceTimekeepingModel(saved)) return savedSelection;
  const explicitProvider = saved?.providerID || session?.model.providerID;
  const sessionChoice = session?.model.providerID === explicitProvider ? session : undefined;
  const preferred = sessionChoice ?? savedSelection ?? defaults;
  if (!providers || isOnDeviceTimekeepingModel(preferred.model)) return preferred;
  for (const choice of [sessionChoice, savedSelection]) {
    if (choice?.model.providerID && choice.model.modelID && isModelAvailableInConnectedProviders(providers, choice.model)) return choice;
  }
  const current = preferred.model.providerID && preferred.model.modelID ? preferred.model : null;
  if (current && isModelAvailableInConnectedProviders(providers, current)) return preferred;
  const recovered = getAvailableDefaultModel(providers, current)
    ?? (!explicitProvider && current ? getAvailableDefaultModel(providers, null) : null);
  return recovered && (!explicitProvider || recovered.providerID === explicitProvider) ? { model: recovered, variant: null } : preferred;
}
export const chatModelKey = (baseUrl: string, workspaceId: string, sessionId: string) => JSON.stringify([baseUrl, workspaceId, sessionId]);
export const useSessionModelStore = create(persist<{
  selections: Record<string, ChatModelSelection>;
  initialize: (key: string, selection: ChatModelSelection) => void;
  select: (key: string, selection: ChatModelSelection) => void;
}>((set) => ({
  selections: {},
  initialize: (key, selection) => set(state => state.selections[key] ? state : { selections: { ...state.selections, [key]: selection } }),
  select: (key, selection) => set(state => ({ selections: { ...state.selections, [key]: selection } })),
}), { name: "legalwork.chat-models.v1" }));
