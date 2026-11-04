import { createStore } from "zustand/vanilla";

export function createLocalReconnectRecovery(recover: () => Promise<void>) {
  let attempt: Promise<void> | null = null;
  return createStore<{
    error: string | null;
    pending: boolean;
    retry: () => Promise<void>;
    clear: () => void;
  }>((set) => ({
    error: null,
    pending: false,
    clear: () => set({ error: null }),
    retry: () => {
      if (attempt) return attempt;
      set({ pending: true });
      attempt = Promise.resolve().then(recover).then(
        () => set({ error: null }),
        error => set({ error: error instanceof Error ? error.message : String(error) }),
      ).finally(() => {
        attempt = null;
        set({ pending: false });
      });
      return attempt;
    },
  }));
}
