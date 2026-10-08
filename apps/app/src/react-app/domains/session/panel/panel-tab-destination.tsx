import { createContext, useCallback, useContext, type ReactNode } from "react";
import { requestPanelTab, type PanelTabDestination } from "./panel-tab-request";
import type { PanelTab } from "./panel-tab-store";
import { startProjectItemDrag, type ProjectItemTab } from "./project-item-drag";
const Destination = createContext<PanelTabDestination | undefined>(undefined);
type OpenTab = (tab: PanelTab, options?: { preview?: boolean }) => void;
const Open = createContext<OpenTab | undefined>(undefined);
export function PanelTabDestinationProvider({ destination, onOpen, children }: { destination: PanelTabDestination; onOpen?: OpenTab; children: ReactNode }) {
  return <Destination.Provider value={destination}><Open.Provider value={onOpen}>{children}</Open.Provider></Destination.Provider>;
}
export function useRequestPanelTab(fallback?: PanelTabDestination) {
  const destination = useContext(Destination) ?? fallback;
  const open = useContext(Open);
  return useCallback((tab: PanelTab, options?: { preview?: boolean }) => open ? open(tab, options) : requestPanelTab(tab, destination, options), [destination, open]);
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
