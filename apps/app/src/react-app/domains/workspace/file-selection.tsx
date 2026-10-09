import { createContext, use, useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Copy, FolderOpen, Link2, Pin, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { operateWorkspaceFile, type WorkspaceFile } from "./workspace-file-operation";
import type { ProjectFileSource } from "@legalwork/types/project-files";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/i18n";
import { filePinKey, toggleFilePin, useFilePins, type FilePin } from "../session/panel/file-pins";
import { ProjectFileTransfer } from "./project-file-transfer";
import { useListSelection } from "./use-list-selection";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { projectFileTab } from "./project-file-tab";
import { fileSelectionCatalogue, fileSelectionRange } from "./file-selection-catalogue";

export type FileSelectionItem = { key: string; name: string; source?: ProjectFileSource; pin?: FilePin; file?: WorkspaceFile; open: () => void };
type RegisteredFile = { key: string; element: React.RefObject<HTMLDivElement | null>; current: React.RefObject<FileSelectionItem | null> };
const FileSelectionContext = createContext<{
  scope: string;
  ids: string[]; items: FileSelectionItem[];
  register: (entry: RegisteredFile) => () => void;
  registerCollection: (id: string, items: FileSelectionItem[]) => () => void;
  toggle: (key: string, range: boolean, element: HTMLDivElement | null) => void;
} | null>(null);
export function useHasFileSelection() { return use(FileSelectionContext) !== null; }

export function FileSelectionProvider({ children, scope, compact = false }: { children: (toolbar: ReactNode) => ReactNode; scope: string; compact?: boolean }) {
  const requestPanelTab = useRequestPanelTab({ kind: "workspace", workspaceId: scope });
  const queries = useQueryClient();
  const [deleting, setDeleting] = useState<FileSelectionItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  const [rows, setRows] = useState<RegisteredFile[]>([]);
  const [collections, setCollections] = useState<Record<string, FileSelectionItem[]>>({});
  const registerCollection = useCallback((id: string, items: FileSelectionItem[]) => {
    setCollections(current => ({ ...current, [id]: items }));
    return () => setCollections(current => { const next = { ...current }; delete next[id]; return next; });
  }, []);
  const register = useCallback((entry: RegisteredFile) => {
    setRows(current => [...current, entry]);
    return () => setRows(current => current.filter(row => row !== entry));
  }, []);
  // Virtual rows only describe mounted DOM. Their complete logical list owns
  // selection, so scrolling cannot delete a selection or truncate Select all.
  const catalogue = fileSelectionCatalogue(Object.values(collections), rows.flatMap(row => row.current.current ? [row.current.current] : []));
  const visible = [...catalogue.keys()];
  const selection = useListSelection(visible, scope);
  const anchor = useRef<string | null>(null);
  const items = selection.ids.flatMap(id => {
    const item = catalogue.get(id);
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
    const selectedRange = range ? fileSelectionRange(Object.values(collections), ordered.map(row => row.key), anchor.current, key) : null;
    if (selectedRange) selection.add(selectedRange);
    else { selection.toggle(key); anchor.current = key; }
  };
  const toolbar = <div className={compact ? "flex shrink-0 flex-wrap items-center gap-1 border-b border-border/70 px-2 py-1" : "mb-4 flex shrink-0 flex-wrap items-center gap-2 rounded-lg bg-muted/30 px-4 py-2"} role="group" aria-label={t("project_browser.selection_actions")}>
        <Checkbox aria-label={t("project_browser.select_visible_files")} disabled={!visible.length} checked={visible.length > 0 && selection.ids.length === visible.length} indeterminate={selection.ids.length > 0 && selection.ids.length < visible.length} onCheckedChange={checked => checked ? selection.all() : selection.clear()} />
        {selection.ids.length ? <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{t("project_browser.selected_count", { count: selection.ids.length })}</span> : <Button variant="ghost" size="sm" className="mr-auto px-1 text-xs text-muted-foreground" disabled={!visible.length} onClick={selection.all}>{t("project_browser.select_files")}</Button>}
        {!!items.length && <>
          <Button size={compact ? "icon-sm" : "sm"} aria-label={t("project_browser.open_selected")} title={t("project_browser.open_selected")} variant="ghost" onClick={() => { items.forEach(item => item.source ? requestPanelTab(projectFileTab(item.source)) : item.open()); selection.clear(); }}><FolderOpen className="size-3.5" />{!compact && t("project_browser.open_selected")}</Button>
          <Button size={compact ? "icon-sm" : "sm"} aria-label={t(allPinned ? "project_browser.unpin_selected" : "project_browser.pin_selected")} title={t(allPinned ? "project_browser.unpin_selected" : "project_browser.pin_selected")} variant="ghost" onClick={() => items.forEach(item => { if (item.pin && pins.some(pin => filePinKey(pin) === filePinKey(item.pin!)) === allPinned) toggleFilePin(item.pin); })}><Pin className="size-3.5" />{!compact && t(allPinned ? "project_browser.unpin_selected" : "project_browser.pin_selected")}</Button>
          <Button size={compact ? "icon-sm" : "sm"} aria-label={t("project_files.copy_to_project")} title={t("project_files.copy_to_project")} variant="ghost" disabled={!canTransfer} onClick={() => setTransfer({ sources, mode: "copy" })}><Copy className="size-3.5" />{!compact && t("project_files.copy_to_project")}</Button>
          <Button size={compact ? "icon-sm" : "sm"} aria-label={t("project_files.link_to_project")} title={t("project_files.link_to_project")} variant="ghost" disabled={!canTransfer} onClick={() => setTransfer({ sources, mode: "link" })}><Link2 className="size-3.5" />{!compact && t("project_files.link_to_project")}</Button>
          <Button size={compact ? "icon-sm" : "sm"} aria-label={t("project_browser.delete_selected")} title={t("project_browser.delete_selected")} variant="ghost" className="text-destructive" disabled={busy || items.some(item => !item.file)} onClick={() => { setDeleting(items); setDeleteErrors([]); }}><Trash2 className="size-3.5" />{!compact && t("project_browser.delete_selected")}</Button>
          <Button size="icon-sm" variant="ghost" aria-label={t("project_browser.clear_selection")} onClick={selection.clear}><X className="size-4" /></Button>
        </>}
      </div>;
  return <FileSelectionContext value={{ scope, ids: selection.ids, items, register, registerCollection, toggle }}>
    <div className="flex h-full min-h-0 flex-col" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) selection.clear(); }}>
      {children(toolbar)}
    </div>
    {transfer && <ProjectFileTransfer sources={transfer.sources} initialMode={transfer.mode} folder="" onClose={() => setTransfer(null)} />}
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{t("project_browser.delete_selected")}</DialogTitle><DialogDescription>{t("project_browser.delete_selected_confirm", { count: deleting?.length ?? 0 })}</DialogDescription></DialogHeader>
      <ul className="max-h-48 overflow-auto text-sm">{deleting?.map(item => <li key={item.key} className="truncate">{item.name}</li>)}</ul>
      {deleteErrors.length > 0 && <div role="alert" className="max-h-32 overflow-auto text-sm text-destructive">{deleteErrors.map(error => <p key={error}>{error}</p>)}</div>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>{t("common.cancel")}</Button><Button variant="destructive" disabled={busy || !deleting?.length} onClick={() => {
        if (!deleting || busy) return;
        setBusy(true); setDeleteErrors([]);
        void (async () => {
          const failed: FileSelectionItem[] = [], errors: string[] = [];
          for (const item of deleting) {
            if (!item.file) continue;
            try { await operateWorkspaceFile(item.file, { type: "delete", path: item.file.path, recursive: false }, queries); }
            catch (error) { failed.push(item); errors.push(`${item.name}: ${error instanceof Error ? error.message : t("storage.failed")}`); }
          }
          setDeleting(failed.length ? failed : null); setDeleteErrors(errors);
          if (!failed.length) selection.clear();
        })().finally(() => setBusy(false));
      }}>{t("project_browser.delete_selected")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </FileSelectionContext>;
}

/** Supply every loaded row before virtualization, including rows outside the viewport. */
export function useFileSelectionCollection(items: FileSelectionItem[]) {
  const register = use(FileSelectionContext)?.registerCollection;
  const id = useId();
  useLayoutEffect(() => register?.(id, items), [id, items, register]);
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
