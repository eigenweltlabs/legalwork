import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const STORAGE_KEY = "legalwork:document-preferences:v1";
function storedAutosave(fallback: Record<string, boolean>) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object" || !("state" in value) || !value.state || typeof value.state !== "object" || !("autosave" in value.state)) return fallback;
    const autosave = value.state.autosave;
    if (!autosave || typeof autosave !== "object" || Array.isArray(autosave)) return fallback;
    return Object.fromEntries(Object.entries(autosave).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { return fallback; }
}

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
  setSplitOrientation: (splitOrientation) => set(state => ({ splitOrientation, autosave: storedAutosave(state.autosave) })),
  setSplitSize: (size, orientation = "horizontal") => set(state => ({ ...(orientation === "vertical" ? { stackedSplitSize: size } : { splitSize: size }), autosave: storedAutosave(state.autosave) })),
  setAutosave: (key, enabled) => set((state) => ({ autosave: { ...storedAutosave(state.autosave), [key]: enabled } })),
}), {
  name: "legalwork:document-preferences:v1",
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ autosave: state.autosave, splitSize: state.splitSize, stackedSplitSize: state.stackedSplitSize, splitOrientation: state.splitOrientation }),
}));

// Other windows may toggle a file while this renderer is in the background.
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY) return;
  const current = useDocumentPreferences.getState().autosave;
  const autosave = storedAutosave(current);
  if (JSON.stringify(current) !== JSON.stringify(autosave)) useDocumentPreferences.setState({ autosave });
});
