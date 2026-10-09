import type { BrowserPanelTab, PanelTab } from "./panel-tab-store";

/** Copy this workspace's live browsers only, with their current URL/title.
 * A native tab elsewhere in the window is not part of the selected layout. */
export function liveWindowTabs(tabs: PanelTab[], liveBrowsers: BrowserPanelTab[]): PanelTab[] {
  const live = new Map(liveBrowsers.map(tab => [tab.id, tab]));
  return tabs.flatMap<PanelTab>(tab => {
    if (tab.type !== "browser") return [tab];
    const current = live.get(tab.id);
    return current ? [current] : [];
  });
}
