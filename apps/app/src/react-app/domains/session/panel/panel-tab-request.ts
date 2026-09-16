/**
 * Asks the session page to open a tab in its side panel and reveal the panel.
 * For views that have something to show but do not own the panel (the Tasks
 * pane is a mainView; a chat chip names a task); the page opens it under
 * whichever panel key is current.
 *
 * Kept apart from the tab store: asking must not create the persisted store,
 * so a module that only asks (task-reference.ts) stays free of it.
 */
import type { PanelTab } from "./panel-tab-store";

export const PANEL_OPEN_TAB_EVENT = "legalwork:panel-open-tab";

export function requestPanelTab(tab: PanelTab): void {
  window.dispatchEvent(new CustomEvent<PanelTab>(PANEL_OPEN_TAB_EVENT, { detail: tab }));
}
