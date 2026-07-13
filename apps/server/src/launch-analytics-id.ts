/**
 * Anonymous per-launch id: minted once per server process and held in
 * memory only — a restart rotates it, nothing is persisted. Sent as a
 * header on eigenwelt-free requests and adopted by the desktop renderer
 * and Office pane as their analytics distinct id, so one launch shares
 * one id everywhere.
 */
import { randomUUID } from "node:crypto";

export const EIGENWELT_ANALYTICS_ID_HEADER = "X-Eigenwelt-Analytics-Id";

let launchId = "";

export function launchAnalyticsId(): string {
  if (!launchId) launchId = randomUUID();
  return launchId;
}
