/**
 * Fusion mode state.
 *
 * Fusion mode fans a prompt out to up to three configured candidate models
 * (each in its own hidden child session of the main chat session), then asks
 * a dedicated fusion model to synthesize their outputs into the answer that
 * streams into the main chat.
 *
 * Persisted: which sessions have fusion enabled and the candidate child
 * session ids (so follow-up turns continue the same three chats after a
 * reload). Turn progress (streamed reasoning/text per candidate) is
 * ephemeral render state.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ModelRef } from "@/app/types";

export type FusionCandidateStatus = "pending" | "running" | "done" | "error";

export type FusionCandidateRun = {
  model: ModelRef;
  sessionID: string | null;
  status: FusionCandidateStatus;
  reasoning: string;
  text: string;
  error: string | null;
};

export type FusionTurnPhase = "candidates" | "fusing" | "done" | "error";

export type FusionTurn = {
  userText: string;
  phase: FusionTurnPhase;
  runs: FusionCandidateRun[];
};

type FusionStore = {
  /** Main session ids with fusion mode turned on. */
  enabledSessionIds: Record<string, true>;
  /** `${mainSessionId}|${providerID}/${modelID}` -> candidate child session id. */
  candidateSessionIds: Record<string, string>;
  /** Latest fusion turn per main session (ephemeral, not persisted). */
  turns: Record<string, FusionTurn>;
  setEnabled: (sessionId: string, enabled: boolean) => void;
  rememberCandidateSession: (key: string, candidateSessionId: string) => void;
  forgetCandidateSession: (key: string) => void;
  startTurn: (sessionId: string, turn: FusionTurn) => void;
  updateRun: (sessionId: string, index: number, patch: Partial<FusionCandidateRun>) => void;
  setPhase: (sessionId: string, phase: FusionTurnPhase) => void;
  clearTurn: (sessionId: string) => void;
};

export function candidateSessionKey(mainSessionId: string, model: ModelRef) {
  return `${mainSessionId}|${model.providerID}/${model.modelID}`;
}

export const useFusionStore = create<FusionStore>()(
  persist(
    (set) => ({
      enabledSessionIds: {},
      candidateSessionIds: {},
      turns: {},
      setEnabled: (sessionId, enabled) => set((state) => {
        const next = { ...state.enabledSessionIds };
        if (enabled) {
          next[sessionId] = true;
        } else {
          delete next[sessionId];
        }
        return { enabledSessionIds: next };
      }),
      rememberCandidateSession: (key, candidateSessionId) => set((state) => ({
        candidateSessionIds: { ...state.candidateSessionIds, [key]: candidateSessionId },
      })),
      forgetCandidateSession: (key) => set((state) => {
        const next = { ...state.candidateSessionIds };
        delete next[key];
        return { candidateSessionIds: next };
      }),
      startTurn: (sessionId, turn) => set((state) => ({
        turns: { ...state.turns, [sessionId]: turn },
      })),
      updateRun: (sessionId, index, patch) => set((state) => {
        const turn = state.turns[sessionId];
        if (!turn || !turn.runs[index]) return state;
        const runs = turn.runs.map((run, i) => (i === index ? { ...run, ...patch } : run));
        return { turns: { ...state.turns, [sessionId]: { ...turn, runs } } };
      }),
      setPhase: (sessionId, phase) => set((state) => {
        const turn = state.turns[sessionId];
        if (!turn) return state;
        return { turns: { ...state.turns, [sessionId]: { ...turn, phase } } };
      }),
      clearTurn: (sessionId) => set((state) => {
        const next = { ...state.turns };
        delete next[sessionId];
        return { turns: next };
      }),
    }),
    {
      name: "legalwork.fusion",
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        enabledSessionIds: state.enabledSessionIds,
        candidateSessionIds: state.candidateSessionIds,
      }),
    },
  ),
);

export function isFusionEnabled(sessionId: string): boolean {
  return Boolean(useFusionStore.getState().enabledSessionIds[sessionId]);
}
