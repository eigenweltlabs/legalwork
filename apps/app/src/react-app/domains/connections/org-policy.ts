import { useEffect } from "react";
import { create } from "zustand";
import type { OrgPolicyKey } from "@legalwork/types/org-policy";
import type { OrgPolicyView, OrgPolicyViewEntry } from "@legalwork/types/org-policy-view";

import { createLegalworkServerClient, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { onSyncPoke, useSyncEventsLive } from "@/react-app/kernel/sync-events";
import { resolveLegalworkConnection } from "@/react-app/shell/legalwork-connection";

/**
 * The firm's policy in this window (the server keeps it: org-policy.ts).
 * Settings read their firm-managed value with `useOrgPolicy`, and change a
 * setting the firm may manage through `changeOrgPolicySetting`, which asks
 * the member to confirm before they take back a setting their firm enforces.
 */

type ConfirmRequest = { key: OrgPolicyKey; orgName?: string | null; resolve: (confirmed: boolean) => void };

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
export async function changeOrgPolicySetting(key: OrgPolicyKey, change: () => void | Promise<void>, worker?: LegalworkServerClient): Promise<boolean> {
  // A remote workspace must release its own worker's policy, not this computer's.
  const view = worker ? await worker.orgPolicy() : useOrgPolicyStore.getState().view;
  const entry = appliedOrgPolicy(view, key);
  if (entry?.locked) return false;
  if (entry) {
    if (entry.mode === "enforced") {
      const confirmed = await new Promise<boolean>((resolve) => useOrgPolicyStore.setState({ confirm: { key, orgName: view?.orgName, resolve } }));
      if (!confirmed) return false;
    }
    const client = worker ?? await serverClient();
    if (!client) return false;
    const released = await client.releaseOrgPolicy(key);
    if (!worker) useOrgPolicyStore.setState({ view: released });
    else void refreshOrgPolicy();
  }
  await change();
  return true;
}

export type AllowKey =
  | "connectors.allowCustom"
  | "plugins.allowCustom"
  | "skills.allowCustom"
  | "storage.allowPersonal"
  | "ai.chat.allowCustom"
  | "ai.systemOne.allowCustom"
  | "ai.ocr.allowCustom"
  | "recorder.allow"
  | "officeAddins.allow"
  | "evaluations.allow";

/** What the admin switched off, in the member's words. */
const OFF_TEXT = {
  "connectors.allowCustom": "org_policy.connectors_off",
  "plugins.allowCustom": "org_policy.plugins_off",
  "skills.allowCustom": "org_policy.skills_off",
  "storage.allowPersonal": "org_policy.storage_off",
  "ai.chat.allowCustom": "org_policy.chat_providers_off",
  "ai.systemOne.allowCustom": "org_policy.systemone_providers_off",
  "ai.ocr.allowCustom": "org_policy.ocr_engines_off",
  "recorder.allow": "org_policy.recorder_off",
  "officeAddins.allow": "org_policy.office_addins_off",
  "evaluations.allow": "org_policy.evaluations_off",
} satisfies Record<AllowKey, string>;

export function orgPolicyOffText(key: AllowKey): string {
  return t(OFF_TEXT[key]);
}

/**
 * Before an action the firm may switch off; true when it may go ahead.
 * Switched off while signed in: says so and refuses. After sign-out: asks,
 * then takes the setting back.
 */
export async function orgPolicyAllows(key: AllowKey): Promise<boolean> {
  const entry = appliedOrgPolicy(useOrgPolicyStore.getState().view, key);
  if (entry?.value !== false) return true;
  if (entry.locked) {
    toast(orgPolicyOffText(key));
    return false;
  }
  return changeOrgPolicySetting(key, () => undefined);
}

/** Whether the firm switched an action off while signed in (its control shows disabled). */
export function useOrgPolicyForbids(key: AllowKey): boolean {
  const entry = useOrgPolicy(key);
  return entry?.locked === true && entry.value === false;
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
