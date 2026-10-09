import { useState, type ReactNode } from "react";
import { canTransferProjectFiles, hasProjectFileDrag, readProjectFilesDrag } from "@/app/lib/project-file-drag";
import { isFileIntakeTarget } from "../panel/file-drop-intent";
import { t } from "@/i18n";
import { toast } from "@/components/ui/sonner";
import { useProjectFiles } from "../../workspace/project-file-context";
import { projectFileTab } from "../../workspace/project-file-tab";
import { chatPanelTab, projectViewTab, usePanelTabStore, workspacePanelKey } from "../panel/panel-tab-store";
import { acceptsProjectItemDrag, readProjectItemDrag } from "../panel/project-item-drag";
import { projectViewLabel } from "../panel/project-view";
import { acceptsProjectViewDrag, readProjectViewDrag } from "./project-view-drag";
import { acceptsSessionsDrag, readSessionsDrag } from "./session-drag";

/** The sidebar Workspace destination always opens tabs; it never imports files. */
export function WorkspaceTabDropTarget({ projectId, projectName, sessionTitle, onOpen, children, className = "", hint = true }: {
  projectId: string; projectName: string; sessionTitle: (id: string) => string;
  onOpen: () => Promise<void>; children: ReactNode; className?: string; hint?: boolean;
}) {
  const files = useProjectFiles();
  const [over, setOver] = useState(false);
  const accepts = (data: Pick<DataTransfer, "types">) => hasProjectFileDrag(data) || acceptsSessionsDrag(data, projectId) || acceptsProjectViewDrag(data, projectId) || acceptsProjectItemDrag(data, projectId);
  const ready = accepts({ types: files?.dragTypes ?? [] });
  const label = t("project_files.drop_open_in", { project: projectName });
  const explicitIntake = (target: EventTarget, data: DataTransfer) => {
    if (!(target instanceof Element) || !hasProjectFileDrag(data)) return false;
    if (target.closest("[data-file-explorer]")) return true;
    if (isFileIntakeTarget(target.closest<HTMLElement>("[data-workspace-file-intake]")?.dataset.workspaceFileIntake, data, projectId)) return true;
    // Full-page Files is an explicit transfer destination for foreign files.
    return Boolean(target.closest("[data-project-file-drop]")) && canTransferProjectFiles(data, projectId);
  };
  return <div data-workspace-tab-drop={projectId} title={hint && ready ? label : undefined} className={`relative rounded-md ${hint && ready ? "outline outline-1 outline-dashed outline-primary/50" : ""} ${className}`}
    onDragOverCapture={event => {
      if (!accepts(event.dataTransfer)) return;
      if (explicitIntake(event.target, event.dataTransfer)) { setOver(false); return; }
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setOver(true);
    }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false); }}
    onDropCapture={event => {
      if (!accepts(event.dataTransfer)) return;
      if (explicitIntake(event.target, event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); setOver(false);
      const sources = readProjectFilesDrag(event.dataTransfer);
      const ids = readSessionsDrag(event.dataTransfer, projectId);
      const view = readProjectViewDrag(event.dataTransfer, projectId);
      const item = readProjectItemDrag(event.dataTransfer, projectId);
      try {
        if (!files) return;
        sources.forEach(files.sourceProject);
        const tabs = sources.length ? sources.map(projectFileTab) : ids.length ? ids.map(id => chatPanelTab(id, sessionTitle(id))) : view ? [projectViewTab(view, projectViewLabel(view))] : item ? [item] : [];
        if (!tabs.length) return;
        for (const tab of tabs) usePanelTabStore.getState().openTab(workspacePanelKey(projectId), tab);
        void onOpen().catch(error => toast.error(error instanceof Error ? error.message : t("project_files.failed")));
      } catch (error) { toast.error(error instanceof Error ? error.message : t("project_files.failed")); }
    }}>
    {children}
    {over && ready && <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-md border border-primary/40 bg-background/95 px-2 text-center text-xs font-medium">{label}</div>}
  </div>;
}
