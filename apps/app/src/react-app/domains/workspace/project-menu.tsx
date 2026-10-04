import type { ReactNode } from "react";
import { FolderOpen, FolderPlus, MessageSquare, Mic, MoreHorizontal, Plus, Settings2, Square, SquareCheck, Star, StickyNote, Trash2, Users } from "lucide-react";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import { isWindowsPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu";
import { t } from "@/i18n";
import { useRecorderStore } from "../recorder/recorder-store";
import { useProjectControls } from "./project-controls";
import { useProjectFavoritesStore } from "./project-favorites-store";

export function ProjectMenuItems({ workspace, variant = "dropdown" }: { workspace: WorkspaceInfo; variant?: "dropdown" | "context" }) {
  const controls = useProjectControls();
  const favorite = useProjectFavoritesStore(state => state.favoriteIds.includes(workspace.id));
  const toggleFavorite = useProjectFavoritesStore(state => state.toggleFavorite);
  const recording = useRecorderStore(state => Boolean(state.recording && state.recording.id !== state.dictationRecordingId));
  const recordingBusy = useRecorderStore(state => state.starting || state.finalizing || Boolean(state.importing) || Boolean(state.recording && state.recording.id === state.dictationRecordingId));
  const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const Separator = variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = variant === "context" ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = variant === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = variant === "context" ? ContextMenuSubContent : DropdownMenuSubContent;
  return <>
    <Sub>
      <SubTrigger><Plus />{t("project_settings.create")}</SubTrigger>
      <SubContent>
        <Item disabled={controls.newChatDisabled || recordingBusy} onClick={() => controls.create(workspace, "chat")}><MessageSquare />{t("projects.new_chat")}</Item>
        <Item onClick={() => controls.create(workspace, "note")}><StickyNote />{t("projects.add_note")}</Item>
        <Item onClick={() => controls.create(workspace, "task")}><SquareCheck />{t("tasks.new_task")}</Item>
        <Item disabled={recordingBusy} onClick={() => controls.create(workspace, "record")}>{recording ? <Square /> : <Mic />}{t(recording ? "recorder.stop_recording" : "recorder.record")}</Item>
        <Item onClick={() => controls.create(workspace, "group")}><FolderPlus />{t("session_management.new_group")}</Item>
      </SubContent>
    </Sub>
    <Separator />
    <Item onClick={() => controls.openSettings(workspace)}><Settings2 />{t("project_settings.title")}</Item>
    {workspace.workspaceType === "local" ? <Item onClick={() => controls.openSettings(workspace, "sharing")}><Users />{t("project_settings.sharing")}</Item> : null}
    <Item onClick={() => toggleFavorite(workspace.id)}><Star className={favorite ? "fill-current" : undefined} />{t(favorite ? "projects.remove_favorite" : "projects.add_favorite")}</Item>
    {workspace.workspaceType === "local" ? <Item onClick={() => controls.onReveal(workspace.id)}><FolderOpen />{t(isWindowsPlatform() ? "workspace_list.reveal_explorer" : "workspace_list.reveal_finder")}</Item> : null}
    <Separator />
    <Item variant="destructive" onClick={() => controls.onForget(workspace.id)}><Trash2 />{t("project_settings.remove")}</Item>
  </>;
}

export function ProjectMenu({ workspace, className }: { workspace: WorkspaceInfo; className?: string }) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className={className} onClick={event => event.stopPropagation()} aria-label={t("sidebar.project_actions")}><MoreHorizontal /></Button>} />
    <DropdownMenuContent align="end" className="w-56"><ProjectMenuItems workspace={workspace} /></DropdownMenuContent>
  </DropdownMenu>;
}

export function ProjectContextMenu({ workspace, children }: { workspace: WorkspaceInfo; children: ReactNode }) {
  return <ContextMenu>
    <ContextMenuTrigger render={<div />} onContextMenu={event => event.stopPropagation()}>{children}</ContextMenuTrigger>
    <ContextMenuContent><ProjectMenuItems workspace={workspace} variant="context" /></ContextMenuContent>
  </ContextMenu>;
}
