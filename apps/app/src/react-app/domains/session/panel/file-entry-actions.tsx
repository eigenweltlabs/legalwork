import type { ReactNode } from "react";
import { MoreHorizontal, Pin } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { filePinKey, toggleFilePin, useFilePins, type FilePin } from "./file-pins";

type Action = { label: string; icon?: ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean } | "separator";

/** One action list serves both right-click and the visible, keyboard-accessible menu. */
export function FileEntryActions({ children, name, actions, pin, className, toolbar = false, contextOnly = false }: {
  children?: ReactNode; name: string; actions: Action[]; pin?: FilePin; className?: string; toolbar?: boolean; contextOnly?: boolean;
}) {
  const pins = useFilePins();
  const pinned = Boolean(pin && pins.some(item => filePinKey(item) === filePinKey(pin)));
  const entries: Action[] = pin ? [
    { label: t(pinned ? "project_browser.unpin_file" : "project_browser.pin_file"), icon: <Pin />, onClick: () => toggleFilePin(pin) },
    "separator", ...actions,
  ] : actions;
  const content = (context: boolean) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
    return entries.map((entry, index) => entry === "separator" ? <Separator key={index} /> : <Item key={index} disabled={entry.disabled} variant={entry.destructive ? "destructive" : "default"} onClick={entry.onClick}>{entry.icon}{entry.label}</Item>);
  };
  const menu = <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t("project_browser.file_actions", { name })}><MoreHorizontal className="size-4" /></Button>} /><DropdownMenuContent align="end">{content(false)}</DropdownMenuContent></DropdownMenu>;
  if (toolbar) return menu;
  if (contextOnly) return <ContextMenu>
    <ContextMenuTrigger render={<div className={className} />}>{children}</ContextMenuTrigger>
    <ContextMenuContent>{content(true)}</ContextMenuContent>
  </ContextMenu>;
  return <ContextMenu>
    <ContextMenuTrigger render={<div className={cn("group/file-entry flex min-w-0 items-center rounded-lg hover:bg-muted/40", className)} />} onContextMenu={event => event.stopPropagation()}>
      <div className="min-w-0 flex-1">{children}</div>
      {pinned && <Pin className="size-3 shrink-0 fill-current text-muted-foreground" aria-label={t("project_browser.pinned")} />}
      {menu}
    </ContextMenuTrigger>
    <ContextMenuContent>{content(true)}</ContextMenuContent>
  </ContextMenu>;
}
