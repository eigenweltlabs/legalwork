import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const ASSISTANT_NOTIFICATION_PREFERENCES_KEY = "legalwork:assistant-notifications:v1";

/** Desktop delivery is a preference on this computer, independent of task alerts. */
export const useAssistantNotificationPreferences = create<{
  desktopNotifications: boolean;
  setDesktopNotifications: (enabled: boolean) => void;
}>()(persist(set => ({
  desktopNotifications: true,
  setDesktopNotifications: desktopNotifications => set({ desktopNotifications }),
}), {
  name: ASSISTANT_NOTIFICATION_PREFERENCES_KEY,
  storage: createJSONStorage(() => localStorage),
  partialize: ({ desktopNotifications }) => ({ desktopNotifications }),
  merge: (stored, current) => ({
    ...current,
    desktopNotifications: typeof stored === "object" && stored !== null && "desktopNotifications" in stored && typeof stored.desktopNotifications === "boolean"
      ? stored.desktopNotifications : true,
  }),
}));
