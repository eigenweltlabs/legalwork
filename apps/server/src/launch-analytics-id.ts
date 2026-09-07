/**
 * Anonymous per-launch id: held in memory only — a restart rotates it,
 * nothing is persisted. Sent as a header on Eigenwelt gateway requests and
 * shared with the desktop renderer and Office pane, so one launch shares
 * one id everywhere.
 *
 * The desktop mints it and offers it via PUT /analytics/identity, rather
 * than asking for one: the renderer captures events (app open, welcome
 * screen) before any round-trip could answer, and those would otherwise
 * land on a second id. This module mints one only when asked before a
 * client has offered anything — headless runs, the CLI, tests.
 */
import { randomUUID } from "node:crypto";

export const EIGENWELT_ANALYTICS_ID_HEADER = "X-Eigenwelt-Analytics-Id";

/** Opaque, header-safe, and long enough to not collide: what clients mint. */
const OFFERED_ID = /^[A-Za-z0-9._-]{8,64}$/;

let launchId = "";

export function launchAnalyticsId(): string {
  if (!launchId) launchId = randomUUID();
  return launchId;
}

/**
 * Adopt a client-minted launch id, returning the id now in force.
 *
 * First writer wins: once an id is in use — offered or minted here — it
 * stays for the process lifetime, so a second window or a reconnect never
 * renames a launch mid-flight. Offered ids are shape-checked because this
 * value is interpolated into an outbound request header; anything else is
 * ignored in favour of a locally minted id.
 */
export function adoptLaunchAnalyticsId(offered: string): string {
  launchId = resolveLaunchAnalyticsId(launchId, offered);
  return launchId;
}

/**
 * The id a launch should use, given what is already in force and what a
 * client offered. Pure, so the precedence rules can be exercised without the
 * process-global id — which anything else sharing the process may already
 * have claimed.
 */
export function resolveLaunchAnalyticsId(inForce: string, offered: string): string {
  if (inForce) return inForce;
  return isAdoptableLaunchAnalyticsId(offered) ? offered : randomUUID();
}

/**
 * Whether a client-offered id is safe to adopt. The value is interpolated
 * into an outbound request header, so anything that could break or inject a
 * header line is refused and a locally minted id is used instead.
 */
export function isAdoptableLaunchAnalyticsId(offered: string): boolean {
  return OFFERED_ID.test(offered);
}
