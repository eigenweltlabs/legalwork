import { create } from "zustand";

/**
 * Global updater status shared between the settings Updates page and the
 * home sidebar update badge. `useElectronUpdaterState` and the badge both
 * write here, so a check/download started in one place is visible in the
 * other regardless of which route is mounted.
 */
export type SettingsUpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  lastCheckedAt?: number | null;
  version?: string;
  date?: string;
  notes?: string;
  totalBytes?: number | null;
  downloadedBytes?: number;
  message?: string;
} | null;

/** localStorage key for the "check automatically" preference ("1"/"0"). */
export const UPDATE_AUTO_CHECK_STORAGE_KEY = "legalwork.react.settings.update-auto-check";

type UpdateStatusStore = {
  status: SettingsUpdateStatus;
  /** Update version hidden via the sidebar badge's dismiss button. Not persisted: the badge reappears on the next app start. */
  dismissedVersion: string | null;
  setStatus: (
    next: SettingsUpdateStatus | ((current: SettingsUpdateStatus) => SettingsUpdateStatus),
  ) => void;
  dismissVersion: (version: string) => void;
};

export const useUpdateStatusStore = create<UpdateStatusStore>((set) => ({
  status: null,
  dismissedVersion: null,
  setStatus: (next) =>
    set((state) => ({ status: typeof next === "function" ? next(state.status) : next })),
  dismissVersion: (version) => set({ dismissedVersion: version }),
}));
