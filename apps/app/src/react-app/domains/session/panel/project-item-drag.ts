import type { ReviewPanelTab, TaskPanelTab } from "./panel-tab-store";

const ITEM_TYPE = "application/x-legalwork-project-item";
const scopeType = (id: string) => `application/x-legalwork-project-item-${encodeURIComponent(id).toLowerCase()}`;
export type ProjectItemTab = ReviewPanelTab | TaskPanelTab;

export function startProjectItemDrag(data: Pick<DataTransfer, "setData" | "effectAllowed">, projectId: string, tab: ProjectItemTab) {
  data.setData(ITEM_TYPE, JSON.stringify(tab));
  data.setData(scopeType(projectId), projectId);
  data.effectAllowed = "copyMove";
}
export function acceptsProjectItemDrag(data: Pick<DataTransfer, "types">, projectId: string) {
  return data.types.includes(ITEM_TYPE) && data.types.includes(scopeType(projectId));
}
export function readProjectItemDrag(data: Pick<DataTransfer, "types" | "getData">, projectId: string): ProjectItemTab | null {
  if (!acceptsProjectItemDrag(data, projectId) || data.getData(scopeType(projectId)) !== projectId) return null;
  try {
    const tab: unknown = JSON.parse(data.getData(ITEM_TYPE));
    if (!tab || typeof tab !== "object" || !("type" in tab) || !("label" in tab) || typeof tab.label !== "string") return null;
    if (tab.type === "task" && "taskId" in tab && typeof tab.taskId === "string" && tab.taskId) return { type: "task", id: `task:${tab.taskId}`, taskId: tab.taskId, label: tab.label };
    if (tab.type === "review" && "reviewId" in tab && typeof tab.reviewId === "string" && tab.reviewId) return { type: "review", id: `review:${tab.reviewId}`, reviewId: tab.reviewId, label: tab.label };
  } catch { /* Ignore malformed or unsupported drags. */ }
  return null;
}
