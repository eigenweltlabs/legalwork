import type { PanelTab } from "../domains/session/panel/panel-tab-store";

export type WorkdaySurface = {
  projectId: string;
  id: string;
  title: string;
  type: "chat" | "document" | "view";
  focused: boolean;
};

const layouts = new Map<symbol, WorkdaySurface[]>();
export const workdaySurfaceChange = "legalwork:workday-surface-change";

export function setWorkdaySurfaces(key: symbol, surfaces: WorkdaySurface[]) {
  if (surfaces.length) layouts.set(key, surfaces);
  else layouts.delete(key);
  window.dispatchEvent(new Event(workdaySurfaceChange));
}

export function openWorkdaySurfaces() {
  const unique = new Map<string, WorkdaySurface>();
  for (const surfaces of layouts.values()) for (const surface of surfaces) {
    const key = JSON.stringify([surface.projectId, surface.type, surface.id]);
    if (!unique.has(key) || surface.focused) unique.set(key, surface);
  }
  return Array.from(unique.values());
}

export function workdayTab(tab: PanelTab, workspaceId: string | null, focused: boolean): WorkdaySurface | undefined {
  let projectId = workspaceId;
  if (tab.type === "artifact") projectId = tab.storage?.workspaceId ?? tab.sourceProject?.workspaceId ?? tab.source?.workspaceId ?? projectId;
  if (!projectId || !tab.label || tab.type === "workspace-page" || tab.type === "browser" || (tab.type === "chat" && tab.parentID)) return;
  const type = tab.type === "artifact" || tab.type === "wiki" && tab.location.kind !== "graph" ? "document" : tab.type === "chat" ? "chat" : "view";
  return { projectId, type, id: tab.type === "chat" ? tab.sessionId : tab.id, title: tab.label.slice(0, 500), focused };
}
