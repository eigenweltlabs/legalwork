import { createContext, useCallback, useContext, type ReactNode } from "react";
import { requestPanelTab, type PanelTabDestination } from "./panel-tab-request";
import type { PanelTab } from "./panel-tab-store";
import { startProjectItemDrag, type ProjectItemTab } from "./project-item-drag";
const Destination = createContext<PanelTabDestination | undefined>(undefined);
export function PanelTabDestinationProvider({ destination, children }: { destination: PanelTabDestination; children: ReactNode }) {
  return <Destination.Provider value={destination}>{children}</Destination.Provider>;
}
export function useRequestPanelTab() {
  const destination = useContext(Destination);
  return useCallback((tab: PanelTab, options?: { preview?: boolean }) => requestPanelTab(tab, destination, options), [destination]);
}
export function useProjectItemDrag() {
  const destination = useContext(Destination);
  return destination?.kind === "workspace"
    ? (data: DataTransfer, tab: ProjectItemTab) => startProjectItemDrag(data, destination.workspaceId, tab)
    : undefined;
}
export function useRequestOpenTask() {
  const request = useRequestPanelTab();
  return useCallback((taskId: string, label = "Task", options = { preview: true }) => request({ id: `task:${taskId}`, type: "task", taskId, label }, options), [request]);
}
