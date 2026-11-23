import { create } from "zustand";
import { useEffect, useRef } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";

import { openWorkdaySurfaces, workdaySurfaceChange, type WorkdaySurface } from "./workday-surfaces";

type Sample = Parameters<LegalworkServerClient["observeActivity"]>[1][number];
type Stream = Omit<Sample, "start" | "end">;

export type AgentRun = { projectId: string; stream: string; title: string };

export const useWorkdayRoute = create<{ mounted: boolean; workspace: string | null; agents: AgentRun[] }>(() => ({
  mounted: false, workspace: null, agents: [],
}));

export function workdayStreams(windowId: string, workspace: string | null, resources: WorkdaySurface[], agents: AgentRun[], focused: boolean, active: boolean): Stream[] {
  const selected = resources.find(resource => resource.focused);
  const rows: Stream[] = resources.map(resource => ({
    projectId: resource.projectId, title: resource.title, surface: resource.type,
    ...(resource.type === "chat" ? { sessionId: resource.id, watching: resource === selected && focused } : {}),
    stream: JSON.stringify([windowId, resource.type, resource.id]),
    kind: resource === selected && active ? "foreground" : "passive",
  }));
  if (!selected && workspace) rows.push({ projectId: workspace, stream: windowId, kind: active ? "foreground" : "passive" });
  for (const run of agents) {
    const watching = focused && selected?.type === "chat" && selected.id === run.stream && selected.projectId === run.projectId;
    rows.push({ ...run, surface: "chat", kind: "agent", agentVisibility: watching ? "foreground" : "background" });
  }
  // This coverage lets the server recover short background runs between busy notifications.
  rows.push({ projectId: null, stream: windowId, kind: "window" });
  return rows;
}

/** A renderer observes its own focus. Busy sessions are independent of the selected project. */
export function useWorkdayActivity(
  client: LegalworkServerClient | null | undefined,
  profileId: string | null,
  refreshProfile: () => void,
  workspace: string | null,
  agents: AgentRun[],
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
          item.stream === agents[i].stream && item.title === agents[i].title,
      )
    )
      return;
    latest.current = { workspace, agents };
    tick.current?.();
  }, [workspace, agents]);
  useEffect(() => {
    if (!client || !profileId) return;
    const windowId = crypto.randomUUID();
    let lastInput = Date.now(), last = Date.now();
    let previous: Stream[] = [];
    const streams = (): Stream[] => {
      const focused = document.visibilityState === "visible" && document.hasFocus();
      return workdayStreams(windowId, latest.current.workspace, openWorkdaySurfaces(), latest.current.agents,
        focused, focused && Date.now() - lastInput < 90_000);
    };
    const sample = () => {
      const now = Date.now(),
        start = last;
      const observed = previous;
      last = now;
      previous = streams();
      // A sleeping host cannot attest elapsed time while suspended.
      if (now <= start || now - start > 90_000 || !observed.length) return;
      for (let i = 0; i < observed.length; i += 16) {
        void client.observeActivity(profileId, observed.slice(i, i + 16).map(row => ({ ...row, start, end: now })))
          .catch(refreshProfile);
      }
    };
    // React layouts may replace a pane and its chat together in one commit.
    const layoutChange = () => queueMicrotask(() => {
      if (tick.current === sample && JSON.stringify(previous) !== JSON.stringify(streams())) sample();
    });
    tick.current = sample;
    window.addEventListener(workdaySurfaceChange, layoutChange);
    const input = () => {
      const wasIdle = Date.now() - lastInput >= 90_000;
      lastInput = Date.now();
      if (wasIdle) sample();
    };
    const focus = () => {
      lastInput = Date.now();
      sample();
    };
    previous = streams();
    const timer = window.setInterval(sample, 30_000);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", sample);
    document.addEventListener("visibilitychange", sample);
    window.addEventListener("pagehide", sample);
    for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
      window.addEventListener(name, input, { passive: true });
    return () => {
      window.removeEventListener(workdaySurfaceChange, layoutChange);
      previous = [];
      tick.current = undefined;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", sample);
      document.removeEventListener("visibilitychange", sample);
      window.removeEventListener("pagehide", sample);
      for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
        window.removeEventListener(name, input);
    };
  }, [client, profileId, refreshProfile]);
}
