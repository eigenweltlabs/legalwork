import { create } from "zustand";

// Shared by Account and chat so setup does not reopen when navigating.
export const useSyncProviderSetupState = create<{
  dismissedAccounts: ReadonlySet<string>;
  dismiss: (account: string) => void;
  reset: (account: string) => void;
}>(set => ({
  dismissedAccounts: new Set(),
  dismiss: account => set(state => ({ dismissedAccounts: new Set([...state.dismissedAccounts, account]) })),
  reset: account => set(state => {
    const dismissedAccounts = new Set(state.dismissedAccounts);
    dismissedAccounts.delete(account);
    return { dismissedAccounts };
  }),
}));
