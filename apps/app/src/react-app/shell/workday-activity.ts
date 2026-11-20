import { useEffect, useRef } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";

type Sample = Parameters<LegalworkServerClient["observeActivity"]>[1][number];
type Stream = Pick<Sample, "projectId" | "stream" | "kind">;

/** A renderer observes its own focus. Busy sessions are independent of the selected project. */
export function useWorkdayActivity(
  client: LegalworkServerClient | null | undefined,
  workspace: string | null,
  agents: { projectId: string; stream: string }[],
) {
  const latest = useRef({ workspace, agents });
  const tick = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const prev = latest.current;
    if (
      prev.workspace === workspace &&
      prev.agents.length === agents.length &&
      prev.agents.every(
        (item, i) =>
          item.projectId === agents[i].projectId &&
          item.stream === agents[i].stream,
      )
    )
      return;
    latest.current = { workspace, agents };
    tick.current?.();
  }, [workspace, agents]);
  useEffect(() => {
    if (!client) return;
    const windowId = crypto.randomUUID();
    let profile = "",
      stopped = false,
      connecting = false,
      lastInput = Date.now(),
      last = Date.now();
    let previous: Stream[] = [];
    const connect = async () => {
      if (connecting || stopped) return;
      connecting = true;
      try {
        const next = await client.activityProfile();
        if (!stopped) {
          profile = next.profileId;
          last = Date.now();
          previous = streams();
        }
      } catch {
        /* Hosted surfaces may have no private device service. */
      } finally {
        connecting = false;
      }
    };
    const foreground = () =>
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      Date.now() - lastInput < 90_000;
    const streams = (): Stream[] => [
      ...(latest.current.workspace
        ? [
            {
              projectId: latest.current.workspace,
              stream: windowId,
              kind: foreground()
                ? ("foreground" as const)
                : ("passive" as const),
            },
          ]
        : []),
      ...latest.current.agents.map((run) => ({
        ...run,
        kind: "agent" as const,
      })),
    ];
    const sample = () => {
      const now = Date.now(),
        start = last;
      const observed = previous;
      last = now;
      previous = streams();
      if (!profile) {
        void connect();
        return;
      }
      // A sleeping host cannot attest elapsed time while suspended.
      if (now <= start || now - start > 90_000 || !observed.length) return;
      void client
        .observeActivity(
          profile,
          observed.map((row) => ({ ...row, start, end: now })),
        )
        .catch(() => {
          profile = "";
        });
    };
    tick.current = sample;
    const input = () => {
      const wasIdle = Date.now() - lastInput >= 90_000;
      lastInput = Date.now();
      if (wasIdle) sample();
    };
    const focus = () => {
      lastInput = Date.now();
      sample();
    };
    void connect();
    const timer = window.setInterval(sample, 30_000);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", sample);
    document.addEventListener("visibilitychange", sample);
    window.addEventListener("pagehide", sample);
    for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
      window.addEventListener(name, input, { passive: true });
    return () => {
      sample();
      stopped = true;
      tick.current = undefined;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", sample);
      document.removeEventListener("visibilitychange", sample);
      window.removeEventListener("pagehide", sample);
      for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
        window.removeEventListener(name, input);
    };
  }, [client]);
}
