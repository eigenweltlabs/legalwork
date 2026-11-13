import { usePanelTabStore, type PanelTab } from "../panel/panel-tab-store";
import { layoutLeaves, type DocumentLayoutNode } from "../panel/document-layout";

export function paneRightOfChat(tree: DocumentLayoutNode, chatPaneId: string): string | undefined {
  if (tree.type === "pane") return;
  if (layoutLeaves(tree.first).includes(chatPaneId)) {
    return paneRightOfChat(tree.first, chatPaneId) ?? (tree.direction === "horizontal" ? layoutLeaves(tree.second)[0] : undefined);
  }
  return paneRightOfChat(tree.second, chatPaneId);
}

/** Promotions open beside the chat; website popups stay in their opener's pane. */
export function openBackgroundTab(scope: string, sessionId: string, tab: PanelTab, openerTabId?: string) {
  const store = usePanelTabStore.getState();
  // Server workspace IDs and local project IDs can differ. Use the owning
  // chat's actual panel scope instead of creating a second, invisible layout.
  const openerScope = openerTabId ? Object.keys(store.sessions).find(key => store.sessions[key].tabs.some(item => item.id === openerTabId)) : undefined;
  scope = openerScope ?? Object.keys(store.sessions).find(key => store.sessions[key].tabs.some(item => item.id === `chat:${sessionId}`)) ?? scope;
  const session = store.sessions[scope];
  const opener = openerTabId ? session?.panes.find(pane => pane.tabIds.includes(openerTabId)) : undefined;
  const chat = session?.panes.find(pane => pane.tabIds.includes(`chat:${sessionId}`));
  const right = session && chat ? paneRightOfChat(session.tree, chat.id) : undefined;
  store.openTab(scope, tab, opener?.id ?? right ?? chat?.id, opener || right ? undefined : "right");
  if (tab.type === "browser") void window.__LEGALWORK_ELECTRON__?.browser?.selectTab?.(tab.id);
}
