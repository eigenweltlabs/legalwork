import { Clock3, FolderOpen, MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import type { ScheduledTask } from "@legalwork/types/scheduled-tasks";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { formatRunTime, taskStatusLabel } from "./schedule-format";

export function ScheduledTaskListItem({ task, projectName, selected, disabled, onSelect, onEdit, onToggle, onDelete }: {
  task: ScheduledTask; projectName: string; selected: boolean; disabled: boolean;
  onSelect: () => void; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const actions = [
    { label: t("scheduled.edit"), Icon: Pencil, onClick: onEdit },
    ...(task.status === "completed" ? [] : [{ label: t(task.status === "active" ? "scheduled.pause" : "scheduled.resume"), Icon: task.status === "active" ? Pause : Play, onClick: onToggle }]),
  ];
  return <ContextMenu>
    <ContextMenuTrigger render={<div />} className={cn("group flex items-start rounded-xl transition-colors hover:bg-sidebar-accent/60", selected && "bg-sidebar-accent")}>
      <button onClick={onSelect} aria-pressed={selected} className="flex min-w-0 flex-1 gap-2.5 rounded-xl px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Clock3 className={cn("mt-0.5 size-4 shrink-0", task.status === "active" ? "text-blue-11" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{task.title}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><FolderOpen className="size-3 shrink-0" /><span className="truncate" title={projectName}>{projectName}</span></span>
          <span className="mt-1.5 block truncate text-[11px] text-muted-foreground">{task.status === "active" && task.nextRunAt ? formatRunTime(task.nextRunAt, task.schedule.timeZone) : taskStatusLabel(task.status)}</span>
        </span>
      </button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="mr-1 mt-2 shrink-0 text-muted-foreground" aria-label={t("scheduled.task_actions", { title: task.title })} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">{actions.map(({ label, Icon, onClick }) => <DropdownMenuItem key={label} disabled={disabled} onClick={onClick}><Icon />{label}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={disabled} onClick={onDelete}><Trash2 />{t("scheduled.delete")}</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>
    </ContextMenuTrigger>
    <ContextMenuContent>{actions.map(({ label, Icon, onClick }) => <ContextMenuItem key={label} disabled={disabled} onClick={onClick}><Icon />{label}</ContextMenuItem>)}<ContextMenuSeparator /><ContextMenuItem variant="destructive" disabled={disabled} onClick={onDelete}><Trash2 />{t("scheduled.delete")}</ContextMenuItem></ContextMenuContent>
  </ContextMenu>;
}
