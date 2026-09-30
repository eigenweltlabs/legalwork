import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { SyncPoke } from "@legalwork/types/sync-events";

import type { LegalworkServerClient } from "@/app/lib/legalwork-server";

/**
 * The window's line to its server's sync events (app-sync-events.ts on the
 * server): an event says that projects or tasks changed on this computer,
 * and whatever shows them re-reads. While the line is open (`live`), what it
 * covers is not polled; while it is not (still connecting, or a server
 * without sync events), the polling goes on as before.
 */
export const useSyncEventsLive = create<{ live: boolean }>(() => ({ live: false }));

const listeners = new Set<(poke: SyncPoke) => void>();

/** Hear every sync event while the line is open; returns the unsubscribe. */
export function onSyncPoke(listener: (poke: SyncPoke) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Keep the line open while the window shows this server. Mounted once per
 * window. A new client for the same server (the route state makes one on
 * every refresh) keeps the line; a reconnect uses the newest.
 */
export function useSyncEvents(client: LegalworkServerClient | null): void {
  const latest = useRef(client);
  latest.current = client;
  const baseUrl = client?.baseUrl ?? null;
  useEffect(() => {
    if (baseUrl === null) return;
    const stop = new AbortController();
    void (async () => {
      let backoff = RETRY_MS;
      while (!stop.signal.aborted) {
        let heard = false;
        try {
          await latest.current?.syncEvents((poke) => {
            heard = true;
            // The first event of every connection: from here on nothing is missed.
            if (poke.resync) useSyncEventsLive.setState({ live: true });
            for (const listener of listeners) listener(poke);
          }, stop.signal);
        } catch {
          // Dropped, or a server without sync events: polled meanwhile, and tried again.
        }
        if (stop.signal.aborted) return;
        useSyncEventsLive.setState({ live: false });
        backoff = heard ? RETRY_MS : Math.min(backoff * 2, MAX_RETRY_MS);
        await sleep(backoff, stop.signal);
      }
    })();
    return () => {
      stop.abort();
      useSyncEventsLive.setState({ live: false });
    };
  }, [baseUrl]);
}
