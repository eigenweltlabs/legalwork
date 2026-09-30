import { create } from "zustand";
import type { ContentSearchResult } from "@legalwork/types/search";

// Keep the destination until the project/session surface has mounted and loaded it.
export const useSearchNavigation = create<{
  target: ContentSearchResult | null;
  setTarget: (target: ContentSearchResult | null) => void;
}>((set) => ({ target: null, setTarget: target => set({ target }) }));
