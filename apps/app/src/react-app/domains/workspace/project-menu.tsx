import type { ReactNode } from "react";
import { FolderOpen, MoreHorizontal, Settings2, Trash2 } from "lucide-react";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import { isWindowsPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { t } from "@/i18n";
import { useProjectControls } from "./project-controls";

export function ProjectMenuItems({ workspace, variant = "dropdown" }: { workspace: WorkspaceInfo; variant?: "dropdown" | "context" }) {
  const controls = useProjectControls();
  const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const Separator = variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  return <>
    <Item onClick={() => controls.openSettings(workspace)}><Settings2 />{t("project_settings.title")}</Item>
    {workspace.workspaceType === "local" ? <Item onClick={() => controls.onReveal(workspace.id)}><FolderOpen />{t(isWindowsPlatform() ? "workspace_list.reveal_explorer" : "workspace_list.reveal_finder")}</Item> : null}
    <Separator />
    <Item variant="destructive" onClick={() => controls.onForget(workspace.id)}><Trash2 />{t("project_settings.remove")}</Item>
  </>;
}

export function ProjectMenu({ workspace, className }: { workspace: WorkspaceInfo; className?: string }) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className={className} onClick={event => event.stopPropagation()} aria-label={t("sidebar.project_actions")}><MoreHorizontal /></Button>} />
    <DropdownMenuContent align="end" className="w-64"><ProjectMenuItems workspace={workspace} /></DropdownMenuContent>
  </DropdownMenu>;
}

export function ProjectContextMenu({ workspace, children }: { workspace: WorkspaceInfo; children: ReactNode }) {
  return <ContextMenu>
    <ContextMenuTrigger render={<div />} onContextMenu={event => event.stopPropagation()}>{children}</ContextMenuTrigger>
    <ContextMenuContent className="w-64"><ProjectMenuItems workspace={workspace} variant="context" /></ContextMenuContent>
  </ContextMenu>;
}
