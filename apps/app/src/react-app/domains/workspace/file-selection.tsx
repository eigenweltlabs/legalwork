import { createContext, use, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Copy, FolderOpen, Link2, Pin, X } from "lucide-react";
import type { ProjectFileSource } from "@legalwork/types/project-files";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/i18n";
import { filePinKey, toggleFilePin, useFilePins, type FilePin } from "../session/panel/file-pins";
import { ProjectFileTransfer } from "./project-file-transfer";
import { useListSelection } from "./use-list-selection";
import { requestPanelTab } from "../session/panel/panel-tab-request";
import { projectFileTab } from "./project-file-tab";

type FileSelectionItem = { key: string; name: string; source?: ProjectFileSource; pin?: FilePin; open: () => void };
type RegisteredFile = { key: string; element: React.RefObject<HTMLDivElement | null>; current: React.RefObject<FileSelectionItem | null> };
const FileSelectionContext = createContext<{
  scope: string;
  ids: string[]; items: FileSelectionItem[];
  register: (entry: RegisteredFile) => () => void;
  toggle: (key: string, range: boolean, element: HTMLDivElement | null) => void;
} | null>(null);

export function FileSelectionProvider({ children, scope }: { children: (toolbar: ReactNode) => ReactNode; scope: string }) {
  const [rows, setRows] = useState<RegisteredFile[]>([]);
  const register = useCallback((entry: RegisteredFile) => {
    setRows(current => [...current, entry]);
    return () => setRows(current => current.filter(row => row !== entry));
  }, []);
  const visible = [...new Set(rows.map(row => row.key))];
  const selection = useListSelection(visible, scope);
  const anchor = useRef<HTMLDivElement | null>(null);
  const items = selection.ids.flatMap(id => {
    const item = rows.find(row => row.key === id)?.current.current;
    return item ? [item] : [];
  });
  const pins = useFilePins();
  const allPinned = items.length > 0 && items.every(item => item.pin && pins.some(pin => filePinKey(pin) === filePinKey(item.pin!)));
  const [transfer, setTransfer] = useState<{ sources: ProjectFileSource[]; mode: "copy" | "link" } | null>(null);
  const sources = items.flatMap(item => item.source ? [item.source] : []);
  const canTransfer = sources.length > 0 && sources.length === items.length;
  const toggle = (key: string, range: boolean, element: HTMLDivElement | null) => {
    const ordered = [...rows].sort((a, b) => {
      const left = a.element.current, right = b.element.current;
      return left && right && left !== right ? left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1 : 0;
    });
    const from = anchor.current ? ordered.findIndex(row => row.element.current === anchor.current) : -1;
    const to = ordered.findIndex(row => row.element.current === element);
    if (range && from >= 0 && to >= 0) selection.add(ordered.slice(Math.min(from, to), Math.max(from, to) + 1).map(row => row.key));
    else { selection.toggle(key); anchor.current = element; }
  };
  const toolbar = <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2 rounded-lg bg-muted/30 px-4 py-2" role="group" aria-label={t("project_browser.selection_actions")}>
        <Checkbox aria-label={t("project_browser.select_visible_files")} disabled={!visible.length} checked={visible.length > 0 && selection.ids.length === visible.length} indeterminate={selection.ids.length > 0 && selection.ids.length < visible.length} onCheckedChange={checked => checked ? selection.all() : selection.clear()} />
        <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{selection.ids.length ? t("project_browser.selected_count", { count: selection.ids.length }) : t("project_browser.select_files")}</span>
        {!!items.length && <>
          <Button size="sm" variant="ghost" onClick={() => { items.forEach(item => item.source ? requestPanelTab(projectFileTab(item.source), { kind: "workspace", workspaceId: scope }) : item.open()); selection.clear(); }}><FolderOpen className="size-3.5" />{t("project_browser.open_selected")}</Button>
          <Button size="sm" variant="ghost" onClick={() => items.forEach(item => { if (item.pin && pins.some(pin => filePinKey(pin) === filePinKey(item.pin!)) === allPinned) toggleFilePin(item.pin); })}><Pin className="size-3.5" />{t(allPinned ? "project_browser.unpin_selected" : "project_browser.pin_selected")}</Button>
          <Button size="sm" variant="outline" disabled={!canTransfer} onClick={() => setTransfer({ sources, mode: "copy" })}><Copy className="size-3.5" />{t("project_files.copy_to_project")}</Button>
          <Button size="sm" variant="outline" disabled={!canTransfer} onClick={() => setTransfer({ sources, mode: "link" })}><Link2 className="size-3.5" />{t("project_files.link_to_project")}</Button>
          <Button size="icon-sm" variant="ghost" aria-label={t("project_browser.clear_selection")} onClick={selection.clear}><X className="size-4" /></Button>
        </>}
      </div>;
  return <FileSelectionContext value={{ scope, ids: selection.ids, items, register, toggle }}>
    <div className="flex h-full min-h-0 flex-col" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) selection.clear(); }}>
      {children(toolbar)}
    </div>
    {transfer && <ProjectFileTransfer sources={transfer.sources} initialMode={transfer.mode} folder="" onClose={() => setTransfer(null)} />}
  </FileSelectionContext>;
}

export function useFileSelectionItem(item: FileSelectionItem | null) {
  const selection = use(FileSelectionContext);
  const current = useRef(item);
  current.current = item;
  const element = useRef<HTMLDivElement>(null);
  const register = selection?.register;
  const key = item?.key;
  useLayoutEffect(() => key && register ? register({ key, element, current }) : undefined, [key, register]);
  return { selection, element, selected: Boolean(key && selection?.ids.includes(key)) };
}
