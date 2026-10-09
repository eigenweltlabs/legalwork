import * as React from "react";

import type { BrowserStatePayload } from "@/app/lib/desktop";

import {
  type PanelTab,
  usePanelTabStore,
} from "./panel-tab-store";
import { getElectronBrowser } from "./utils";
import { confirmDiscardSessionDocuments } from "../artifacts/docx-document-state";

export function useSidePanelTabs(sessionId: string, active = true) {
  const syncBrowserTabs = usePanelTabStore((state) => state.syncBrowserTabs);

  const applyBrowserState = React.useCallback((browserState: BrowserStatePayload) => {
    const tabs = browserState.tabs ?? [];
    const activeTabId = browserState.activeTabId ?? tabs[0]?.id ?? null;

    syncBrowserTabs(sessionId, tabs, activeTabId);
    if (browserState.focusedTabId) {
      const store = usePanelTabStore.getState();
      const id = browserState.focusedTabId;
      if (store.sessions[sessionId]?.panes.some(pane => pane.activeTabId === id)) store.selectTab(sessionId, id);
    }
  }, [sessionId, syncBrowserTabs]);

  React.useEffect(() => {
    const browser = getElectronBrowser();

    if (!browser || !active) {
      return;
    }

    const unsub = browser.onStateChange?.(applyBrowserState);

    const refresh = () => { void browser.getState?.().then((browserState) => {
      if (browserState) {
        applyBrowserState(browserState);
      }
    }); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { unsub?.(); window.removeEventListener("focus", refresh); };
  }, [applyBrowserState, active]);

  const createTab = useCreateTab();

  const closeTab = useCloseTab();

  const selectTab = useSelectTab();

  const reorderTabs = useReorderTabs();

  return {
    createTab: async (url?: string, pane?: string) => {
      const result = await createTab(url);
      const state = await getElectronBrowser()?.getState?.();
      if (state) applyBrowserState(state);
      if (result && pane) usePanelTabStore.getState().moveTab(sessionId, result.tabId, pane);
    },
    closeTab: (tab: PanelTab) => closeTab(sessionId, tab),
    selectTab: (tabId: string) => selectTab(sessionId, tabId),
    reorderTabs: (tabIds: string[]) => reorderTabs(sessionId, tabIds),
  };
}

export function useCreateTab() {
  return React.useCallback((url?: string) => {
    return getElectronBrowser()?.createTab?.(url);
  }, []);
}

export function useCloseTab() {
  const closeTab = usePanelTabStore((state) => state.closeTab);

  return React.useCallback((sessionId: string, tab: PanelTab) => {
    if (tab.type === "browser") {
      void getElectronBrowser()?.closeTab?.(tab.id);

      return;
    }

    const wasActive = usePanelTabStore.getState().sessions[sessionId]?.activeTabId === tab.id;

    closeTab(sessionId, tab.id);

    if (wasActive) {
      const nextTabId = usePanelTabStore.getState().sessions[sessionId]?.activeTabId;
      const nextTab = usePanelTabStore.getState().sessions[sessionId]?.tabs.find((entry) => entry.id === nextTabId);

      if (nextTab?.type === "browser") {
        void getElectronBrowser()?.selectTab?.(nextTab.id);
      }
    }
  }, [closeTab]);
}

export function useSelectTab() {
  const selectTab = usePanelTabStore((state) => state.selectTab);

  return React.useCallback(function selectPanelTab(sessionId: string, tabId: string) {
    const tabs = usePanelTabStore.getState().sessions[sessionId]?.tabs ?? [];
    const tab = tabs.find((entry) => entry.id === tabId);

    if (!tab) {
      return;
    }

    const previous = usePanelTabStore.getState().sessions[sessionId];
    const pane = previous?.panes.find(pane => pane.tabIds.includes(tabId));
    if (!sessionId.startsWith("workspace:") && pane && pane.activeTabId !== tabId &&
      !confirmDiscardSessionDocuments(sessionId, [pane.activeTabId], undefined, true, () => selectPanelTab(sessionId, tabId))) return;

    selectTab(sessionId, tabId);
    const session = usePanelTabStore.getState().sessions[sessionId];
    if (!session?.panes.some(pane => pane.activeTabId === tabId)) return;

    if (tab.type === "browser") {
      void getElectronBrowser()?.selectTab?.(tabId);
    }
  }, [selectTab]);
}

export function useReorderTabs() {
  const reorderTabs = usePanelTabStore((state) => state.reorderTabs);

  return React.useCallback((sessionId: string, tabIds: string[]) => {
    const tabs = usePanelTabStore.getState().sessions[sessionId]?.tabs ?? [];
    const browserTabsById = new Map(
      tabs
        .filter((tab) => tab.type === "browser")
        .map((tab) => [tab.id, tab]),
    );
    const browserTabIds = tabIds.filter((tabId) => browserTabsById.has(tabId));

    reorderTabs(sessionId, tabIds);

    // Native order covers the window; send only this strip's subset. The main process
    // preserves all other panes/projects and validates the IDs atomically.
    if (browserTabIds.length > 1) void getElectronBrowser()?.reorderTabs?.(browserTabIds).catch(() => {
      // A native tab may have closed during the drag. Its state event removes
      // it locally; the remaining strip already has the requested order.
    });
  }, [reorderTabs]);
}
