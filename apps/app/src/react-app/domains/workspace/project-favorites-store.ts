import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useProjectFavoritesStore = create<{
  favoriteIds: string[];
  toggleFavorite: (workspaceId: string) => void;
}>()(persist((set) => ({
  favoriteIds: [],
  toggleFavorite: (workspaceId) => set((state) => ({
    favoriteIds: state.favoriteIds.includes(workspaceId)
      ? state.favoriteIds.filter((id) => id !== workspaceId)
      : [...state.favoriteIds, workspaceId],
  })),
}), { name: "legalwork.projectFavorites" }));
