import { expect, test } from "bun:test";
import { acceptLauncherBrowser, launcherBrowserRoute } from "../src/react-app/launcher/launcher-handoff";
import { usePanelTabStore, workspacePanelKey, type BrowserPanelTab } from "../src/react-app/domains/session/panel/panel-tab-store";

test("browser handoff opens the new native tab in its destination pane without importing unrelated tabs", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousState = usePanelTabStore.getState();
  const tab: BrowserPanelTab = { id: "browser-new", type: "browser", label: "New tab", url: "about:blank", favicon: null, status: "ready", canGoBack: false, canGoForward: false };
  let created = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __LEGALWORK_ELECTRON__: { browser: {
    createTab: async () => { created++; return { tabId: tab.id }; },
    getState: async () => ({ tabs: [{ ...tab, id: "browser-unrelated" }, tab], activeTabId: tab.id }),
  } } } });
  usePanelTabStore.setState({ sessions: {} });
  try {
    const scope = workspacePanelKey("destination");
    const panels = usePanelTabStore.getState();
    panels.openTab(scope, { id: "document", type: "artifact", label: "Document", value: "document.md" });
    const paneId = usePanelTabStore.getState().sessions[scope].panes[0].id;
    await acceptLauncherBrowser("destination", paneId);
    const result = usePanelTabStore.getState().sessions[scope];
    expect(created).toBe(1);
    expect(result.tabs.map(item => item.id)).toEqual(["document", "browser-new"]);
    expect(result.panes.find(pane => pane.id === paneId)?.activeTabId).toBe(tab.id);
    const route = new URL(launcherBrowserRoute("project / one", "pane & one"), "https://legalwork.test");
    expect(route.pathname).toBe("/workspace/project%20%2F%20one/session");
    expect(route.searchParams.get("launcherBrowser")).toBe("pane & one");
    expect(route.searchParams.get("view")).toBe("workspace");
  } finally {
    usePanelTabStore.setState(previousState);
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
