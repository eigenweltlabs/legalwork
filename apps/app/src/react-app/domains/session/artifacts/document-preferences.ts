import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type DocumentSplitOrientation = "horizontal" | "vertical";

/** Opt-in per original workspace file, shared by its tabs on this device. */
export const useDocumentPreferences = create<{
  autosave: Record<string, boolean>;
  splitSize: number;
  stackedSplitSize: number;
  splitOrientation: DocumentSplitOrientation;
  setSplitOrientation: (orientation: DocumentSplitOrientation) => void;
  setSplitSize: (size: number, orientation?: DocumentSplitOrientation) => void;
  setAutosave: (key: string, enabled: boolean) => void;
}>()(persist((set) => ({
  autosave: {},
  splitSize: 50,
  stackedSplitSize: 50,
  splitOrientation: "horizontal",
  setSplitOrientation: (splitOrientation) => set({ splitOrientation }),
  setSplitSize: (size, orientation = "horizontal") => set(orientation === "vertical" ? { stackedSplitSize: size } : { splitSize: size }),
  setAutosave: (key, enabled) => set((state) => ({ autosave: { ...state.autosave, [key]: enabled } })),
}), {
  name: "legalwork:document-preferences:v1",
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ autosave: state.autosave, splitSize: state.splitSize, stackedSplitSize: state.stackedSplitSize, splitOrientation: state.splitOrientation }),
}));
