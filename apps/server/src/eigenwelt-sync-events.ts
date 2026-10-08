import { serverSentEvents, syncPokeOf, type SyncPoke } from "./sync-events.js";

import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { requireIntakeClient } from "./eigenwelt-intake.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { scheduleFirmHubSync } from "./firm-hub.js";
import { scheduleOrgPolicySync } from "./org-policy.js";
import { scheduleProjectSync, setProjectSyncPoked } from "./project-sync.js";
import { scheduleTaskSync } from "./task-sync.js";
import { connectedTaskOrgId } from "./tasks-api.js";
import type { ServerConfig } from "./types.js";

/**
 * Pokes from the firm: while this computer is signed in to a firm, it keeps
 * one server-sent event stream open to the platform (GET /api/sync/events).
 * A poke says only that projects, tasks or the policy of the firm changed; the rounds it
 * starts pull what changed, through the routes that check what this member
 * may see. The first poke on every connection is a resync (the platform
 * listens by then), so nothing from before, or from a dropped connection, is
 * missed. The platform ends each stream before the token it was opened with
 * runs out; this connects again, with a fresh one.
 *
 * While pokes come, the project sync's timer only steps in every few minutes.
 */

/** A poke starts a round this soon: pokes close together are one round. */
const POKE_DELAY_MS = 300;
/** Signed out, or no firm: look again this often. */
const IDLE_RETRY_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Keep the stream open while the server runs; returns the stop function. */
export function startSyncEvents(
  config: ServerConfig,
  options: { fetch?: typeof fetch; onPoke?: (poke: SyncPoke) => void } = {},
): () => void {
  const stop = new AbortController();
  const onPoke =
    options.onPoke ??
    ((poke: SyncPoke) => {
      if (poke.projects || poke.resync) scheduleProjectSync(config, POKE_DELAY_MS);
      if (poke.tasks || poke.resync) scheduleTaskSync(config, POKE_DELAY_MS);
      if (poke.policy || poke.resync) void scheduleOrgPolicySync(config, { force: true });
      if (poke.hub || poke.resync) void scheduleFirmHubSync(config, { force: true });
    });
  void (async () => {
    let backoff = 1_000;
    while (!stop.signal.aborted) {
      const connection = await readEigenweltConnection(config).catch(() => null);
      if (!connection || connectedTaskOrgId(connection) === null) {
        await sleep(IDLE_RETRY_MS, stop.signal);
        continue;
      }
      await ensureFreshPlatformToken(config).catch(() => null);
      let heard = false;
      try {
        const client = requireIntakeClient(await readEigenweltConnection(config));
        const response = await (options.fetch ?? fetch)(`${client.platformURL}/api/sync/events`, {
          headers: { Authorization: `Bearer ${client.platformToken}`, Accept: "text/event-stream" },
          signal: stop.signal,
        });
        if (!response.ok || !response.body) throw new Error(`sync events: HTTP ${response.status}`);
        setProjectSyncPoked(config, true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const feed = serverSentEvents((data) => {
          heard = true;
          const poke = syncPokeOf(data);
          if (poke) onPoke(poke);
        });
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          feed(decoder.decode(chunk.value, { stream: true }));
        }
      } catch {
        // Dropped, refused or unreachable: connect again, backing off unless it had worked.
      } finally {
        setProjectSyncPoked(config, false);
      }
      backoff = heard ? 1_000 : Math.min(backoff * 2, MAX_BACKOFF_MS);
      await sleep(backoff, stop.signal);
    }
  })();
  return () => stop.abort();
}
