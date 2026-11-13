import { create } from "zustand";
import type { SessionInfo } from "@opencode/client";
import type { BrowserPanelTab } from "@/app/lib/desktop-types";
import { interactionSessionIds, type InteractionSessions } from "../sync/interaction-state";
import type { SessionActivityStatus } from "../status/session-activity-store";

export function visibleTaskBrowserTabs(tabs: BrowserPanelTab[], sessionId: string, assistant: boolean, sessions: InteractionSessions, assistantWorkers: readonly string[] = [], statuses: Readonly<Record<string, SessionActivityStatus>> = {}) {
  const owners = new Set(assistant ? [...interactionSessionIds(sessionId, sessions), ...assistantWorkers] : [sessionId]);
  return tabs.filter(tab => {
    if (!tab.background || tab.dismissed || !tab.taskSessionId || !owners.has(tab.taskSessionId)) return false;
    // A worker preview shows ongoing work, not a permanent artifact. Keep it
    // during approval waits or refresh gaps; never close a user-opened browser.
    const finished = statuses[tab.taskSessionId] === "idle" || statuses[tab.taskSessionId] === "error";
    return !(assistant && tab.taskSessionId !== sessionId && finished);
  });
}

/** Daily chats share one Assistant surface. Verify browser owners against the
 * native project location, including workers from a different day/context. */
export async function assistantBrowserWorkerIds(readSession: (id: string) => Promise<Pick<SessionInfo, "parentID" | "location">>, sessionId: string, owners: readonly string[]) {
  const assistant = await readSession(sessionId);
  const sessions = await Promise.allSettled(owners.map(readSession));
  return owners.filter((_, index) => {
    const result = sessions[index];
    return result.status === "fulfilled" && result.value.parentID && result.value.location.directory === assistant.location.directory;
  });
}

/** Window-local browser inventory, independent of whichever project is visible. */
export const useTaskBrowserTabs = create<{
  tabs: BrowserPanelTab[];
  update: (tabs: BrowserPanelTab[]) => void;
}>(set => ({ tabs: [], update: tabs => set({ tabs }) }));
