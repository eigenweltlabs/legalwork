/** @jsxImportSource react */
import * as React from "react";
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpToLine,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  Globe,
  Maximize2,
  Minimize2,
  FolderInput,
  FileText,
  ListTodo,
  Loader2,
  Plus,
  PanelsTopLeft,
  Columns2,
  Rows2,
  RotateCw,
  X,
  Workflow,
} from "lucide-react";
import { useDragControls } from "motion/react";

import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { PanelTab, PanelTabClose, PanelTabItem, PanelTabList } from "@/components/panel-tabs";
import { toast } from "@/components/ui/sonner";
import { useQueryClient } from "@tanstack/react-query";
import { hasViewerFileDrag, readViewerFileDrop, viewerFileTabs } from "./viewer-file-drop";
import { projectFileDisplayName } from "../../workspace/project-note-title";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PanelEmptyState, PanelHeaderPortal } from "@/react-app/design-system/panel-chrome";
import { cn } from "@/lib/utils";

import { ArtifactIcon } from "../artifacts/artifact-icon";
import { confirmDiscardSessionDocuments } from "../artifacts/docx-document-state";
import { ArtifactPanel } from "../artifacts/artifact-panel";
import { useDocumentPreferences, type DocumentSplitOrientation } from "../artifacts/document-preferences";
import { documentSplitDropEdge } from "./document-split-drop";
import {
  type ArtifactPanelTab,
  type BrowserPanelTab,
  usePanelTabStore,
  type PanelTab as PanelTabEntry,
  useActivePanelTab,
  useSessionPanelState,
} from "./panel-tab-store";
import { ControlActionScope, useControlOpenFiles, useControlAction, type LegalworkControlAction } from "../../../shell/control/control-provider";
import type { OpenTarget } from "../artifacts/open-target";
import { useSidePanelTabs } from "./use-side-panel-tabs";
import { t } from "@/i18n";
import { TaskPanel } from "@/react-app/domains/tasks/task-panel";
import { WorkflowEditorPanel } from "@/react-app/domains/settings/pages/workflow-editor-panel";
import { WorkflowResourceEditorPanel } from "@/react-app/domains/settings/pages/workflow-resource-editor-panel";
import {
  computeBounds,
  getElectronBrowser,
  getNativeMenuPoint,
  hasNativeBrowserOccluder,
  sameBounds,
} from "./utils";

import { DocumentPane } from "./document-pane";

type SidePanelProps = {
  headerTarget?: HTMLElement | null;
  projects?: { id: string; name: string }[];
  sessionId: string;
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  onClose: () => void;
};

// HMR can remount this module without unmounting BrowserPanelContent, leaving
// the native Electron browser overlay visible — hide it before the module reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    getElectronBrowser()?.hide?.();
  });
}

type ViewerPane = "main" | "side";

// Document tabs travel between the two panes as a native drag, apart from the
// pointer drag that reorders browser tabs within a strip.
const TAB_DRAG_TYPE = "application/x-legalwork-panel-tab";

type TabDrag = { id: string; pane: ViewerPane };

type TabDropZoneProps = {
  pane: ViewerPane;
  dragging: TabDrag | null;
  // The outer third opens a split when there is no side pane yet.
  edge?: boolean;
  inset?: boolean;
  label: string;
  onDrop: (tabId: string, split?: DocumentSplitOrientation) => void;
  onFileDrop: (drop: ReturnType<typeof readViewerFileDrop>, pane: ViewerPane, split?: DocumentSplitOrientation) => void;
  className?: string;
  children: React.ReactNode;
};

function TabDropZone({ pane, dragging, edge = false, inset = false, label, onDrop, onFileDrop, className, children }: TabDropZoneProps) {
  const [over, setOver] = React.useState<{ pane: ViewerPane; file: boolean; split: DocumentSplitOrientation | null } | null>(null);
  const [dragActive, setDragActive] = React.useState(false);
  const zone = React.useRef<HTMLDivElement>(null);
  const accepts = dragging !== null && (edge || dragging.pane !== pane);

  React.useEffect(() => {
    const element = zone.current;
    if (!element) return;
    const splitEdge = (event: DragEvent) => {
      const rect = element.getBoundingClientRect();
      return edge ? documentSplitDropEdge(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height) : null;
    };
    const over = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (!data) return;
      const file = hasViewerFileDrag(data);
      const split = splitEdge(event);
      const hit = file || (accepts && data.types.includes(TAB_DRAG_TYPE) && (!edge || split));
      if (!hit) { setOver(null); return; }
      const target = split ? "side" : pane;
      setOver((previous) => previous?.pane === target && previous.file === file && previous.split === split ? previous : { pane: target, file, split });
      event.preventDefault();
      event.stopPropagation();
      data.dropEffect = file ? "copy" : "move";
    };
    const stop = () => { setOver(null); setDragActive(false); };
    const leave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) setOver(null);
    };
    // Arm before the pointer reaches a PDF/HTML iframe: events inside its
    // document cannot bubble to this pane. Text/link drags keep their usual path.
    const start = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (inset && data && (hasViewerFileDrag(data) || data.types.includes(TAB_DRAG_TYPE))) setDragActive(true);
    };
    const leaveWindow = (event: DragEvent) => {
      if (!event.relatedTarget && (event.target === document || event.target === document.documentElement)) stop();
    };
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
    const drop = (event: DragEvent) => {
      stop();
      const data = event.dataTransfer;
      if (!data) return;
      const split = splitEdge(event);
      if (hasViewerFileDrag(data)) {
        event.preventDefault();
        event.stopPropagation();
        onFileDrop(readViewerFileDrop(data), split ? "side" : pane, split ?? undefined);
        return;
      }
      const tabId = data.getData(TAB_DRAG_TYPE);
      if (!accepts || !tabId || (edge && !split)) return;
      event.preventDefault();
      event.stopPropagation();
      onDrop(tabId, split ?? undefined);
    };
    // Native capture follows the physical pane even when its editor is a React
    // portal, and receives the drop before the editor can consume it.
    element.addEventListener("dragover", over, true);
    element.addEventListener("dragleave", leave);
    element.addEventListener("drop", drop, true);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragenter", start, true);
    window.addEventListener("dragleave", leaveWindow);
    window.addEventListener("dragend", stop, true);
    window.addEventListener("drop", stop, true);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", cancel);
    return () => {
      element.removeEventListener("dragover", over, true);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("drop", drop, true);
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragenter", start, true);
      window.removeEventListener("dragleave", leaveWindow);
      window.removeEventListener("dragend", stop, true);
      window.removeEventListener("drop", stop, true);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", cancel);
    };
  }, [accepts, edge, inset, pane, onDrop, onFileDrop]);

  return (
    <div ref={zone} data-document-drop-pane={inset ? pane : undefined} className={cn("relative", className)}>
      {children}
      {dragActive && <div aria-hidden data-viewer-drop-overlay data-viewer-drag-shield className="absolute inset-0 z-30" />}
      {over ? (
        <div
          aria-hidden
          data-viewer-drop-overlay
          className={cn(
            "pointer-events-none absolute right-0 z-40 flex items-center justify-center border-2 border-dashed border-primary/60 bg-primary/10 p-2 text-center text-xs font-medium text-primary",
            over.split === "vertical" ? "left-0 top-[max(10rem,70%)] bottom-8" : inset ? "top-40 bottom-8" : "inset-y-0",
            over.split === "horizontal" ? "w-[30%]" : "left-0",
          )}
        >
          <span className="rounded bg-background/95 px-2 py-1">
            {over.split ? t(over.split === "vertical" ? "side_panel.drop_to_open_below" : "side_panel.drop_to_open_beside") : over.file ? t("side_panel.drop_to_open_here") : label}
          </span>
        </div>
      ) : null}
    </div>
  );
}

type SidePanelTabProps = {
  tab: PanelTabEntry;
  pane: ViewerPane;
  orientation: DocumentSplitOrientation;
  active: boolean;
  canMove: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tab: PanelTabEntry) => void;
  onMove: (tab: ArtifactPanelTab) => void;
  onDragChange: (tabId: string | null) => void;
};

function SidePanelTab({ tab, pane, orientation, active, canMove, onSelect, onClose, onMove, onDragChange }: SidePanelTabProps) {
  const dragControls = useDragControls();
  const tabRef = React.useRef<HTMLDivElement>(null);
  const label = tab.type === "artifact" && tab.value && !tab.storage
    ? projectFileDisplayName(tab.value, tab.label) : tab.label;
  const fileTab = tab.type === "artifact" ? tab : null;
  const moveLabel = pane === "main"
    ? t(orientation === "vertical" ? "side_panel.open_below" : "side_panel.open_to_side")
    : t(orientation === "vertical" ? "side_panel.move_to_top" : "side_panel.move_to_main");

  React.useEffect(() => {
    if (active) {
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);

  const showBrowserTabContextMenu = (point?: { clientX: number; clientY: number }) => {
    void getElectronBrowser()?.showTabContextMenu?.(
      tab.id,
      getNativeMenuPoint(tabRef.current, point),
    );
  };

  return (
    <PanelTabItem
      value={tab.id}
      id={tab.id}
      dragControls={tab.type === "browser" ? dragControls : undefined}
      onContextMenu={tab.type === "browser" ? (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        showBrowserTabContextMenu({ clientX: event.clientX, clientY: event.clientY });
      } : undefined}
    >
      <div
        ref={tabRef}
        className="relative"
        draggable={fileTab !== null && canMove}
        onDragStart={fileTab ? (event) => {
          event.dataTransfer.setData(TAB_DRAG_TYPE, fileTab.id);
          event.dataTransfer.effectAllowed = "move";
          onDragChange(fileTab.id);
        } : undefined}
        onDragEnd={fileTab ? () => onDragChange(null) : undefined}
      >
        <PanelTab
          active={active}
          className={fileTab ? "pr-14" : undefined}
          onClick={() => onSelect(tab.id)}
          onPointerDown={tab.type === "browser" ? (event) => {
            if (event.button !== 0) {
              return;
            }

            dragControls.start(event);
          } : undefined}
          onKeyDown={tab.type === "browser" ? (event: React.KeyboardEvent<HTMLButtonElement>) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
              return;
            }

            event.preventDefault();
            showBrowserTabContextMenu();
          } : undefined}
          title={label}
          aria-label={t("side_panel.select_tab", { label })}
        >
          {tab.type === "browser" ? (
            tab.favicon ? (
              <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
            ) : tab.status === "loading" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Globe />
            )
          ) : tab.type === "task" ? (
            <ListTodo />
          ) : tab.type === "workflow" ? (
            <Workflow />
          ) : tab.type === "workflow-resource" ? (
            <FileText />
          ) : (
            <ArtifactIcon type={tab.preview} />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        </PanelTab>
        {fileTab ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={!canMove}
            className={cn(
              "absolute right-7 top-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100",
              active && "opacity-100",
            )}
            title={moveLabel}
            aria-label={moveLabel}
            onClick={(event) => {
              event.stopPropagation();
              onMove(fileTab);
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {orientation === "vertical" ? (pane === "main" ? <ArrowDownToLine /> : <ArrowUpToLine />) : (pane === "main" ? <ArrowRightToLine /> : <ArrowLeftToLine />)}
          </Button>
        ) : null}
        <PanelTabClose
          active={active}
          label={label}
          onClose={() => onClose(tab)}
        />
      </div>
    </PanelTabItem>
  );
}

type BrowserPanelContentProps = {
  tab: BrowserPanelTab;
  onClose: () => void;
};

function BrowserPanelContent({
  tab,
  onClose,
}: BrowserPanelContentProps) {
  const isAvailable = Boolean(getElectronBrowser());
  const [urlInput, setUrlInput] = React.useState(tab.url);
  const urlFocusedRef = React.useRef(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const urlInputRef = React.useRef<HTMLInputElement>(null);
  const shownRef = React.useRef(false);
  const boundsFrameRef = React.useRef<number | null>(null);
  const lastBoundsRef = React.useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  React.useEffect(() => {
    if (!urlFocusedRef.current) {
      setUrlInput(tab.url);
    }
  }, [tab.id, tab.url]);

  const navigate = React.useCallback(() => {
    void getElectronBrowser()?.navigate?.(urlInput);
  }, [urlInput]);

  const back = React.useCallback(() => {
    void getElectronBrowser()?.back?.();
  }, []);

  const forward = React.useCallback(() => {
    void getElectronBrowser()?.forward?.();
  }, []);

  const reload = React.useCallback(() => {
    void getElectronBrowser()?.reload?.();
  }, []);

  const handleUrlKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigate();
      urlInputRef.current?.blur();
    }
  }, [navigate]);

  React.useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const content = contentRef.current;
    if (!browser || !content || !isAvailable) {
      return;
    }

    const bounds = computeBounds(content);
    if (bounds.width < 1 || bounds.height < 1) {
      return;
    }

    browser.setBounds?.(bounds);
    lastBoundsRef.current = bounds;
  });

  React.useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const content = contentRef.current;

    if (!browser || !content || !isAvailable) {
      browser?.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      return;
    }

    let disposed = false;

    const resetNativeView = async () => {
      await browser.hide?.();

      if (disposed) {
        return;
      }

      shownRef.current = false;
      lastBoundsRef.current = null;
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    const syncBounds = () => {
      const bounds = computeBounds(content);

      if (bounds.width < 1 || bounds.height < 1 || hasNativeBrowserOccluder()) {
        if (shownRef.current) {
          browser.hide?.();
          shownRef.current = false;
          lastBoundsRef.current = null;
        }

        return;
      }

      if (!shownRef.current) {
        browser.show?.(bounds);
        shownRef.current = true;
        lastBoundsRef.current = bounds;
        return;
      }

      if (!sameBounds(lastBoundsRef.current, bounds)) {
        browser.setBounds?.(bounds);
        lastBoundsRef.current = bounds;
      }
    };

    const watchBounds = () => {
      syncBounds();
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    void resetNativeView();

    const observer = new ResizeObserver(syncBounds);

    observer.observe(content);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      browser.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;
    };
  }, [isAvailable]);

  return (
    <>
      <div className="flex h-(--lw-panel-toolbar-height) shrink-0 items-center gap-1 border-b border-border/70 bg-background/80 px-2 backdrop-blur-xl">
        {isAvailable ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={back}
                    disabled={!tab.canGoBack}
                    aria-label={t("side_panel.go_back")}
                  >
                    <ArrowLeft />
                  </Button>
                )}
              />
              <TooltipContent>Back</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={forward}
                    disabled={!tab.canGoForward}
                    aria-label={t("side_panel.go_forward")}
                  >
                    <ArrowRight />
                  </Button>
                )}
              />
              <TooltipContent>Forward</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={reload}
                    aria-label={t("side_panel.reload_page")}
                  >
                    {tab.status === "loading" ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  </Button>
                )}
              />
              <TooltipContent>Reload</TooltipContent>
            </Tooltip>
            <InputGroup className="mx-1 h-8 flex-1 rounded-lg border-border/70 bg-muted/25">
              <InputGroupInput
                ref={urlInputRef}
                type="text"
                className="h-8 text-xs"
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                onKeyDown={handleUrlKeyDown}
                onFocus={() => {
                  urlFocusedRef.current = true;
                  urlInputRef.current?.select();
                }}
                onBlur={() => {
                  urlFocusedRef.current = false;
                }}
                placeholder={t("side_panel.address_placeholder")}
                aria-label={t("side_panel.address_label")}
                spellCheck={false}
                autoComplete="off"
              />
              <InputGroupAddon align="inline-start" className="ps-2">
                <Globe />
              </InputGroupAddon>
            </InputGroup>
          </>
        ) : (
          <p className="min-w-0 flex-1 truncate px-2 text-[13px] font-medium text-foreground">{t("side_panel.browser")}</p>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title={t("side_panel.close_panel")}
          aria-label={t("side_panel.close_panel")}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {isAvailable ? <div ref={contentRef} className="h-full overflow-hidden" /> : (
          <PanelEmptyState
            icon={<Globe />}
            title={t("side_panel.desktop_only_title")}
            description={t("side_panel.desktop_only_body")}
          />
        )}
      </div>
    </>
  );
}

export function SidePanel({
  headerTarget,
  projects,
  sessionId,
  client,
  workspaceId,
  workspaceRoot,
  isRemoteWorkspace = false,
  onClose,
}: SidePanelProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = React.useState(false);
  const orientation = useDocumentPreferences((state) => state.splitOrientation);
  const stacked = orientation === "vertical";
  const [mainDestination, setMainDestination] = React.useState<HTMLDivElement | null>(null);
  const [sideDestination, setSideDestination] = React.useState<HTMLDivElement | null>(null);
  const [focusedTabId, setFocusedTabId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [openingFile, setOpeningFile] = React.useState<string | null>(null);
  const importing = React.useRef(false);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const openFilesInViewer = React.useCallback(async (drop: ReturnType<typeof readViewerFileDrop>, pane?: ViewerPane, split?: DocumentSplitOrientation) => {
    if (importing.current) return;
    if (!client || !workspaceId) {
      toast.error(t("side_panel.wait_for_workspace"));
      return;
    }
    importing.current = true;
    setOpeningFile(drop.workspace?.name ?? drop.storage?.name ?? drop.memory?.name ?? drop.files[0]?.name ?? null);
    try {
      for await (const tab of viewerFileTabs(client, workspaceId, drop)) {
        if (!mounted.current) return;
        usePanelTabStore.getState().openTab(sessionId, tab, pane);
        const session = usePanelTabStore.getState().sessions[sessionId];
        const selectedId = pane === "side" && session?.sideActiveTabId ? session.sideActiveTabId : session?.activeTabId;
        const selected = session?.tabs.find((entry) => entry.id === selectedId);
        if (!selected || !(selected.id === tab.id || (selected.type === "artifact" && !selected.storage && !tab.storage && tab.value && selected.value === tab.value))) break;
        if (split && session.sideActiveTabId === selected.id) useDocumentPreferences.getState().setSplitOrientation(split);
        setFocusedTabId(selected.id);
      }
      void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
    } catch (error) {
      toast.error(t("side_panel.file_open_failed"), { description: error instanceof Error ? error.message : t("side_panel.file_copy_failed") });
    } finally {
      importing.current = false;
      if (mounted.current) setOpeningFile(null);
    }
  }, [client, workspaceId, sessionId, queryClient]);

  const { tabs, sideTabIds, sideActiveTabId } = useSessionPanelState(sessionId);
  const activeTab = useActivePanelTab(sessionId);
  const { mainTabs, sideTabs, sideActiveTab } = React.useMemo(() => {
    const sideSet = new Set(sideTabIds);
    const sideTabs = tabs.flatMap((tab) => tab.type === "artifact" && sideSet.has(tab.id) ? [tab] : []);
    return {
      mainTabs: tabs.filter((tab) => !sideSet.has(tab.id)),
      sideTabs,
      sideActiveTab: sideTabs.find((tab) => tab.id === sideActiveTabId) ?? null,
    };
  }, [tabs, sideTabIds, sideActiveTabId]);
  const transcriptTargets = usePanelTabStore((state) => state.transcriptArtifactTargets[sessionId]);
  const openFiles = React.useMemo(() => tabs.flatMap((tab) => {
    if (tab.type !== "artifact") return [];
    const path = tab.value ?? transcriptTargets?.find((target) => target.id === tab.id)?.value;
    const active = tab.id === (focusedTabId === sideActiveTab?.id ? sideActiveTab?.id : activeTab?.id);
    return path ? [{ id: tab.id, sessionId, name: tab.label, path, active }] : [];
  }), [tabs, transcriptTargets, sessionId, activeTab?.id, sideActiveTab?.id, focusedTabId]);
  useControlOpenFiles(openFiles);
  const isBrowserAvailable = Boolean(getElectronBrowser());

  const { createTab, closeTab, selectTab, reorderTabs } = useSidePanelTabs(sessionId);
  const moveTabToSide = usePanelTabStore((state) => state.moveTabToSide);
  const moveTabToMain = usePanelTabStore((state) => state.moveTabToMain);
  const moveToSide = React.useCallback((tabId: string, split?: DocumentSplitOrientation) => {
    moveTabToSide(sessionId, tabId);
    if (split && usePanelTabStore.getState().sessions[sessionId]?.sideActiveTabId === tabId) useDocumentPreferences.getState().setSplitOrientation(split);
  }, [moveTabToSide, sessionId]);
  const moveToMain = React.useCallback((tabId: string) => moveTabToMain(sessionId, tabId), [moveTabToMain, sessionId]);
  const [draggingTabId, setDraggingTabId] = React.useState<string | null>(null);
  const draggingTab = React.useMemo<TabDrag | null>(
    () => draggingTabId ? { id: draggingTabId, pane: sideTabIds.includes(draggingTabId) ? "side" : "main" } : null,
    [draggingTabId, sideTabIds],
  );

  const selectFileAction = React.useMemo<LegalworkControlAction>(() => ({
    id: "documents.select_open", label: "Show an open file", sideEffect: "navigation", requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true }, { name: "path", type: "string", required: true }],
    execute: (args) => {
      if (typeof args !== "object" || !args || Reflect.get(args, "sessionId") !== sessionId) return { ok: false, error: "No matching sidebar for this session." };
      const file = openFiles.find((file) => file.path === Reflect.get(args, "path"));
      if (!file) return { ok: false, error: "This file is not open in the sidebar." };
      const visible = file.id === activeTab?.id || file.id === sideActiveTab?.id;
      if (!visible) {
        const session = usePanelTabStore.getState().sessions[sessionId];
        const replaced = session?.sideTabIds.includes(file.id) ? session.sideActiveTabId : session?.activeTabId ?? null;
        if (!confirmDiscardSessionDocuments(sessionId, [replaced], () => false)) return { ok: false, error: "Save the current draft before switching files." };
      }
      setFocusedTabId(file.id);
      selectTab(file.id);
      const session = usePanelTabStore.getState().sessions[sessionId];
      if (session?.activeTabId !== file.id && session?.sideActiveTabId !== file.id) return { ok: false, error: "The file could not be selected." };
      return { ok: true, file: { ...file, active: true }, message: "Read the document after the editor finishes loading." };
    },
  }), [openFiles, sessionId, selectTab, activeTab?.id, sideActiveTab?.id]);
  useControlAction(selectFileAction);

  const seedArtifactOverflowControlAction = React.useMemo<LegalworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_overflow",
      label: "Seed artifact tab overflow eval data",
      description: "Create many markdown artifacts and open them in the right-side artifact tab strip.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      args: [{ name: "count", type: "number", description: "Number of artifact tabs to create." }],
      previewArgs: { count: 18 },
      execute: async (args) => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        let count = 18;
        if (args && typeof args === "object" && "count" in args && typeof args.count === "number") {
          count = Math.max(12, Math.min(30, Math.floor(args.count)));
        }

        const targets: OpenTarget[] = [];
        const store = usePanelTabStore.getState();

        for (let index = 1; index <= count; index += 1) {
          const padded = String(index).padStart(2, "0");
          const value = `artifacts/overflow-tab-${padded}.md`;
          const label = `overflow-tab-${padded}.md`;
          const content = `# Overflow tab ${padded}\n\nGenerated by the artifact tab overflow eval.\n`;

          await client.writeWorkspaceFile(workspaceId, { path: value, content, baseUpdatedAt: null });

          const target: OpenTarget = {
            id: `file:${value}`,
            kind: "file",
            value,
            name: label,
            preview: "markdown",
            confidence: 100,
            reason: "eval",
            exists: true,
            size: content.length,
          };

          targets.push(target);
          store.openTab(sessionId, {
            id: target.id,
            type: "artifact",
            label: target.name,
            preview: target.preview,
          });
        }

        store.syncTranscriptArtifacts(sessionId, targets);
        store.selectTab(sessionId, targets[targets.length - 1]?.id ?? "");

        return { ok: true, count: targets.length, activeTabId: targets[targets.length - 1]?.id ?? null };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedArtifactOverflowControlAction);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const inSide = focusedTabId === sideActiveTab?.id;
      const paneTabs = inSide ? sideTabs : mainTabs;
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab" || paneTabs.length < 2) {
        return;
      }

      const activeId = inSide ? sideActiveTab?.id : activeTab?.id;
      const activeIndex = paneTabs.findIndex((tab) => tab.id === activeId);
      if (activeIndex === -1) {
        return;
      }

      event.preventDefault();
      const offset = event.shiftKey ? -1 : 1;
      const next = paneTabs[(activeIndex + offset + paneTabs.length) % paneTabs.length];
      selectTab(next.id);
      setFocusedTabId(next.id);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, sideActiveTab, focusedTabId, selectTab, mainTabs, sideTabs]);

  // Keep width and height independent when switching layouts.
  const [splitSizes, setSplitSizes] = React.useState(() => ({
    horizontal: useDocumentPreferences.getState().splitSize,
    vertical: useDocumentPreferences.getState().stackedSplitSize,
  }));
  const sideSize = splitSizes[orientation];

  const portaledHeader = expanded ? null : headerTarget;
  const stripClassName = cn("shrink-0 titlebar-no-drag", portaledHeader ? "h-full" : "bg-muted/35 backdrop-blur-xl");
  const stripRowClassName = cn("flex h-11 items-center gap-1 border-b border-border/70 px-2", portaledHeader && "h-full border-b-0");
  const layoutLabel = t(stacked ? "side_panel.arrange_side_by_side" : "side_panel.arrange_stacked");
  // Shared workspace controls stay at the top-right in either orientation.
  const workspaceControls = (
    <div className="ml-auto flex shrink-0">
      <Button variant="ghost" size="icon-sm" onClick={() => useDocumentPreferences.getState().setSplitOrientation(stacked ? "horizontal" : "vertical")} aria-label={layoutLabel} title={layoutLabel}>
        {stacked ? <Columns2 /> : <Rows2 />}
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={() => setExpanded(!expanded)} aria-label={expanded ? t("side_panel.restore_workspace") : t("side_panel.expand_workspace")} title={expanded ? t("side_panel.restore_workspace") : t("side_panel.expand_workspace")}>
        {expanded ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={onClose} aria-label={t("side_panel.close_preview")} title={t("side_panel.close_preview")}>
        <X />
      </Button>
    </div>
  );

  const mainStrip = (
    <TabDropZone
      pane="main"
      dragging={draggingTab}
      label={t("side_panel.drop_to_move_here")}
      onDrop={moveToMain}
      onFileDrop={openFilesInViewer}
      className={stripClassName}
    >
      <div className={stripRowClassName}>
        <div className="no-scrollbar min-w-0 overflow-x-auto">
          <PanelTabList
            values={mainTabs.map((tab) => tab.id)}
            onReorder={reorderTabs}
          >
            {mainTabs.map((tab) => (
              <SidePanelTab
                key={tab.id}
                tab={tab}
                pane="main"
                orientation={orientation}
                active={tab.id === activeTab?.id}
                canMove={mainTabs.length > 1}
                onSelect={(id) => { selectTab(id); setFocusedTabId(id); }}
                onClose={closeTab}
                onMove={(fileTab) => moveToSide(fileTab.id)}
                onDragChange={setDraggingTabId}
              />
            ))}
          </PanelTabList>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label={t("side_panel.open_in_viewer")}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void openFilesInViewer({ workspace: null, storage: null, memory: null, files });
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("side_panel.new_tab")} title={t("side_panel.new_tab")}><Plus /></Button>} />
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!client || !workspaceId || Boolean(openingFile)} onClick={() => fileInputRef.current?.click()}>
              <FolderInput /> {t("side_panel.files")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!isBrowserAvailable} onClick={() => createTab()}>
              <Globe /> {t("side_panel.browser")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!sideActiveTab || stacked ? workspaceControls : null}
      </div>
    </TabDropZone>
  );

  const sideStrip = sideActiveTab ? (
    <TabDropZone
      pane="side"
      dragging={draggingTab}
      label={t("side_panel.drop_to_move_here")}
      onDrop={moveToSide}
      onFileDrop={openFilesInViewer}
      className={cn(stripClassName, stacked && "h-11 border-b border-border/70 bg-muted/35")}
    >
      <div className={stripRowClassName}>
        <div className="no-scrollbar min-w-0 overflow-x-auto">
          <PanelTabList
            values={sideTabs.map((tab) => tab.id)}
            onReorder={reorderTabs}
          >
            {sideTabs.map((tab) => (
              <SidePanelTab
                key={tab.id}
                tab={tab}
                pane="side"
                orientation={orientation}
                active={tab.id === sideActiveTab.id}
                canMove
                onSelect={(id) => { selectTab(id); setFocusedTabId(id); }}
                onClose={closeTab}
                onMove={(fileTab) => moveToMain(fileTab.id)}
                onDragChange={setDraggingTabId}
              />
            ))}
          </PanelTabList>
        </div>
        {stacked ? null : workspaceControls}
      </div>
    </TabDropZone>
  ) : null;

  const mainContent = (
    <TabDropZone
      pane="main"
      // A lone main document cannot move: the main pane never empties.
      dragging={sideActiveTab || mainTabs.length > 1 ? draggingTab : null}
      edge={!sideActiveTab && Boolean(activeTab)}
      inset
      label={sideActiveTab ? t("side_panel.drop_to_move_here") : t("side_panel.drop_to_open_beside")}
      onDrop={sideActiveTab ? moveToMain : moveToSide}
      onFileDrop={openFilesInViewer}
      className="flex min-h-0 flex-1 flex-col"
    >
      {!activeTab ? (
        <PanelEmpty />
      ) : null}
      {activeTab?.type === "browser" ? (
        <BrowserPanelContent tab={activeTab} onClose={onClose} />
      ) : activeTab?.type === "artifact" ? (
        <div ref={setMainDestination} className="min-h-0 flex-1 overflow-hidden" onFocusCapture={() => setFocusedTabId(activeTab.id)} onPointerDownCapture={() => setFocusedTabId(activeTab.id)} />
      ) : activeTab?.type === "task" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <TaskPanel
            projects={projects}
            sessionId={sessionId}
            tab={activeTab}
            client={client}
            workspaceId={workspaceId}
            onClose={() => closeTab(activeTab)}
          />
        </div>
      ) : activeTab?.type === "workflow" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkflowEditorPanel key={activeTab.id} id={activeTab.id} onClose={() => closeTab(activeTab)} />
        </div>
      ) : activeTab?.type === "workflow-resource" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkflowResourceEditorPanel key={activeTab.id} id={activeTab.id} onClose={() => closeTab(activeTab)} />
        </div>
      ) : null}
    </TabDropZone>
  );

  return (
    <TooltipProvider delay={1000}>
      <div
        data-viewer-drop-target
        data-document-workspace-expanded={expanded}
        className={cn("flex h-full min-h-0 flex-col bg-background", expanded ? "fixed inset-0 z-40 mac:top-11" : "relative")}
      >
        {openingFile ? (
          <div role="status" className="pointer-events-none absolute bottom-4 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs shadow-sm">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            <span className="truncate">{t("side_panel.opening_file", { name: openingFile })}</span>
          </div>
        ) : null}
        {portaledHeader ? (
          // Stacked documents keep the lower strip with its pane. The upper
          // strip still uses the window header while the workspace is docked.
          <PanelHeaderPortal target={portaledHeader}>
            <div className="flex h-full min-w-0">
              <div className="h-full min-w-0" style={{ width: sideStrip && !stacked ? `${100 - sideSize}%` : "100%" }}>{mainStrip}</div>
              {sideStrip && !stacked ? <div className="h-full min-w-0 border-l border-border/70" style={{ width: `${sideSize}%` }}>{sideStrip}</div> : null}
            </div>
          </PanelHeaderPortal>
        ) : null}
        {/* Keep the main editor mounted when the side pane opens or closes:
            its unsaved draft and undo history belong to the document. */}
        <ResizablePanelGroup
          key={orientation}
          orientation={orientation}
          className="min-h-0 flex-1"
          defaultLayout={{ "viewer-main": 100 - sideSize, "viewer-side": sideSize }}
          onLayoutChange={(layout) => {
            const size = layout["viewer-side"];
            if (typeof size === "number") setSplitSizes((previous) => previous[orientation] === size ? previous : { ...previous, [orientation]: size });
          }}
          onLayoutChanged={(layout) => {
            const size = layout["viewer-side"];
            if (typeof size === "number") useDocumentPreferences.getState().setSplitSize(size, orientation);
          }}
        >
          <ResizablePanel id="viewer-main" minSize={stacked ? "30%" : "220px"} className="flex min-h-0 min-w-0 flex-col">
            {portaledHeader ? null : mainStrip}
            {mainContent}
          </ResizablePanel>
          {sideActiveTab ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="viewer-side" minSize={stacked ? "30%" : "220px"} className="flex min-h-0 min-w-0 flex-col">
                {portaledHeader && !stacked ? null : sideStrip}
                <TabDropZone
                  pane="side"
                  dragging={draggingTab}
                  label={t("side_panel.drop_to_move_here")}
                  onDrop={moveToSide}
                  onFileDrop={openFilesInViewer}
                  inset
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div ref={setSideDestination} className="min-h-0 flex-1 overflow-hidden" onFocusCapture={() => setFocusedTabId(sideActiveTab.id)} onPointerDownCapture={() => setFocusedTabId(sideActiveTab.id)} />
                </TabDropZone>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
        {tabs.flatMap((tab) => {
          if (tab.type !== "artifact" || (tab.id !== activeTab?.id && tab.id !== sideActiveTab?.id)) return [];
          return [<DocumentPane key={`${workspaceId}:${sessionId}:${tab.id}`} destination={tab.id === sideActiveTab?.id ? sideDestination : mainDestination}>
            <ControlActionScope active={tab.id === (focusedTabId === sideActiveTab?.id ? sideActiveTab.id : activeTab?.id)}>
              <div className="h-full" onFocusCapture={() => setFocusedTabId(tab.id)} onPointerDownCapture={() => setFocusedTabId(tab.id)}>
                <ArtifactPanel sessionId={sessionId} tab={tab} client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} isRemoteWorkspace={isRemoteWorkspace} onClose={() => closeTab(tab)} />
              </div>
            </ControlActionScope>
          </DocumentPane>];
        })}
      </div>
    </TooltipProvider>
  );
}

function PanelEmpty() {
  return (
    <PanelEmptyState
      icon={<PanelsTopLeft />}
      title={t("side_panel.empty_title")}
      description={t("side_panel.empty_body")}
    />
  );
}
