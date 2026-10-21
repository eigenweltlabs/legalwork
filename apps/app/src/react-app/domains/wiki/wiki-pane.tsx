import { downloadViewFile } from "../views/view-file";
import { ViewRenameDialog } from "../views/view-rename-dialog";
import type { ViewSummary } from "@legalwork/types/views";
import { WikiContributions } from "./wiki-contributions";
import { WikiChatHistory, type WikiChatHistoryProps } from "./wiki-chat-history";
import { writeWikiFileDrag } from "@/app/lib/wiki-file-drag";
import { FILE_SIDEBAR_DRAG_TYPE } from "../session/panel/file-drop-intent";
import { ViewHostProvider } from "../views/view-host";
import { ViewList, useSavedViews } from "../views/view-list";
import { parseViewReference, viewPanelTab } from "../views/view-reference";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, BookOpen, Check, ChevronDown, History, Loader2, LockKeyhole, Plus, RefreshCw, Settings2, Users, X } from "lucide-react";
import type { WikiAsset, WikiEntryOperation, WikiPage, WikiSnapshot, WikiVault } from "@legalwork/types/wiki";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { isLoopbackLegalworkServerUrl, LegalworkServerError } from "@/app/lib/legalwork-server";
import { isDesktopRuntime } from "@/app/utils";
import { joinDesktopPath, openDesktopUrl, revealDesktopItemInDir } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { PanelHeader } from "@/react-app/design-system/panel-chrome";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { CreateWikiDialog, NewWikiPageDialog, WikiHistoryDialog, WikiSettingsDialog, wikiError, type WikiWorkspaceOption } from "./wiki-dialogs";
import { resolveWikiLink, wikiBacklinks, wikiTemplateContent } from "./wiki-model";
import { useWikiDrafts } from "./wiki-drafts";
import { WikiPreview } from "./wiki-preview";
import { WikiGraphPane } from "./wiki-graph-pane";
import { wikiPanelTab, type WikiPanelTab } from "./wiki-tabs";
import { usePanelTabStore, workspacePanelKey } from "../session/panel/panel-tab-store";
import { wikiWorkspaceRoute } from "../../shell/workspace-routes";
import { WikiExplorer, type WikiExplorerAction } from "./wiki-explorer";
import { wikiCopyPath, type WikiTreeEntry } from "./wiki-tree";
import { WikiFileDialog, type WikiFileDialogAction } from "./wiki-file-dialogs";
import { WikiAssetPane } from "./wiki-asset-pane";
import { importWikiFiles, type WikiImportFile } from "./wiki-file-import";
import { WikiPageHeader } from "./wiki-page-header";
import "./wiki.css";

const MarkdownEditor = lazy(() => import("./wiki-markdown-editor").then((module) => ({ default: module.WikiMarkdownEditor })));
const EMPTY_PAGES: WikiPage[] = [];
const EMPTY_ASSETS: WikiAsset[] = [];

export type WikiPaneProps = {
  chatHistory?: WikiChatHistoryProps;
  client: LegalworkServerClient | null;
  serverUrl: string;
  workspaceId: string;
  workspaces: WikiWorkspaceOption[];
  onWikisChanged?: () => void;
  onOpenWikiSession: (wiki: WikiVault, prompt?: string) => Promise<void>;
  onOpenWiki: (wiki: WikiVault) => void;
  display?: "navigation" | "tab";
  tab?: WikiPanelTab;
  headerTarget?: HTMLElement | null;
  selectedWikiId?: string;
  onSelectWiki?: (wiki: WikiVault) => void;
  onManageWikis?: () => void;
  hideHeader?: boolean;
  onCloseNavigation?: () => void;
  onCloseTab?: () => void;
};

/** The folder is the wiki. The app renders its Markdown without imposing a hierarchy. */
export function WikiPane(props: WikiPaneProps) {
  if (props.display !== "navigation" && props.tab?.location.kind === "asset") return <WikiAssetPane client={props.client} serverUrl={props.serverUrl} tab={props.tab} workspaceId={props.workspaceId} onClose={() => props.onCloseTab?.()} />;
  return <WikiContentPane {...props} />;
}

function WikiContentPane(props: WikiPaneProps) {
  const requestPanelTab = useRequestPanelTab({ kind: "workspace", workspaceId: props.workspaceId });
  const navigationOnly = props.display === "navigation";
  const tabOnly = props.display === "tab";
  const queryClient = useQueryClient();
  const [wikiId, setWikiId] = useState(tabOnly ? props.tab?.wikiId ?? "" : props.selectedWikiId ?? props.tab?.wikiId ?? "");
  const [path, setPath] = useState((props.tab?.location.kind === "page" || props.tab?.location.kind === "asset") ? props.tab.location.path : props.tab?.location.kind === "graph" ? props.tab.location.focus ?? "" : "");
  const [pageAnchor, setPageAnchor] = useState(props.tab?.location.kind === "page" ? props.tab.location.anchor ?? "" : "");
  const [viewModeRequest, setViewModeRequest] = useState<{ mode: "source" | "rich-text" }>({ mode: props.tab?.location.kind === "page" && props.tab.location.mode === "source" ? "source" : "rich-text" });
  const [surface, setSurface] = useState(props.tab?.location.kind === "graph" ? "graph" : "page");
  const [renamingView, setRenamingView] = useState<ViewSummary | null>(null);
  const [fileDialog, setFileDialog] = useState<WikiFileDialogAction | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [newWiki, setNewWiki] = useState(false);
  const [newPage, setNewPage] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "sharing" | "agents">("general");
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [history, setHistory] = useState(false);
  const [historyPath, setHistoryPath] = useState("");
  const [documentLoading, setDocumentLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [sharingActionError, setSharingActionError] = useState<{ wikiId: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const workbenchBody = useRef<HTMLDivElement>(null);
  const editorRegion = useRef<HTMLDivElement>(null);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const assetUrls = useRef(new Map<string, string>());
  const wikiKey = ["wikis", props.serverUrl];
  const snapshotKey = ["wiki-snapshot", props.serverUrl, wikiId];
  const list = useQuery({ queryKey: wikiKey, queryFn: async () => {
    if (!props.client) throw new Error(t("wiki.offline"));
    return props.client.listWikis();
  }, enabled: Boolean(props.client) });
  const snapshot = useQuery({ queryKey: snapshotKey, queryFn: async () => {
    if (!props.client) throw new Error(t("wiki.offline"));
    return props.client.wikiSnapshot(wikiId);
  }, enabled: Boolean(props.client && wikiId) });
  useQuery({ queryKey: ["wiki-revision", props.serverUrl, wikiId], queryFn: async () => {
    if (!props.client) throw new Error(t("wiki.offline"));
    const next = await props.client.wikiGraphRevision(wikiId);
    const previous = queryClient.getQueryData<{ revision: string }>(["wiki-revision", props.serverUrl, wikiId]);
    if (previous && previous.revision !== next.revision) {
      void queryClient.invalidateQueries({ queryKey: ["wiki-snapshot", props.serverUrl, wikiId] });
      void queryClient.invalidateQueries({ queryKey: ["wikis", props.serverUrl] });
      void queryClient.invalidateQueries({ queryKey: ["wiki-search", props.serverUrl, wikiId] });
      void queryClient.invalidateQueries({ queryKey: ["view-data", props.serverUrl, "wiki", wikiId] });
      void queryClient.invalidateQueries({ queryKey: ["ui-views", props.serverUrl, "wiki", wikiId] });
    }
    return next;
  }, enabled: Boolean(props.client && wikiId), refetchInterval: 2000 });
  const searchResult = useQuery({ queryKey: ["wiki-search", props.serverUrl, wikiId, debouncedSearch], queryFn: async () => {
    if (!props.client) throw new Error(t("wiki.offline"));
    return props.client.searchWiki(wikiId, debouncedSearch);
  }, enabled: Boolean(props.client && wikiId && debouncedSearch.trim()) });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["wiki-snapshot", props.serverUrl] });
    void queryClient.invalidateQueries({ queryKey: ["wikis", props.serverUrl] });
    void queryClient.invalidateQueries({ queryKey: ["wiki-search", props.serverUrl] });
    void queryClient.invalidateQueries({ queryKey: ["wiki-team", props.serverUrl] });
    void queryClient.invalidateQueries({ queryKey: ["wiki-trash", props.serverUrl] });
    void queryClient.invalidateQueries({ queryKey: ["view-data", props.serverUrl, "wiki", wikiId] });
  }, [queryClient, props.serverUrl, wikiId]);
  const acceptWiki = (updated: WikiVault) => {
    queryClient.setQueryData<WikiSnapshot>(["wiki-snapshot", props.serverUrl, updated.id], (current) => current ? { ...current, wiki: updated } : undefined);
    queryClient.setQueryData<{ items: WikiVault[] }>(["wikis", props.serverUrl], (current) => current ? { items: [...current.items.filter((item) => item.id !== updated.id), updated] } : { items: [updated] });
    refresh();
  };
  const wiki = snapshot.data?.wiki ?? list.data?.items.find((item) => item.id === wikiId);
  const inWikiWorkspace = wiki?.workspaceId === props.workspaceId;
  const writable = Boolean(inWikiWorkspace && wiki?.writable);
  const drafts = useWikiDrafts(props.client, props.serverUrl, refresh, writable ? wikiId : null);
  const pages = snapshot.data?.pages ?? EMPTY_PAGES;
  const assets = snapshot.data?.assets ?? EMPTY_ASSETS;
  const savedViews = useSavedViews(props.client, { kind: "wiki", id: wikiId });
  const viewFiles = useMemo(() => Object.fromEntries((savedViews.data?.items ?? []).map(view => [view.path ?? `Views/${view.id}.view.json`, { title: view.title, mode: view.mode }])), [savedViews.data?.items]);
  const currentPage = pages.find((page) => page.path === path);
  useEffect(() => {
    // Navigation can receive the previous workspace's active tab during a
    // switch. Only the matching document pane may rename its tab.
    if (!tabOnly || !props.tab || props.tab.location.kind !== "page" || props.tab.wikiId !== wikiId || props.tab.location.path !== path || !currentPage?.title) return;
    const store = usePanelTabStore.getState();
    for (const [scope, session] of Object.entries(store.sessions)) {
      if (session.tabs.some(tab => tab.id === props.tab?.id && tab.label !== currentPage.title)) store.updateTabLabel(scope, props.tab.id, currentPage.title);
    }
  }, [tabOnly, props.tab, wikiId, path, currentPage?.title]);
  const draft = wikiId && path ? drafts.get(wikiId, path) : undefined;
  const backlinks = useMemo(() => wikiBacklinks(pages, path), [pages, path]);
  const linkTargets = useMemo(() => [...pages.map(page => ({ path: page.path, title: page.title })), ...assets.map(asset => ({ path: asset.path, title: asset.path.split("/").at(-1) ?? asset.path }))], [pages, assets]);
  const pageTitles = useMemo(() => Object.fromEntries(pages.map(page => [page.path, page.title])), [pages]);
  const files = useMemo(() => [...pages.map((page) => page.path), ...assets.map((asset) => asset.path)], [pages, assets]);
  const folders = useMemo(() => [...new Set([...(snapshot.data?.folders ?? []), ...files.flatMap((path) => { const parts = path.split("/"); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/")); })])].filter(folder => !(folder === "Views" || folder.startsWith("Views/")) || files.some(file => file.startsWith(`${folder}/`))).sort(), [snapshot.data?.folders, files]);
  const searchFiles = useMemo(() => [...new Set([...(searchResult.data?.items.map((page) => page.path) ?? []), ...files.filter((path) => path.toLowerCase().includes(debouncedSearch.trim().toLowerCase()))])], [searchResult.data, files, debouncedSearch]);
  const sharingError = sharingActionError?.wikiId === wikiId ? sharingActionError.message : wiki?.pendingSharing ? wiki.syncStatus.error ?? t("wiki.sharing_pending") : null;

  useEffect(() => {
    if (props.selectedWikiId && navigationOnly) setWikiId(props.selectedWikiId);
  }, [props.selectedWikiId, navigationOnly]);
  useEffect(() => {
    if (!props.tab || navigationOnly && props.selectedWikiId && props.tab.wikiId !== props.selectedWikiId) return;
    const { wikiId, location } = props.tab;
    setWikiId(wikiId);
    setSurface(location.kind === "graph" ? "graph" : "page");
    setPath((location.kind === "page" || location.kind === "asset") ? location.path : location.kind === "graph" ? location.focus ?? "" : "");
    setPageAnchor(location.kind === "page" ? location.anchor ?? "" : "");
    if (location.kind === "page" && location.mode === "source") setViewModeRequest({ mode: "source" });
    setPageError(null);
  }, [props.tab, navigationOnly, props.selectedWikiId]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!tabOnly && !props.onSelectWiki && !wikiId && list.data?.items.length) setWikiId(list.data.items[0].id);
  }, [wikiId, list.data, tabOnly, props.onSelectWiki]);
  useEffect(() => {
    if (!navigationOnly && !tabOnly && !path && pages.length) setPath(pages.find((page) => /^(Wiki|Home|Index|README)\.md$/i.test(page.path))?.path ?? pages[0].path);
  }, [pages, path, navigationOnly, tabOnly]);
  useEffect(() => {
    if (navigationOnly || surface !== "page" || !wikiId || !path) return;
    let cancelled = false;
    setDocumentLoading(true); setPageError(null);
    void drafts.load(wikiId, path).catch((err) => { if (!cancelled) setPageError(wikiError(err)); }).finally(() => { if (!cancelled) setDocumentLoading(false); });
    return () => { cancelled = true; };
  }, [wikiId, path, currentPage?.revision, drafts.load, navigationOnly, surface]);
  useEffect(() => () => { for (const url of assetUrls.current.values()) URL.revokeObjectURL(url); assetUrls.current.clear(); }, []);

  useEffect(() => {
    const body = workbenchBody.current;
    if (!body || navigationOnly || tabOnly) return;
    const observer = new ResizeObserver(() => { if (body.clientWidth <= 680) setNavigationOpen(false); });
    observer.observe(body);
    return () => observer.disconnect();
  }, [wikiId, navigationOnly, tabOnly]);

  const closeNarrowNavigation = () => { if (workbenchBody.current && workbenchBody.current.clientWidth <= 680) setNavigationOpen(false); };
  const openGraph = () => {
    if (navigationOnly || tabOnly) {
      if (navigationOnly) setSurface("graph");
      requestPanelTab(wikiPanelTab(props.serverUrl, wikiId, { kind: "graph", focus: !navigationOnly && path ? path : undefined }, t("wiki.graph")));
      return;
    }
    setSurface("graph"); closeNarrowNavigation();
  };
  const openPage = (nextPath: string, anchor = "", nextMode?: "source") => {
    if (navigationOnly || tabOnly) {
      if (!nextPath) { if (tabOnly) props.onCloseTab?.(); return; }
      if (navigationOnly) { setPath(nextPath); setSurface("page"); }
      requestPanelTab(wikiPanelTab(props.serverUrl, wikiId, { kind: "page", path: nextPath, anchor, mode: nextMode }, pages.find((page) => page.path === nextPath)?.title ?? nextPath.split("/").at(-1)?.replace(/\.md$/i, "") ?? nextPath));
      return;
    }
    closeNarrowNavigation(); setPath(nextPath); setPageAnchor(anchor); setSurface("page"); setPageError(null);
    setViewModeRequest({ mode: nextMode ?? "rich-text" });
  };
  const chooseWiki = (id: string, selected?: WikiVault) => {
    const next = selected ?? list.data?.items.find(item => item.id === id);
    if (next && props.onSelectWiki) { props.onSelectWiki(next); return; } setWikiId(id); setPath(""); setPageAnchor(""); setSurface("page"); setSearch(""); setDebouncedSearch(""); setPageError(null); };
  const openSettings = (tab: "general" | "sharing" | "agents" = "general") => { setSettingsTab(tab); setSettings(true); };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try { await operation(); }
    catch (error) { toast.error(t("wiki.operation_failed"), { description: wikiError(error) }); }
    finally { setBusy(false); }
  };
  const importFiles = async (items: WikiImportFile[], folder: string) => {
    if (!props.client || !wiki || !writable) return;
    setBusy(true);
    try {
      const result = await importWikiFiles(props.client, wiki.id, folder, items, [...files, ...folders]);
      if (result.saved.length) { refresh(); toast.success(t("wiki.files_imported", { count: result.saved.length })); }
      if (result.errors.length) toast.error(t("wiki.import_failed"), { description: result.errors.join("\n") });
    } finally { setBusy(false); }
  };
  const resolveAssetPath = useCallback((source: string) => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(source)) throw new Error(t("wiki.invalid_asset"));
    let decoded: string;
    try { decoded = decodeURIComponent(source.split("#")[0]); } catch { throw new Error(t("wiki.invalid_asset")); }
    if (assets.some((asset) => asset.path === decoded) || pages.some((page) => page.path === decoded)) return decoded;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const parts: string[] = [];
    for (const part of `${parent ? `${parent}/` : ""}${decoded}`.split("/")) {
      if (part === "..") { if (!parts.length) throw new Error(t("wiki.invalid_asset")); parts.pop(); }
      else if (part !== "." && part) parts.push(part);
    }
    return parts.join("/");
  }, [path, assets, pages]);
  const imagePreview = useCallback(async (source: string) => {
    if (!props.client || !wikiId) throw new Error(t("wiki.offline"));
    const assetPath = resolveAssetPath(source);
    const asset = assets.find((item) => item.path === assetPath);
    const key = `${wikiId}:${assetPath}:${asset?.updatedAt}`;
    const previous = assetUrls.current.get(key); if (previous) return previous;
    const result = await props.client.downloadWikiAsset(wikiId, assetPath);
    // Never embed SVG/HTML in the privileged app document.
    if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(result.contentType ?? "")) throw new Error(t("wiki.invalid_image"));
    const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
    assetUrls.current.set(key, url); return url;
  }, [props.client, wikiId, resolveAssetPath, assets]);
  const uploadAsset = useCallback(async (file: File) => {
    if (!props.client || !wiki) throw new Error(t("wiki.offline"));
    if (!writable) throw new Error(t("wiki.read_only"));
    const name = file.name.replace(/[\\/<>:"|?*%#\x00-\x1f]/g, "_").replace(/^\.+/, "");
    const target = `Attachments/${crypto.randomUUID().slice(0, 8)}-${name || "file"}`;
    const result = await props.client.uploadWikiAsset(wiki.id, target, await file.arrayBuffer());
    refresh(); return result.path;
  }, [props.client, wiki, refresh, writable]);
  const uploadImage = useCallback(async (file: File) => (await uploadAsset(file)).split("/").map(encodeURIComponent).join("/"), [uploadAsset]);
  const downloadAsset = async (source: string) => {
    if (!props.client || !wiki) return;
    const assetPath = resolveAssetPath(source);
    const view = savedViews.data?.items.find(view => view.path === assetPath);
    if (view) return downloadViewFile(props.client, view);
    const result = await props.client.downloadWikiAsset(wiki.id, assetPath);
    const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = assetPath.split("/").at(-1) ?? "attachment";
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const openAsset = async (source: string) => {
    if (!props.client || !wiki) return;
    const assetPath = resolveAssetPath(source);
    const saved = savedViews.data?.items.find(view => (view.path ?? `Views/${view.id}.view.json`) === assetPath);
    if (saved) { requestPanelTab(viewPanelTab(props.serverUrl, { owner: saved.owner, viewId: saved.id }, saved.title)); return; }
    requestPanelTab(wikiPanelTab(props.serverUrl, wiki.id, { kind: "asset", path: assetPath }, assetPath.split("/").at(-1) ?? assetPath));
  };
  const scrollToHeading = useCallback((anchor: string) => {
    const normalized = (value: string) => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    for (const heading of editorRegion.current?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? []) {
      if (heading.id === anchor || normalized(heading.textContent ?? "") === normalized(anchor)) { heading.scrollIntoView({ block: "start" }); break; }
    }
  }, []);
  useEffect(() => {
    if (!pageAnchor || !draft || documentLoading) return;
    const frame = window.requestAnimationFrame(() => scrollToHeading(pageAnchor));
    return () => window.cancelAnimationFrame(frame);
  }, [pageAnchor, path, wikiId, Boolean(draft), documentLoading, scrollToHeading]);
  const openEditorLink = (href: string) => {
    const view = parseViewReference(href);
    if (view) { requestPanelTab(viewPanelTab(props.serverUrl, view)); return; }
    if (/^https?:|^mailto:|^tel:/i.test(href)) { void openDesktopUrl(href); return; }
    let target: string;
    try { target = decodeURIComponent(href.replace(/^#?wiki:/, "").replace(/^\[\[|\]\]$/g, "").split("|")[0]); } catch { return; }
    if (target.startsWith("#")) { scrollToHeading(target.slice(1)); return; }
    const destination = resolveWikiLink(pages, files, target, path, /^#?wiki:/.test(href) || href.startsWith("[["));
    if (destination?.kind === "asset") { void run(() => openAsset(destination.path)); return; }
    if (destination) { openPage(destination.path, destination.anchor); if (destination.path === path && destination.anchor) scrollToHeading(destination.anchor); }
    else if (/^#?wiki:/.test(href) || href.startsWith("[[") || /\.md(?:#.*)?$/i.test(href)) {
      if (writable) setNewPage(target.split("#")[0]); else toast.error(t("wiki.missing_link"));
    } else void run(() => openAsset(target));
  };

  const changeEntry = async (operation: WikiEntryOperation) => {
    if (!props.client || !wiki) throw new Error(t("wiki.offline"));
    if (!writable) throw new Error(t("wiki.read_only"));
    if ("baseRevision" in operation) {
      if (drafts.dirty.some((draft) => draft.wikiId === wiki.id && (draft.path === operation.path || draft.path.startsWith(`${operation.path}/`)))) throw new Error(t("wiki.save_before_move"));
    }
    await props.client.changeWikiEntry(wiki.id, operation);
    if (operation.action === "move" || operation.action === "trash") {
      for (const page of pages) if (page.path === operation.path || page.path.startsWith(`${operation.path}/`)) drafts.remove(wiki.id, page.path);
      usePanelTabStore.getState().updateWikiPaths(props.serverUrl, wiki.id, operation.path, operation.action === "move" ? operation.destination : null);
      if (path === operation.path || path.startsWith(`${operation.path}/`)) setPath(operation.action === "move" ? operation.destination + path.slice(operation.path.length) : "");
    }
    refresh();
  };
  const entryAction = (entry: WikiTreeEntry, action: WikiExplorerAction) => {
    const view = savedViews.data?.items.find(view => view.path === entry.path);
    if (action === "rename" && view) { setRenamingView(view); return; }
    if (action === "edit") { openPage(entry.path, "", "source"); return; }
    if (action === "history") { setHistoryPath(entry.path); setHistory(true); return; }
    void run(async () => {
      if (action === "copy-path" || action === "copy-link") { await navigator.clipboard.writeText(action === "copy-link" ? `[[${entry.path}]]` : entry.path); toast.success(t("wiki.copied")); return; }
      if (action === "download") { await downloadAsset(entry.path); return; }
      if (!props.client || !wiki) throw new Error(t("wiki.offline"));
      if (action === "reveal") { if (isDesktopRuntime() && isLoopbackLegalworkServerUrl(props.serverUrl)) await revealDesktopItemInDir(await joinDesktopPath(wiki.root, ...entry.path.split("/"))); return; }
      const selected = await props.client.wikiEntry(wiki.id, entry.path);
      const name = entry.path.split("/").at(-1) ?? entry.path;
      const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
      setFileDialog({ action, entry: selected, value: action === "copy" ? wikiCopyPath(entry.path, [...files, ...folders]) : action === "rename" ? selected.kind === "file" ? name.replace(/\.md$/i, "") : name : parent });
    });
  };
  const wikiSelector = <span className="wiki-switcher-group"><DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" className="wiki-switcher" aria-label={t("wiki.select_wiki")} disabled={!props.client} />}>
      <FolderIcon shared={Boolean(wiki?.sync)} className="size-4" /><span>{wiki?.name ?? t("wiki.title")}</span><ChevronDown size={13} />
    </DropdownMenuTrigger>
    <DropdownMenuContent side="bottom" align="start" className="w-72 max-w-[calc(100vw-2rem)]">
      {list.data?.items.map((item) => <DropdownMenuItem key={item.id} onClick={() => chooseWiki(item.id)}>{item.sync ? <Users size={15} /> : <LockKeyhole size={15} />}<span className="min-w-0 flex-1 truncate">{item.name}</span>{wikiId === item.id ? <Check size={14} /> : null}</DropdownMenuItem>)}
      <DropdownMenuSeparator />{props.onManageWikis ? <DropdownMenuItem onClick={props.onManageWikis}><BookOpen size={15} />{t("wiki.manage_all")}</DropdownMenuItem> : null}<DropdownMenuItem onClick={() => setNewWiki(true)}><Plus size={15} />{t("wiki.new_wiki")}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>{wiki ? <span className="wiki-switcher-settings"><WikiIconButton label={t("wiki.settings")} onClick={() => openSettings()}><Settings2 size={15} /></WikiIconButton></span> : null}</span>;

  return <div className={cn("wiki-workbench", navigationOnly && "wiki-navigation-pane", tabOnly && "wiki-tab-pane")}>
    {navigationOnly && !props.hideHeader ? <PanelHeader title={t("wiki.title")} icon={<BookOpen size={16} />} headerTarget={props.headerTarget}>{props.onCloseNavigation ? <WikiIconButton label={t("workspace_files.close_panel")} onClick={props.onCloseNavigation}><X size={15} /></WikiIconButton> : null}</PanelHeader> : null}
    {!props.client || list.error || list.isLoading || !wikiId ? <>
      {!navigationOnly ? <header className="wiki-empty-header"><span><BookOpen size={18} />{t("wiki.title")}</span><Button size="sm" variant="outline" disabled={!props.client} onClick={() => setNewWiki(true)}><Plus size={15} />{t("wiki.new_wiki")}</Button></header> : null}
      {!props.client ? <EmptyWiki message={t("wiki.offline")} /> : list.error ? <EmptyWiki message={wikiError(list.error)} action={<Button variant="outline" onClick={() => void list.refetch()}>{t("wiki.retry")}</Button>} /> : list.isLoading ? <WikiLoading /> : <EmptyWiki title={t("wiki.empty_title")} message={t("wiki.empty_hint")} action={<Button onClick={() => setNewWiki(true)}><Plus size={16} />{t("wiki.new_wiki")}</Button>} />}
    </> : <>
      {sharingError ? <div role="alert" className="wiki-notice"><span>{t("wiki.sharing_pending")} {sharingError === t("wiki.sharing_pending") ? null : sharingError}</span><Button size="sm" variant="ghost" onClick={() => openSettings("sharing")}>{t("wiki.retry_sharing")}</Button></div> : null}
      {wiki && ((!sharingError && wiki.syncStatus.error) || wiki.syncStatus.conflicts.length) ? <div role="alert" className="wiki-notice"><span>{wiki.syncStatus.error ?? t("wiki.conflicts", { count: wiki.syncStatus.conflicts.length })} {t("wiki.local_changes_safe")}</span>{wiki.syncStatus.conflicts.map((conflict) => <button key={conflict} className="underline" onClick={() => openPage(conflict)}>{conflict}</button>)}</div> : null}
      <div ref={workbenchBody} className="wiki-workbench-body">
        {navigationOnly || (!tabOnly && navigationOpen) ? <aside className="wiki-sidebar" aria-label={t("wiki.navigation")}>
          <div className="wiki-sidebar-header">
            {props.onManageWikis ? <button className="wiki-nav-row" onClick={props.onManageWikis}><BookOpen size={15} /><span>{t("wiki.manage_all")}</span></button> : null}
            <div className="wiki-sidebar-actions">
              <button className="wiki-nav-row" title={t("wiki.history")} onClick={() => { setHistoryPath(""); setHistory(true); }}><History size={15} /><span>{t("wiki.history")}</span></button>
              {wiki && props.client ? <WikiContributions client={props.client} wikiId={wiki.id} workspaceId={props.workspaceId} /> : null}
            </div>
            <div className="wiki-sidebar-switcher">{wikiSelector}<WikiIconButton label={t("wiki.refresh")} disabled={busy} onClick={() => void run(async () => { if (wiki?.sync) await props.client?.syncWiki(wiki.id); refresh(); })}><RefreshCw size={14} className={busy ? "animate-spin" : ""} /></WikiIconButton></div>
          </div>
          <WikiExplorer key={wikiId} stateKey={`${props.serverUrl}:${wikiId}`} files={files} pageTitles={pageTitles} viewFiles={viewFiles} folders={folders} searchFiles={searchFiles} active={surface === "page" ? path : ""} writable={writable} busy={busy} revealable={isDesktopRuntime() && isLoopbackLegalworkServerUrl(props.serverUrl)} search={search} searching={Boolean(debouncedSearch.trim())} onSearch={setSearch} onOpen={(path) => { if (/\.md$/i.test(path)) openPage(path); else void run(() => openAsset(path)); }} onNewPage={(folder) => setNewPage(folder ? `${folder}/` : "")} onNewFolder={(folder) => setFileDialog({ action: "create-folder", path: folder ? `${folder}/` : "" })} onGraph={openGraph} onAction={entryAction} onImport={importFiles} onDragFile={(data, path) => { if (!wiki) return; writeWikiFileDrag(data, { serverUrl: props.serverUrl, wikiId: wiki.id, workspaceId: wiki.workspaceId, path, name: path.split("/").at(-1) ?? path }); data.setData(FILE_SIDEBAR_DRAG_TYPE, ""); }}>
            {snapshot.error ? <p role="alert" className="wiki-search-status">{wikiError(snapshot.error)} <button className="underline" onClick={() => void snapshot.refetch()}>{t("wiki.retry")}</button></p> : null}
            {searchResult.isFetching && debouncedSearch.trim() ? <div className="wiki-search-status" role="status"><Loader2 size={14} className="animate-spin" />{t("wiki.searching")}</div> : null}
            {searchResult.error && debouncedSearch.trim() ? <p role="alert" className="wiki-search-status text-destructive">{wikiError(searchResult.error)}</p> : null}
            {debouncedSearch.trim() && !searchFiles.length && !searchResult.isFetching ? <p className="wiki-search-status">{t("wiki.no_search_results")}</p> : null}
            {!debouncedSearch.trim() && <ViewList issuesOnly client={props.client} owner={{ kind: "wiki", id: wikiId }} />}
          </WikiExplorer>
          <WikiChatHistory key={wikiId} {...props.chatHistory} onOpen={props.chatHistory?.onOpen ?? (() => {})} stateKey={`${props.serverUrl}:${wikiId}`} busy={!wiki || busy} onNewChat={() => { if (wiki) void run(() => props.onOpenWikiSession(wiki)); }} />
        </aside> : null}
        {!navigationOnly ? <main className="wiki-main">
          {snapshot.error ? <EmptyWiki message={wikiError(snapshot.error)} action={<Button variant="outline" onClick={() => void snapshot.refetch()}>{t("wiki.retry")}</Button>} /> : snapshot.isLoading ? <WikiLoading /> : surface === "graph" ? <WikiGraphPane pages={pages} focus={path || null} onOpen={openPage} client={props.client} serverUrl={props.serverUrl} wikiId={wikiId} /> : <>
            {writable && draft?.error ? <div role="alert" className="wiki-notice wiki-error-notice"><span>{draft.error} {t("wiki.draft_preserved")}</span><Button size="sm" variant="outline" onClick={() => void drafts.save(wikiId, path)}>{t("wiki.retry")}</Button><Button size="sm" variant="outline" onClick={() => { if (!props.client || !wiki) return; void run(async () => { const copyPath = `${path.replace(/\.md$/i, "")}-draft-${Date.now()}.md`; await props.client?.writeWikiPage(wiki.id, { path: copyPath, content: draft.content }); drafts.remove(wiki.id, path); openPage(copyPath); refresh(); }); }}>{t("wiki.save_copy")}</Button><Button size="sm" variant="ghost" onClick={() => { if (window.confirm(t("wiki.discard_confirm"))) void run(() => drafts.load(wikiId, path, true)); }}>{t("wiki.reload_saved")}</Button></div> : null}
            {pageError ? <EmptyWiki message={pageError} action={<Button variant="outline" onClick={() => { setHistoryPath(path); setHistory(true); }}>{t("wiki.history")}</Button>} /> : documentLoading && !draft ? <WikiLoading /> : draft ? <>
              <ViewHostProvider client={props.client} owner={{ kind: "wiki", id: wikiId }} openSource={openPage}><div ref={editorRegion} className={cn("wiki-page-content", writable && "wiki-editor-content", backlinks.length > 0 && "wiki-page-with-backlinks")} key={`${wikiId}:${path}`} onKeyDownCapture={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (writable) void drafts.save(wikiId, path); } }}>
                <WikiPageHeader key={`${wikiId}:${path}`} toolbarRef={setToolbarTarget} navigation={wiki && !inWikiWorkspace ? <div className="wiki-page-navigation"><span>{wiki.name}</span><a href={`#${wikiWorkspaceRoute(wiki.workspaceId)}`} onClick={event => { event.preventDefault(); usePanelTabStore.getState().openTab(workspacePanelKey(wiki.workspaceId), wikiPanelTab(props.serverUrl, wiki.id, { kind: "page", path, anchor: pageAnchor }, currentPage?.title ?? path)); props.onOpenWiki(wiki); }}>{t("wiki.open_in_wiki")}<ArrowUpRight size={14} /></a></div> : undefined} content={writable ? draft.content : draft.baseline} fallbackTitle={currentPage?.title ?? path.replace(/\.md$/i, "").split("/").at(-1) ?? ""} pages={pages} path={path} readOnly={!writable} onChange={content => drafts.change(wikiId, path, content)} onSource={() => setViewModeRequest({ mode: "source" })} onOpen={openPage} />
                {writable ? <Suspense fallback={<WikiLoading />}><MarkdownEditor toolbarMenuItems={<DropdownMenuItem onClick={() => { setHistoryPath(path); setHistory(true); }}><History />{t("wiki.history")}</DropdownMenuItem>} toolbarTarget={toolbarTarget} externalFrontmatter value={draft.content} baseline={draft.baseline} onChange={(content) => drafts.change(wikiId, path, content)} imageUpload={uploadImage} imagePreview={imagePreview} viewModeRequest={viewModeRequest} linkTargets={linkTargets} onOpenLink={openEditorLink} /></Suspense> : <>
                  <WikiPreview content={draft.baseline} path={path} anchor={pageAnchor} pages={pages} files={files} onOpen={openPage} onMissing={(target) => { if (writable) setNewPage(target.split("#")[0]); else toast.error(t("wiki.missing_link")); }} onAsset={(assetPath) => void run(() => openAsset(assetPath))} imagePreview={imagePreview} />
                </>}
                {backlinks.length ? <section className="wiki-backlinks" aria-label={t("wiki.backlinks")} contentEditable={false}>
                  <h2>{t("wiki.backlinks")} <span>{backlinks.length}</span></h2>
                  <ul>{backlinks.map((page) => <li key={page.path}><Button variant="link" className="wiki-backlink" onClick={() => openPage(page.path)}>{page.title}</Button></li>)}</ul>
                </section> : null}
              </div></ViewHostProvider>
            </> : <EmptyWiki message={t("wiki.empty_pages")} action={<Button disabled={!writable} onClick={() => setNewPage("")}>{t("wiki.new_page")}</Button>} />}
          </>}
          {snapshot.data?.warnings.length ? <details className="wiki-warnings"><summary>{t("wiki.warnings", { count: snapshot.data.warnings.length })}</summary><ul>{snapshot.data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
        </main> : null}
      </div>
    </>}
    {renamingView && props.client && <ViewRenameDialog client={props.client} view={renamingView} onClose={() => setRenamingView(null)} />}
    {fileDialog && wiki ? <WikiFileDialog value={fileDialog} folders={folders} onClose={() => setFileDialog(null)} onSubmit={changeEntry} /> : null}
    {newWiki && props.client ? <CreateWikiDialog client={props.client} serverUrl={props.serverUrl} wikis={list.data?.items ?? []} onClose={() => setNewWiki(false)} onCreate={async (input) => { const result = await props.client?.createWiki(input); if (!result) return; setNewWiki(false); acceptWiki(result.wiki); chooseWiki(result.wiki.id, result.wiki); setSharingActionError(result.sharingError ? { wikiId: result.wiki.id, message: result.sharingError } : null); props.onWikisChanged?.(); }} onJoin={async (input) => { const result = await props.client?.joinWiki(input); if (!result) return; setNewWiki(false); acceptWiki(result.wiki); chooseWiki(result.wiki.id, result.wiki); props.onWikisChanged?.(); }} /> : null}
    {settings && props.client && wiki ? <WikiSettingsDialog key={wiki.id} initialTab={settingsTab} client={props.client} serverUrl={props.serverUrl} wiki={wiki} projectWorkspaces={props.workspaces.filter((workspace) => !list.data?.items.some((item) => item.workspaceId === workspace.id))} onClose={() => setSettings(false)} onUpdate={async (input) => { const result = await props.client?.updateWiki(wiki.id, input); if (result) acceptWiki(result.wiki); setSettings(false); }} onShare={async (input, update) => { const result = update ? await props.client?.updateWikiSharing(wiki.id, input) : await props.client?.shareWiki(wiki.id, input); if (result) { acceptWiki(result.wiki); setSharingActionError(null); } }} onStopSharing={async () => { const result = await props.client?.stopWikiSharing(wiki.id); if (result) { acceptWiki(result.wiki); setSharingActionError(null); } }} onForget={async () => { if (drafts.dirty.some((item) => item.wikiId === wiki.id)) throw new Error(t("wiki.save_before_forget")); await props.client?.forgetWiki(wiki.id); setSettings(false); if (tabOnly) props.onCloseTab?.(); else chooseWiki(""); refresh(); }} /> : null}
    {newPage !== null && props.client && wiki && writable ? <NewWikiPageDialog key={`${wiki.id}:${newPage}`} pages={pages} initialPath={newPage} onClose={() => setNewPage(null)} onCreate={async (newPath, templatePath) => { if (pages.some((page) => page.path.toLocaleLowerCase() === newPath.toLocaleLowerCase())) throw new Error(t("wiki.page_exists")); let content = `# ${newPath.split("/").at(-1)?.replace(/\.md$/i, "")}\n\n`; if (templatePath) { const template = await props.client?.readWikiPage(wiki.id, templatePath); const page = pages.find((entry) => entry.path === templatePath); if (template && page) content = wikiTemplateContent(template.content, page, newPath.split("/").at(-1)?.replace(/\.md$/i, "") ?? newPath); } await props.client?.writeWikiPage(wiki.id, { path: newPath, content }); setNewPage(null); setViewModeRequest({ mode: "rich-text" }); openPage(newPath); refresh(); }} /> : null}
    {history && props.client && wiki ? <WikiHistoryDialog key={`${wiki.id}:${historyPath}`} client={props.client} serverUrl={props.serverUrl} writable={writable} wikiId={wiki.id} initialPath={historyPath} onClose={() => setHistory(false)} onRestoreTrash={(trashId) => changeEntry({ action: "restore", trashId })} onRestore={async (restorePath, revisionId, baseRevision) => { if (drafts.get(wiki.id, restorePath)?.content !== drafts.get(wiki.id, restorePath)?.baseline) throw new Error(t("wiki.save_before_restore")); await props.client?.restoreWikiPage(wiki.id, { path: restorePath, revisionId, baseRevision }); await drafts.load(wiki.id, restorePath, true); refresh(); toast.success(t("wiki.restored")); }} /> : null}
  </div>;
}

function EmptyWiki(props: { title?: string; message: string; action?: React.ReactNode }) {
  return <div className="wiki-empty"><BookOpen size={32} strokeWidth={1.3} aria-hidden="true" />{props.title ? <h2>{props.title}</h2> : null}<p>{props.message}</p>{props.action}</div>;
}

function WikiLoading() {
  return <div className="wiki-loading" role="status"><Loader2 size={18} className="animate-spin" /><span>{t("wiki.loading")}</span></div>;
}

function WikiIconButton(props: { label: string; disabled?: boolean; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Tooltip><TooltipTrigger render={<Button size="icon-sm" variant="ghost" className="wiki-icon-button" aria-label={props.label} aria-pressed={props.pressed} disabled={props.disabled} onClick={props.onClick} />}>{props.children}</TooltipTrigger><TooltipContent>{props.label}</TooltipContent></Tooltip>;
}
