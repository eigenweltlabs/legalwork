import { DashboardIcon } from "@/react-app/design-system/dashboard-icon";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, ChevronsDownUp, Copy, Download, FilePlus2, FileText, Folder, FolderInput, FolderOpen, FolderPlus, GitFork, History, Link, Loader2, Pencil, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FileBrowserRow } from "@/react-app/design-system/file-browser-row";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { ArtifactIcon } from "../session/artifacts/artifact-icon";
import { classifyOpenTarget } from "../session/artifacts/open-target";
import { t } from "@/i18n";
import { isWindowsPlatform } from "@/app/utils";
import { wikiFileLabel, wikiTree, wikiFolderEmpty, type WikiTreeEntry, type WikiTreeNode } from "./wiki-tree";
import { wikiDroppedFiles, type WikiImportFile } from "./wiki-file-import";
import { toast } from "@/components/ui/sonner";
import { hasProjectFileDrag, readProjectFilesDrag } from "@/app/lib/project-file-drag";
import { useProjectFiles } from "../workspace/project-file-context";

export type WikiExplorerAction = "rename" | "move" | "copy" | "trash" | "history" | "download" | "copy-path" | "copy-link" | "edit" | "reveal";

export function WikiExplorerButton(props: { label: string; disabled?: boolean; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return <Tooltip><TooltipTrigger render={<Button size="icon-sm" variant="ghost" className="wiki-icon-button" aria-label={props.label} aria-pressed={props.pressed} disabled={props.disabled} onClick={props.onClick} />}>{props.children}</TooltipTrigger><TooltipContent>{props.label}</TooltipContent></Tooltip>;
}

export function WikiExplorer(props: {
  stateKey?: string;
  pageTitles?: Record<string, string>;
  viewFiles?: Record<string, { title: string; mode: "report" | "dashboard" }>;
  files: string[]; folders: string[]; searchFiles: string[]; active: string; writable: boolean; busy: boolean; revealable: boolean;
  search: string; searching: boolean; onSearch: (value: string) => void;
  onOpen: (path: string) => void; onNewPage: (folder: string) => void; onNewFolder: (folder: string) => void;
  onGraph: () => void; onAction: (entry: WikiTreeEntry, action: WikiExplorerAction) => void; children?: ReactNode;
  onImport: (files: WikiImportFile[], folder: string) => Promise<void>;
  onDragFile?: (data: DataTransfer, path: string) => void;
}) {
  const projectFiles = useProjectFiles();
  const acceptsDrop = (data: DataTransfer) => Array.from(data.types).includes("Files") || Boolean(projectFiles && hasProjectFileDrag(data));
  const droppedFiles = async (data: DataTransfer): Promise<WikiImportFile[]> => {
    if (!projectFiles || !hasProjectFileDrag(data)) return wikiDroppedFiles(data);
    const sources = readProjectFilesDrag(data);
    const items: WikiImportFile[] = [];
    for (const source of sources) {
      const saved = await projectFiles.readSaved(source, true);
      items.push({ file: new File([saved.data], source.name), path: source.name });
    }
    return items;
  };
  const picker = useRef<HTMLInputElement>(null);
  const importActive = useRef(false);
  const [importing, setImporting] = useState(false);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [pickerFolder, setPickerFolder] = useState("");
  const importFiles = async (source: () => Promise<WikiImportFile[]>, folder: string) => {
    if (importActive.current || !props.writable || props.busy) return;
    importActive.current = true;
    setImporting(true);
    try {
      await props.onImport(await source(), folder);
      if (folder) setExpanded(current => new Set([...current, ...folder.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))]));
    } catch (error) { toast.error(t("wiki.operation_failed"), { description: error instanceof Error ? error.message : String(error) }); }
    finally { importActive.current = false; setImporting(false); }
  };
  const pickFiles = (folder: string) => { setPickerFolder(folder); picker.current?.click(); };
  const destinationFor = (target: EventTarget) => target instanceof Element ? target.closest<HTMLElement>("[data-wiki-folder]")?.dataset.wikiFolder ?? "" : "";
  const tree = useMemo(() => wikiTree(props.files, props.folders), [props.files, props.folders]);
  const [expanded, setExpanded] = useState(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`legalwork.wiki.tree.${props.stateKey}`) ?? "[]");
      return new Set(Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : []);
    } catch { return new Set<string>(); }
  });
  useEffect(() => {
    if (!props.stateKey) return;
    try { localStorage.setItem(`legalwork.wiki.tree.${props.stateKey}`, JSON.stringify([...expanded])); } catch { /* Navigation still works without persistence. */ }
  }, [expanded, props.stateKey]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    if (!props.active.includes("/")) return;
    const parts = props.active.split("/");
    setExpanded((current) => {
      const next = new Set(current);
      for (let index = 1; index < parts.length; index++) next.add(parts.slice(0, index).join("/"));
      return next;
    });
  }, [props.active]);
  const toggleFolder = (path: string) => setExpanded((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const menu = (entry: WikiTreeEntry, row: ReactNode) => <ContextMenu key={entry.path}>
    <ContextMenuTrigger render={<div className={cn("wiki-tree-target", dropFolder === entry.path && "rounded-md bg-primary/10 ring-1 ring-primary/40")} data-wiki-folder={entry.kind === "folder" ? entry.path : entry.path.split("/").slice(0, -1).join("/")} />} onContextMenu={(event) => event.stopPropagation()}>{row}</ContextMenuTrigger>
    <ContextMenuContent>
      {entry.kind === "folder" ? <>
        <ContextMenuItem onClick={() => toggleFolder(entry.path)}><Folder size={15} />{t(expanded.has(entry.path) ? "wiki.collapse_folder" : "wiki.expand_folder")}</ContextMenuItem>
        <ContextMenuItem disabled={!props.writable || props.busy} onClick={() => props.onNewPage(entry.path)}><FilePlus2 size={15} />{t("wiki.new_page")}</ContextMenuItem>
        <ContextMenuItem disabled={!props.writable || props.busy} onClick={() => { setExpanded((current) => new Set([...current, entry.path])); props.onNewFolder(entry.path); }}><FolderPlus size={15} />{t("wiki.new_folder")}</ContextMenuItem>
        <ContextMenuItem disabled={!props.writable || props.busy || importing} onClick={() => pickFiles(entry.path)}><Upload size={15} />{t("wiki.import_files")}</ContextMenuItem>
      </> : <>
        <ContextMenuItem onClick={() => props.onOpen(entry.path)}><FileText size={15} />{t("wiki.open_file")}</ContextMenuItem>
        {/\.md$/i.test(entry.path) ? <ContextMenuItem onClick={() => props.onAction(entry, "edit")}><Pencil size={15} />{t("wiki.edit_markdown")}</ContextMenuItem> : null}
      </>}
      {props.revealable ? <ContextMenuItem onClick={() => props.onAction(entry, "reveal")}><FolderOpen size={15} />{t(isWindowsPlatform() ? "workspace_list.reveal_explorer" : "workspace_list.reveal_finder")}</ContextMenuItem> : null}
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!props.writable || props.busy} onClick={() => props.onAction(entry, "rename")}><Pencil size={15} />{t("wiki.rename")}</ContextMenuItem>
      <ContextMenuItem disabled={!props.writable || props.busy} onClick={() => props.onAction(entry, "move")}><FolderInput size={15} />{t("wiki.move")}</ContextMenuItem>
      <ContextMenuItem disabled={!props.writable || props.busy} onClick={() => props.onAction(entry, "copy")}><Copy size={15} />{t("wiki.duplicate")}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => props.onAction(entry, "copy-path")}><Copy size={15} />{t("wiki.copy_path")}</ContextMenuItem>
      {entry.kind === "file" ? <>
        <ContextMenuItem onClick={() => props.onAction(entry, "copy-link")}><Link size={15} />{t("wiki.copy_link")}</ContextMenuItem>
        {/\.md$/i.test(entry.path) ? <ContextMenuItem onClick={() => props.onAction(entry, "history")}><History size={15} />{t("wiki.history")}</ContextMenuItem> : null}
        <ContextMenuItem onClick={() => props.onAction(entry, "download")}><Download size={15} />{t("wiki.download_file")}</ContextMenuItem>
      </> : null}
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" disabled={!props.writable || props.busy} onClick={() => props.onAction(entry, "trash")}><Trash2 size={15} />{t("wiki.move_to_trash")}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
  const file = (entry: WikiTreeEntry, depth: number, name: string) => menu(entry, <FileBrowserRow draggable={Boolean(props.onDragFile)} onDragStart={event => props.onDragFile?.(event.dataTransfer, entry.path)} selected={props.active === entry.path} style={{ paddingLeft: 6 + depth * 15 }} aria-current={props.active === entry.path ? "page" : undefined} title={props.viewFiles?.[entry.path] ? `${props.viewFiles[entry.path].mode === "dashboard" ? "Dashboard" : "Report"} · ${entry.path}` : entry.path} onClick={() => props.onOpen(entry.path)} leading={<span className="size-3.5 shrink-0" />} icon={props.viewFiles?.[entry.path]?.mode === "dashboard" ? <span className="flex size-5 items-center justify-center"><DashboardIcon className="text-muted-foreground" /></span> : <ArtifactIcon type={classifyOpenTarget(entry.path, "file")} className="size-5" />}>{wikiFileLabel(entry.path, props.viewFiles?.[entry.path]?.title ?? props.pageTitles?.[entry.path] ?? name)}{props.viewFiles?.[entry.path] && <span className="ml-auto pl-2 text-[10px] text-muted-foreground">{props.viewFiles[entry.path].mode === "dashboard" ? "Dashboard" : "Report"}</span>}</FileBrowserRow>);
  let shown = 0;
  let total = 0;
  const rows: ReactNode[] = [];
  const visit = (nodes: WikiTreeNode[], depth: number) => {
    for (const node of nodes) {
      total++;
      if (shown < limit) {
        shown++;
        if (node.kind === "file") rows.push(file(node, depth, node.name));
        else rows.push(menu(node, <FileBrowserRow muted={wikiFolderEmpty(node)} style={{ paddingLeft: 6 + depth * 15 }} aria-expanded={expanded.has(node.path)} title={node.path} onClick={() => toggleFolder(node.path)} leading={<ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded.has(node.path) && "rotate-90")} />} icon={<FolderIcon dashboard={node.path === "Dashboards"} open={expanded.has(node.path)} empty={wikiFolderEmpty(node)} />}>{node.name}</FileBrowserRow>));
      }
      if (node.kind === "folder" && expanded.has(node.path)) visit(node.children, depth + 1);
    }
  };
  if (!props.searching) visit(tree, 0);
  return <div className="relative flex min-h-0 flex-1 flex-col" data-workspace-file-intake="wiki" aria-busy={importing}
    onDragOver={event => {
      if (!acceptsDrop(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation();
      const allowed = props.writable && !props.busy && !importing;
      event.dataTransfer.dropEffect = allowed ? "copy" : "none";
      setDropFolder(allowed ? destinationFor(event.target) : null);
    }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropFolder(null); }}
    onDragEnd={() => setDropFolder(null)}
    onDrop={event => {
      if (!acceptsDrop(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); setDropFolder(null);
      if (props.writable && !props.busy && !importing) void importFiles(() => droppedFiles(event.dataTransfer), destinationFor(event.target));
    }}>
    <input ref={picker} type="file" multiple hidden onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []).map(file => ({ file, path: file.name }));
      event.currentTarget.value = "";
      if (files.length) void importFiles(() => Promise.resolve(files), pickerFolder);
    }} />
    <div className="flex h-(--lw-panel-toolbar-height) shrink-0 items-center justify-end gap-0.5 border-b border-border/70 bg-background/80 px-2 backdrop-blur-xl" role="toolbar" aria-label={t("wiki.file_actions")}>
      <WikiExplorerButton label={t("wiki.new_page")} disabled={!props.writable || props.busy} onClick={() => props.onNewPage("")}><FilePlus2 size={16} /></WikiExplorerButton>
      <WikiExplorerButton label={t("wiki.new_folder")} disabled={!props.writable || props.busy} onClick={() => props.onNewFolder("")}><FolderPlus size={16} /></WikiExplorerButton>
      <WikiExplorerButton label={t("wiki.import_files")} disabled={!props.writable || props.busy || importing} onClick={() => pickFiles("")}><Upload size={16} /></WikiExplorerButton>
      <WikiExplorerButton label={t("wiki.search")} pressed={searchOpen} onClick={() => { setSearchOpen((open) => !open); props.onSearch(""); }}><Search size={16} /></WikiExplorerButton>
      <WikiExplorerButton label={t("wiki.graph")} onClick={props.onGraph}><GitFork size={16} /></WikiExplorerButton>
      <WikiExplorerButton label={t("wiki.collapse_all")} onClick={() => setExpanded(new Set())}><ChevronsDownUp size={16} /></WikiExplorerButton>
    </div>
    {searchOpen ? <div className="wiki-explorer-search"><Input autoFocus aria-label={t("wiki.search")} placeholder={t("wiki.search")} value={props.search} onChange={(event) => { setLimit(100); props.onSearch(event.target.value); }} onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); props.onSearch(""); } }} /><WikiExplorerButton label={t("wiki.clear_search")} onClick={() => { setSearchOpen(false); props.onSearch(""); }}><X size={14} /></WikiExplorerButton></div> : null}
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <nav aria-label={t("wiki.files")} className="wiki-explorer-tree">{props.searching ? props.searchFiles.slice(0, limit).map((path) => file({ path, kind: "file" }, 0, path.replace(/\.md$/i, ""))) : rows}
        {(props.searching ? props.searchFiles.length : total) > limit ? <Button variant="ghost" size="sm" className="w-full" onClick={() => setLimit((current) => current + 100)}>{t("wiki.show_more", { remaining: (props.searching ? props.searchFiles.length : total) - limit })}</Button> : null}
      </nav>
      {props.children}
    </div>
    {dropFolder !== null ? <div className="pointer-events-none absolute inset-x-2 bottom-2 z-40 flex items-center gap-2 rounded-lg border border-primary/40 bg-background/95 p-3 text-sm shadow-sm"><FolderInput className="size-4 shrink-0" /><span className="min-w-0 break-words">{dropFolder ? t("wiki.drop_in_folder", { folder: dropFolder }) : t("wiki.drop_files")}</span></div> : null}
    {importing ? <div role="status" className="pointer-events-none absolute inset-x-2 bottom-2 z-40 flex items-center gap-2 rounded-lg border bg-background p-3 text-sm shadow-sm"><Loader2 className="size-4 animate-spin" />{t("wiki.importing_files")}</div> : null}
  </div>;
}
