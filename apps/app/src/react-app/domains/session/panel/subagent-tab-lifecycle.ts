import type { PanelTab } from "./panel-tab-store";
import type { SessionActivityStatus } from "../status/session-activity-store";

/** Only tabs opened by the user participate. Opening a completed result keeps it open. */
export function subagentTabLifecycle(
  tabs: readonly PanelTab[],
  statuses: Readonly<Record<string, SessionActivityStatus>> | undefined,
  previouslyRunning: ReadonlySet<string>,
) {
  const running = new Set<string>();
  const completed: string[] = [];
  for (const tab of tabs) {
    if (tab.type !== "chat" || !tab.parentID) continue;
    const status = statuses?.[tab.sessionId];
    if (status === "idle") {
      if (previouslyRunning.has(tab.sessionId)) completed.push(tab.sessionId);
    } else if (previouslyRunning.has(tab.sessionId) || (status && status !== "error")) {
      // Missing status during a refresh and pending approvals are not completion.
      running.add(tab.sessionId);
    }
  }
  return { running, completed };
}
