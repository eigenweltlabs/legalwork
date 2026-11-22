import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createLegalworkServerClient, isLoopbackLegalworkServerUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { DesktopActivitySample } from "@legalwork/types/time-capture";

import { resolveLegalworkConnection } from "./legalwork-connection";
import { timeTrackingProfile } from "../domains/back-office/time-tracking-profile";

type Profile = Awaited<ReturnType<LegalworkServerClient["activityProfile"]>>;
export type DesktopCaptureStatus = { at: number; state: DesktopActivitySample["state"] | "failed" };
export const desktopCaptureKey = (profileId: string) => ["timekeeping-desktop-capture", profileId];

/** Mounted above both Settings and workspace routes. Native capture continues when the user leaves either. */
export function DesktopTimeActivityListener() {
  const native = Boolean(window.__LEGALWORK_ELECTRON__?.system?.sampleWorkdayDesktopActivity);
  const connection = useQuery({
    queryKey: ["timekeeping-desktop-connection"], queryFn: resolveLegalworkConnection, enabled: native,
    staleTime: 30_000, retry: false,
  });
  const refetchConnection = connection.refetch;
  useEffect(() => {
    if (!native) return;
    const refresh = () => { void refetchConnection(); };
    window.addEventListener("legalwork-server-settings-changed", refresh);
    return () => window.removeEventListener("legalwork-server-settings-changed", refresh);
  }, [native, refetchConnection]);
  const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = connection.data ?? {};
  const client = useMemo(() => native && normalizedBaseUrl && resolvedHostToken && isLoopbackLegalworkServerUrl(normalizedBaseUrl)
    ? createLegalworkServerClient({ baseUrl: normalizedBaseUrl, token: resolvedToken, hostToken: resolvedHostToken }) : null,
    [native, normalizedBaseUrl, resolvedToken, resolvedHostToken]);
  const profile = useQuery(timeTrackingProfile(client));
  useDesktopTimeActivity(client, profile.data);
  return null;
}

/** LegalWork windows keep renderer timers active in the background. Sample once per profile across windows. */
export function useDesktopTimeActivity(client: LegalworkServerClient | null | undefined, profile: Profile | undefined) {
  const cache = useQueryClient();
  const profileId = profile?.enabled && profile.desktopActivity ? profile.profileId : undefined;
  const scope = profile?.scope, principal = profile?.principal, user = profile?.user;
  useEffect(() => {
    const system = window.__LEGALWORK_ELECTRON__?.system;
    const sample = system?.sampleWorkdayDesktopActivity;
    if (!client || !isLoopbackLegalworkServerUrl(client.baseUrl) || !profileId || !scope || !user ||
        principal === undefined || !sample) return;

    const controller = new AbortController();
    const { signal } = controller;
    const identity = { profileId, scope, principal, user };
    const statusKey = desktopCaptureKey(profileId);
    let busy = false;
    const tick = async () => {
      if (busy || signal.aborted) return;
      busy = true;
      try {
        const observation = await sample();
        if (signal.aborted) return;
        await client.recordDesktopTimeActivity(identity, observation, signal);
        if (!signal.aborted) cache.setQueryData<DesktopCaptureStatus>(statusKey, { at: observation.observedAt, state: observation.state });
      } catch {
        if (!signal.aborted) cache.setQueryData<DesktopCaptureStatus>(statusKey, { at: Date.now(), state: "failed" });
      } finally {
        busy = false;
      }
    };
    async function observe() {
      if (signal.aborted) return;
      const timer = window.setInterval(tick, 15_000);
      window.addEventListener("focus", tick);
      try {
        void tick();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        window.clearInterval(timer);
        window.removeEventListener("focus", tick);
      }
    }
    // Older embedded browsers can omit Web Locks. The server also coalesces repeated observations.
    if (navigator.locks) void navigator.locks.request("legalwork.desktop-activity." + profileId, { signal }, observe).catch(() => {
      if (!signal.aborted) cache.setQueryData<DesktopCaptureStatus>(statusKey, { at: Date.now(), state: "failed" });
    });
    else void observe();
    return () => {
      controller.abort();
      cache.removeQueries({ queryKey: statusKey, exact: true });
    };
  }, [cache, client, profileId, scope, principal, user]);
}
