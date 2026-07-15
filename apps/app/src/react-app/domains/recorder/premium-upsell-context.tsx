/** @jsxImportSource react */
/**
 * Premium upsell "challenge" — a store-backed trigger plus a single host that
 * renders the modal, owns the post-checkout poll loop, AND keeps the premium
 * gate synced to the firm's active subscription.
 *
 * A zustand flag (not React context) lets any recorder leaf open the modal via
 * `usePremiumUpsell().open()` without threading a provider through the deep
 * session/settings trees. `PremiumUpsellHost` is mounted once per route (where
 * the legalwork client + workspace are known); only one route renders at a time,
 * so there's never a duplicate modal.
 *
 * Flow, bank-challenge style:
 *   pitch   → €25 Plus benefits + "Upgrade to Plus"
 *   waiting → checkout opens in the browser; poll entitlements every ~2.5s with a
 *             FORCE refresh until `premium_models` appears
 *   success → brief confirmation, then auto-close (the gate is already unlocked)
 *   timeout → gave up polling; it still unlocks on its own once active
 * Closing the modal at any point aborts the poll loop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import {
  hasEigenweltFeature,
  invalidateEigenweltEntitlements,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";

import { setEigenweltPremiumEntitled } from "./model-tiers";
import { PremiumUpsellModal, type PremiumUpsellPhase } from "./premium-upsell-modal";
import { useRecorderStore } from "./recorder-store";

const POLL_INTERVAL_MS = 2_500;
const POLL_TIMEOUT_MS = 3 * 60_000;

const useUpsellOpen = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Open the premium upsell challenge from anywhere (no provider needed). */
export function usePremiumUpsell(): { open: () => void } {
  const setOpen = useUpsellOpen((s) => s.setOpen);
  return { open: () => setOpen(true) };
}

export function PremiumUpsellHost(props: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  /**
   * Run when the subscription is confirmed active — re-pull the paid Eigenwelt
   * manifest and reload the engine/provider list so the newly-entitled EU/ZDR
   * models appear in the picker (the route wires its own refresh-models +
   * provider refresh, which needs its route-scoped provider store).
   */
  onPremiumActivated?: () => unknown | Promise<unknown>;
  /**
   * Start the "Sign in with Eigenwelt" flow. You can only subscribe a firm you
   * belong to, so when the desktop isn't connected the upsell routes through
   * sign-in first. Resolves true once connected.
   */
  onSignIn?: () => Promise<boolean>;
}) {
  const { client, workspaceId, onPremiumActivated, onSignIn } = props;
  const open = useUpsellOpen((s) => s.open);
  const setOpen = useUpsellOpen((s) => s.setOpen);
  const [phase, setPhase] = useState<PremiumUpsellPhase>("pitch");
  const enforcePremiumGate = useRecorderStore((state) => state.enforcePremiumGate);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Background sync: keep isPremiumEntitled() in step with the firm's sub,
  // so a lapse falls premium audio models back to free even without the modal.
  const entitlementsQuery = useEigenweltEntitlements({ client, workspaceId });
  const view = entitlementsQuery.data;
  useEffect(() => {
    if (view === undefined) return; // query disabled/pending — don't assume "no sub"
    setEigenweltPremiumEntitled(hasEigenweltFeature(view.entitlements, "premium_models"), view.platformURL ?? null);
    enforcePremiumGate();
  }, [view, enforcePremiumGate]);

  // --- Poll loop, cleared on close/unmount so it can't outlive the modal.
  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (deadlineRef.current) clearTimeout(deadlineRef.current);
    pollRef.current = null;
    deadlineRef.current = null;
  }, []);

  // Reset to the pitch whenever the modal (re)opens.
  useEffect(() => {
    if (open) setPhase("pitch");
    else stopPolling();
  }, [open, stopPolling]);

  const closeUpsell = useCallback(() => {
    stopPolling();
    setOpen(false);
  }, [stopPolling, setOpen]);

  // Whether the desktop is signed in with an Eigenwelt firm — a subscription is
  // per-firm, so without a connection there is nothing to poll.
  const connected = view?.connected ?? false;
  const [signingIn, setSigningIn] = useState(false);
  const handleSignIn = useCallback(async () => {
    if (!onSignIn) return;
    setSigningIn(true);
    try {
      const ok = await onSignIn();
      if (ok) await entitlementsQuery.refetch(); // refresh `connected` -> show Upgrade
    } finally {
      setSigningIn(false);
    }
  }, [onSignIn, entitlementsQuery]);

  const startWaiting = useCallback(() => {
    if (!client || !workspaceId) return;
    stopPolling();
    setPhase("waiting");
    const poll = async () => {
      try {
        const fresh = await client.eigenweltEntitlements(workspaceId, { refresh: true });
        if (hasEigenweltFeature(fresh.entitlements, "premium_models")) {
          stopPolling();
          setEigenweltPremiumEntitled(true, fresh.platformURL ?? null);
          enforcePremiumGate();
          invalidateEigenweltEntitlements(workspaceId);
          // Bring the paid provider online: refresh its models + reload the
          // engine so the EU/ZDR models show up in the picker, not just the
          // audio gate. Best-effort — the success state shows regardless.
          void Promise.resolve(onPremiumActivated?.()).catch(() => undefined);
          setPhase("success");
        }
      } catch {
        // Transient (token rotating, network) — keep polling until the deadline.
      }
    };
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    deadlineRef.current = setTimeout(() => {
      stopPolling();
      setPhase("timeout");
    }, POLL_TIMEOUT_MS);
    void poll(); // fire immediately; some users pay before the first tick
  }, [client, workspaceId, stopPolling, enforcePremiumGate, onPremiumActivated]);

  // Auto-dismiss shortly after success so the unlock feels immediate.
  useEffect(() => {
    if (phase !== "success" || !open) return;
    const id = setTimeout(() => setOpen(false), 1_400);
    return () => clearTimeout(id);
  }, [phase, open, setOpen]);

  useEffect(() => stopPolling, [stopPolling]); // safety net on unmount

  return (
    <PremiumUpsellModal
      open={open}
      phase={phase}
      canPoll={Boolean(client && workspaceId)}
      connected={connected}
      canSignIn={Boolean(onSignIn)}
      signingIn={signingIn}
      onSignIn={handleSignIn}
      onUpgrade={startWaiting}
      onClose={closeUpsell}
    />
  );
}
