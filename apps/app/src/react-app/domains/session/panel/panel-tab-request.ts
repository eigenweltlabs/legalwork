/** Requests carry an explicit destination when the source outlives navigation. */
import type { PanelTab } from "./panel-tab-store";
export type PanelTabDestination = { kind: "workspace"; workspaceId: string; paneId?: string } | { kind: "workflows" } | { kind: "evals" };
export type PanelTabRequest = PanelTab & { destination?: PanelTabDestination; openAsPreview?: boolean };
export const PANEL_OPEN_TAB_EVENT = "legalwork:panel-open-tab";
export function requestPanelTab(tab: PanelTab, destination?: PanelTabDestination, options?: { preview?: boolean }): void {
  window.dispatchEvent(new CustomEvent<PanelTabRequest>(PANEL_OPEN_TAB_EVENT, { detail: { ...tab, destination, openAsPreview: options?.preview } }));
}
