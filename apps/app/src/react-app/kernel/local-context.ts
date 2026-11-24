import { createContext, use } from "react";
import type { LocalPreferences, LocalUIState } from "./local-provider";

export type LocalContextValue = {
  ui: LocalUIState;
  setUi: (updater: (previous: LocalUIState) => LocalUIState) => void;
  prefs: LocalPreferences;
  setPrefs: (updater: (previous: LocalPreferences) => LocalPreferences) => void;
  ready: boolean;
};

// Keep a mounted provider and its consumers bound across Fast Refresh updates.
export const LocalContext = createContext<LocalContextValue | undefined>(undefined);

export function useLocal(): LocalContextValue {
  const context = use(LocalContext);
  if (!context) {
    throw new Error("Local context is missing");
  }
  return context;
}
