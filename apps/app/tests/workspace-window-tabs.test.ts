import { expect, test } from "bun:test";
import { liveWindowTabs } from "../src/react-app/domains/session/panel/workspace-window-tabs";
import type { BrowserPanelTab, PanelTab } from "../src/react-app/domains/session/panel/panel-tab-store";

const browser = (id: string, url = "https://example.com"): BrowserPanelTab => ({
  id, type: "browser", label: id, url, favicon: null, status: "ready", canGoBack: false, canGoForward: false,
});
const chat: PanelTab = { id: "chat:one", type: "chat", sessionId: "one", label: "One" };

test("a new window cannot resurrect a closed or persisted stale browser", () => {
  expect(liveWindowTabs([chat, browser("closed"), browser("stale")], [])).toEqual([chat]);
});

test("copying uses current native URLs and excludes browsers outside the source layout", () => {
  const current = browser("open", "https://example.com/latest");
  expect(liveWindowTabs([chat, browser("open"), browser("closed")], [current, browser("another-project")])).toEqual([chat, current]);
});

test("copying a copy preserves the number and order of live browsers", () => {
  const first = liveWindowTabs([browser("a"), chat, browser("b")], [browser("a"), browser("b")]);
  const copied = first.map(tab => tab.type === "browser" ? { ...tab, id: `copy:${tab.id}` } : tab);
  const live = copied.filter((tab): tab is BrowserPanelTab => tab.type === "browser");
  expect(liveWindowTabs(copied, live)).toEqual(copied);
  expect(liveWindowTabs(copied, live.slice(1))).toEqual([chat, live[1]]);
});
