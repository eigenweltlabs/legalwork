import { useState, type ReactNode } from "react";
import { Copy, Link2, MoreHorizontal, Pin } from "lucide-react";
import type { ProjectFileSource } from "@legalwork/types/project-files";
import { projectFileSourceKey, writeProjectFilesDrag } from "@/app/lib/project-file-drag";
import { Checkbox } from "@/components/ui/checkbox";
import { useFileSelectionItem } from "../../workspace/file-selection";
import { ProjectFileTransfer } from "../../workspace/project-file-transfer";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { filePinKey, toggleFilePin, useFilePins, type FilePin } from "./file-pins";

type Action = { label: string; icon?: ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean } | "separator";

/** One action list serves both right-click and the visible, keyboard-accessible menu. */
export function FileEntryActions({ children, name, actions, pin, source, onOpen, className, toolbar = false, contextOnly = false }: {
  children?: ReactNode; name: string; actions: Action[]; pin?: FilePin; source?: ProjectFileSource; onOpen?: () => void; className?: string; toolbar?: boolean; contextOnly?: boolean;
}) {
  const key = pin ? filePinKey(pin) : source ? projectFileSourceKey(source) : undefined;
  const { selection, element, selected } = useFileSelectionItem(key && onOpen ? { key, name, pin, source, open: onOpen } : null);
  const [transfer, setTransfer] = useState<"copy" | "link" | null>(null);
  const pins = useFilePins();
  const pinned = Boolean(pin && pins.some(item => filePinKey(item) === filePinKey(pin)));
  const fileActions: Action[] = [...(source ? [
    { label: t("project_files.copy_to_project"), icon: <Copy />, onClick: () => setTransfer("copy") },
    { label: t("project_files.link_to_project"), icon: <Link2 />, onClick: () => setTransfer("link") },
  ] : []), ...actions];
  const entries: Action[] = pin ? [
    { label: t(pinned ? "project_browser.unpin_file" : "project_browser.pin_file"), icon: <Pin />, onClick: () => toggleFilePin(pin) },
    "separator", ...fileActions,
  ] : fileActions;
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
  return <><ContextMenu>
    <ContextMenuTrigger render={<div ref={element} className={cn("group/file-entry flex min-w-0 items-center rounded-lg hover:bg-muted/40", selected && "bg-primary/10 ring-1 ring-inset ring-primary/25", className)} />} onContextMenu={event => event.stopPropagation()}
      onDragStart={event => {
        if (!selected || !selection || selection.items.length < 2) return;
        const sources = selection.items.flatMap(item => item.source ? [item.source] : []);
        if (sources.length !== selection.items.length) { event.preventDefault(); return; }
        writeProjectFilesDrag(event.dataTransfer, sources, selection.scope);
      }}>
      {selection && key && onOpen && <Checkbox className="ml-2 mr-1" aria-label={t("project_browser.select_item", { name })} checked={selected} onCheckedChange={(_checked, details) => selection.toggle(key, details.event instanceof MouseEvent && details.event.shiftKey, element.current)} />}
      <div className="min-w-0 flex-1" onClickCapture={event => {
        if (selection && key && onOpen && (event.metaKey || event.ctrlKey || event.shiftKey || selection.ids.length)) {
          event.preventDefault(); event.stopPropagation(); selection.toggle(key, event.shiftKey, element.current);
        }
      }} onDoubleClickCapture={event => { if (selection?.ids.length) { event.preventDefault(); event.stopPropagation(); } }}>{children}</div>
      {pinned && <Pin className="size-3 shrink-0 fill-current text-muted-foreground" aria-label={t("project_browser.pinned")} />}
      {menu}
    </ContextMenuTrigger>
    <ContextMenuContent>{content(true)}</ContextMenuContent>
  </ContextMenu>{transfer && source && <ProjectFileTransfer sources={[source]} initialMode={transfer} folder="" onClose={() => setTransfer(null)} />}</>;
}
