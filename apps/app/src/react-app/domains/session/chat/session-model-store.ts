import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ModelRef } from "@/app/types";

export type ChatModelSelection = { model: ModelRef; variant: string | null };
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
