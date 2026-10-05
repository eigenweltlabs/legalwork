import { useEffect } from "react";
import { create } from "zustand";
import type { OrgPolicyKey } from "@legalwork/types/org-policy";
import type { OrgPolicyView, OrgPolicyViewEntry } from "@legalwork/types/org-policy-view";

import { createLegalworkServerClient } from "@/app/lib/legalwork-server";
import { onSyncPoke, useSyncEventsLive } from "@/react-app/kernel/sync-events";
import { resolveLegalworkConnection } from "@/react-app/shell/legalwork-connection";

/**
 * The firm's policy in this window (the server keeps it: org-policy.ts).
 * Settings read their firm-managed value with `useOrgPolicy`, and change a
 * setting the firm may manage through `changeOrgPolicySetting`, which asks
 * the member to confirm before they take back a setting their firm enforces.
 */

type ConfirmRequest = { key: OrgPolicyKey; resolve: (confirmed: boolean) => void };

export const useOrgPolicyStore = create<{ view: OrgPolicyView | null; confirm: ConfirmRequest | null }>(() => ({
  view: null,
  confirm: null,
}));

/** The firm's setting as it applies now: null when the firm does not manage it or the member took it back. */
export function appliedOrgPolicy<K extends OrgPolicyKey>(view: OrgPolicyView | null, key: K): OrgPolicyViewEntry<K> | null {
  const entry = view?.entries[key];
  return entry && !entry.released ? entry : null;
}

export function useOrgPolicy<K extends OrgPolicyKey>(key: K): OrgPolicyViewEntry<K> | null {
  return useOrgPolicyStore((state) => appliedOrgPolicy(state.view, key));
}

async function serverClient() {
  const connection = await resolveLegalworkConnection();
  const token = connection.resolvedToken || undefined;
  const hostToken = connection.resolvedHostToken || undefined;
  if (!connection.normalizedBaseUrl || !(token || hostToken)) return null;
  return createLegalworkServerClient({ baseUrl: connection.normalizedBaseUrl, token, hostToken });
}

export async function refreshOrgPolicy(): Promise<void> {
  try {
    const client = await serverClient();
    if (client) useOrgPolicyStore.setState({ view: await client.orgPolicy() });
  } catch {
    // The server is starting, or predates firm policies: asked again later.
  }
}

/**
 * Change a setting the firm may manage; resolves whether `change` ran.
 * Not managed: it runs. Locked (enforced while signed in): it does not. A
 * default, or an enforced setting after sign-out once the member confirmed:
 * the setting is taken back first, so the firm's value stops applying.
 */
export async function changeOrgPolicySetting(key: OrgPolicyKey, change: () => void | Promise<void>): Promise<boolean> {
  const entry = appliedOrgPolicy(useOrgPolicyStore.getState().view, key);
  if (entry?.locked) return false;
  if (entry) {
    if (entry.mode === "enforced") {
      const confirmed = await new Promise<boolean>((resolve) => useOrgPolicyStore.setState({ confirm: { key, resolve } }));
      if (!confirmed) return false;
    }
    const client = await serverClient();
    if (!client) return false;
    useOrgPolicyStore.setState({ view: await client.releaseOrgPolicy(key) });
  }
  await change();
  return true;
}

export function answerOrgPolicyConfirm(confirmed: boolean): void {
  const request = useOrgPolicyStore.getState().confirm;
  useOrgPolicyStore.setState({ confirm: null });
  request?.resolve(confirmed);
}

const POLL_MS = 60_000;
const LIVE_POLL_MS = 5 * 60_000;

/** Keeps this window's copy current: at start, when the server says it changed, on focus, and every few minutes. */
export function useOrgPolicyListener(): void {
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      window.clearTimeout(timer);
      await refreshOrgPolicy();
      if (!stopped) timer = window.setTimeout(() => void poll(), useSyncEventsLive.getState().live ? LIVE_POLL_MS : POLL_MS);
    };
    void poll();
    const unsubscribe = onSyncPoke((poke) => {
      if (poke.policy || poke.resync) void poll();
    });
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(timer);
    };
  }, []);
}
