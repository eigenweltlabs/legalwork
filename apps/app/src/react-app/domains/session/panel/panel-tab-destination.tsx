import { createContext, useCallback, useContext, type ReactNode } from "react";
import { requestPanelTab, type PanelTabDestination } from "./panel-tab-request";
import type { PanelTab } from "./panel-tab-store";
const Destination = createContext<PanelTabDestination | undefined>(undefined);
export function PanelTabDestinationProvider({ destination, children }: { destination: PanelTabDestination; children: ReactNode }) {
  return <Destination.Provider value={destination}>{children}</Destination.Provider>;
}
export function useRequestPanelTab() {
  const destination = useContext(Destination);
  return useCallback((tab: PanelTab) => requestPanelTab(tab, destination), [destination]);
}
export function useRequestOpenTask() {
  const request = useRequestPanelTab();
  return useCallback((taskId: string, label = "Task") => request({ id: `task:${taskId}`, type: "task", taskId, label }), [request]);
}
