import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { ProjectSyncOverview, ProjectSyncState } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { onSyncPoke, useSyncEventsLive } from "@/react-app/kernel/sync-events";

/** Every synced project's state, for the sidebar; filled by `useProjectSyncPoller`. */
export const useProjectSyncStore = create<{
  states: Record<string, ProjectSyncState>;
  setOverview: (overview: ProjectSyncOverview) => void;
  /** Ask the poller for the overview now, after a change made here. */
  refresh: () => void;
}>()((set) => ({
  states: {},
  setOverview: (overview) => set({ states: overview.states }),
  refresh: () => {},
}));

/**
 * How often the app asks its own server for sync states while it hears no
 * sync events from it (kernel/sync-events.ts). With them, a round's changes
 * show as soon as the round ends.
 */
export const PROJECT_SYNC_POLL_MS = 5_000;

/**
 * Keep the sidebar's sync states current, reload the project list when
 * projects arrive from the firm, leave, or are renamed there, tell which
 * projects' files sync changed here (a colleague's note, a conflict copy),
 * and which projects sync took off this computer.
 */
export function useProjectSyncPoller(
  client: LegalworkServerClient | null,
  onProjectsChanged: () => void,
  onContentsChanged: (workspaceIds: string[]) => void,
  onProjectsRemoved: (workspaceIds: string[]) => void,
): void {
  const setOverview = useProjectSyncStore((state) => state.setOverview);
  const revision = useRef<number | null>(null);
  const contents = useRef<Record<string, number> | null>(null);
  const changed = useRef(onProjectsChanged);
  changed.current = onProjectsChanged;
  const contentsChanged = useRef(onContentsChanged);
  contentsChanged.current = onContentsChanged;
  const projectsRemoved = useRef(onProjectsRemoved);
  projectsRemoved.current = onProjectsRemoved;
  const forgotten = useRef(new Set<string>());
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    const poll = async () => {
      try {
        const overview = await client.projectSyncOverview();
        if (stopped) return;
        setOverview(overview);
        if (revision.current !== null && revision.current !== overview.revision) changed.current();
        revision.current = overview.revision;
        const before = contents.current;
        const moved = Object.keys(overview.contents).filter((id) => before !== null && before[id] !== overview.contents[id]);
        if (moved.length > 0) contentsChanged.current(moved);
        contents.current = overview.contents;
        const gone = overview.removed.filter((id) => !forgotten.current.has(id));
        for (const id of gone) forgotten.current.add(id);
        if (gone.length > 0) projectsRemoved.current(gone);
      } catch {
        // An older server has no project sync: nothing to show.
      }
    };
    void poll();
    useProjectSyncStore.setState({ refresh: () => void poll() });
    const unsubscribe = onSyncPoke((poke) => {
      if (poke.projects || poke.resync) void poll();
    });
    const timer = window.setInterval(() => {
      if (!useSyncEventsLive.getState().live) void poll();
    }, PROJECT_SYNC_POLL_MS);
    return () => {
      stopped = true;
      unsubscribe();
      window.clearInterval(timer);
      useProjectSyncStore.setState({ refresh: () => {} });
    };
  }, [client, setOverview]);
}
