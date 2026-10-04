import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Opt-in per original workspace file, shared by its tabs on this device. */
export const useDocumentPreferences = create<{
  autosave: Record<string, boolean>;
  splitSize: number;
  setSplitSize: (size: number) => void;
  setAutosave: (key: string, enabled: boolean) => void;
}>()(persist((set) => ({
  autosave: {},
  splitSize: 50,
  setSplitSize: (splitSize) => set({ splitSize }),
  setAutosave: (key, enabled) => set((state) => ({ autosave: { ...state.autosave, [key]: enabled } })),
}), {
  name: "legalwork:document-preferences:v1",
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ autosave: state.autosave, splitSize: state.splitSize }),
}));
