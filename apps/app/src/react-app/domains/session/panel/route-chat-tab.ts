import type { createPanelTabStore } from "./panel-tab-store";

/** Store notifications can render before navigation catches up after a close. */
export function syncRouteChatTab(store: ReturnType<typeof createPanelTabStore>, input: {
  scope: string; sessionId: string; label: string; previousRoute: string | null; restoringTab: boolean; parentID?: string;
}) {
  const route = `${input.scope}:${input.sessionId}`;
  const state = store.getState();
  const tab = state.sessions[input.scope]?.tabs.find(tab => tab.type === "chat" && tab.sessionId === input.sessionId);
  if (tab) {
    state.updateTabLabel(input.scope, tab.id, input.label || tab.label);
    if (!input.restoringTab && input.previousRoute !== route) state.selectTab(input.scope, tab.id);
  } else if (!input.restoringTab && input.previousRoute !== route) {
    state.adoptChat(input.scope, input.sessionId, input.label, { parentID: input.parentID });
  }
  return route;
}
