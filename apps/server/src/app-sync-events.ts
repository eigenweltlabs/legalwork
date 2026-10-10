import type { SyncPoke } from "@legalwork/types/sync-events";

import type { ServerConfig } from "./types.js";

/**
 * What the app windows hear about sync on this computer: each keeps one
 * server-sent event stream open to this server (GET /sync/events). An event
 * says only that projects, tasks or the firm's policy changed here (a sync round brought or
 * sent something, a reminder came due, another window or an agent changed a
 * task); the window re-reads what it shows. The first event on every
 * connection is a resync, so what happened before, or while it was not
 * connected, is not missed. While the stream is open, the app does not poll
 * what it covers.
 */

type Change = "projects" | "tasks" | "policy" | "hub" | "sessions" | "approvals";

/** Changes close together go as one event: a round that brought ten notes reloads once. */
const COALESCE_MS = 250;
/** Keeps a quiet stream from being closed as idle. */
const PING_MS = 25_000;

const listeners = new Map<string, Set<(change: Change) => void>>();

function keyOf(config: ServerConfig): string {
  return process.env.LEGALWORK_RUNTIME_DB?.trim() || config.configPath?.trim() || "default";
}

/** Projects, tasks or the policy changed on this computer: every open window hears it. */
export function announceSyncChange(config: ServerConfig, change: Change): void {
  for (const listener of listeners.get(keyOf(config)) ?? []) listener(change);
}

/** One window's stream, open until the window closes it or the server stops. */
export function syncEventStream(config: ServerConfig, signal: AbortSignal): Response {
  const key = keyOf(config);
  const encoder = new TextEncoder();
  let stop = (_closed?: boolean) => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let pending: SyncPoke = {};
      let flush: ReturnType<typeof setTimeout> | null = null;
      const write = (text: string) => {
        if (open) controller.enqueue(encoder.encode(text));
      };
      const send = (poke: SyncPoke) => write(`data: ${JSON.stringify(poke)}\n\n`);
      const listener = (change: Change) => {
        pending[change] = true;
        flush ??= setTimeout(() => {
          flush = null;
          send(pending);
          pending = {};
        }, COALESCE_MS);
      };
      const own = listeners.get(key) ?? new Set();
      own.add(listener);
      listeners.set(key, own);
      const ping = setInterval(() => write(": ping\n\n"), PING_MS);
      ping.unref?.();
      stop = (closed = false) => {
        if (!open) return;
        open = false;
        own.delete(listener);
        clearInterval(ping);
        if (flush) clearTimeout(flush);
        // A stream the window cancelled is closed already.
        if (!closed) controller.close();
      };
      signal.addEventListener("abort", () => stop(), { once: true });
      if (signal.aborted) stop();
      send({ resync: true });
    },
    cancel() {
      stop(true);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
