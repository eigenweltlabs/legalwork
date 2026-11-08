import { useSyncExternalStore } from "react";

type Removal = {
  confirmed: boolean;
  finished: Promise<boolean>;
  finish: (removed: boolean) => void;
};

const removals = new Map<string, Map<string, Removal>>();
const listeners = new Set<() => void>();
const announce = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function pendingProjectRemoval(baseUrl: string, workspaceId: string) {
  return removals.get(baseUrl)?.get(workspaceId);
}

export function isProjectRemoving(workspaceId: string) {
  return [...removals.values()].some(server => server.has(workspaceId));
}

export function useProjectRemoving(workspaceId: string) {
  return useSyncExternalStore(subscribe, () => isProjectRemoving(workspaceId), () => false);
}

export function beginProjectRemoval(baseUrl: string, workspaceId: string) {
  if (pendingProjectRemoval(baseUrl, workspaceId)) return null;
  let settle = (_removed: boolean) => {};
  const finished = new Promise<boolean>(resolve => { settle = resolve; });
  const server = removals.get(baseUrl) ?? new Map<string, Removal>();
  const removal: Removal = {
    confirmed: false,
    finished,
    finish: removed => {
      server.delete(workspaceId);
      if (!server.size) removals.delete(baseUrl);
      settle(removed);
      announce();
    },
  };
  server.set(workspaceId, removal);
  removals.set(baseUrl, server);
  announce();
  return removal;
}

/** A registry refresh may observe server removal before DELETE has replied. */
export function retainRemovingProjects<T extends { id: string }>(baseUrl: string, incoming: T[], previous: T[]): T[] {
  const next = incoming.filter(project => !pendingProjectRemoval(baseUrl, project.id)?.confirmed);
  previous.forEach((project, index) => {
    const removal = pendingProjectRemoval(baseUrl, project.id);
    if (removal && !removal.confirmed && !next.some(item => item.id === project.id)) next.splice(Math.min(index, next.length), 0, project);
  });
  return next;
}

/** Hold project reads until removal fails, or cancel them after confirmed removal. */
export async function waitForProjectRemoval(baseUrl: string, workspaceId: string, signal?: AbortSignal) {
  const removal = pendingProjectRemoval(baseUrl, workspaceId);
  if (!removal) return;
  signal?.throwIfAborted();
  let onAbort = () => {};
  try {
    const removed = await Promise.race([
      removal.finished,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (removed) throw new DOMException("Project removed", "AbortError");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
