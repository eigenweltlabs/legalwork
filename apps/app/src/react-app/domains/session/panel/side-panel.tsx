/** @jsxImportSource react */
import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Maximize2,
  Minimize2,
  FolderInput,
  FileText,
  ListTodo,
  Loader2,
  Plus,
  PanelsTopLeft,
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
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
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
import { ExpandedDocumentBar } from "../artifacts/expanded-document-bar";
import { MAX_DOCUMENT_PANES, layoutLeaves, siblingPaneIds, topLayoutLeaves, type DocumentDropEdge, type DocumentLayoutNode } from "./document-layout";
import { documentSplitDropEdge } from "./document-split-drop";
import {
  type DocumentPaneState,
  type BrowserPanelTab,
  usePanelTabStore,
  type PanelTab as PanelTabEntry,
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

type ViewerPane = string;

// Document tabs travel between panes as a native drag, apart from the
// pointer drag that reorders browser tabs within a strip.
const TAB_DRAG_TYPE = "application/x-legalwork-panel-tab";

const DROP_LABELS: Record<DocumentDropEdge, () => string> = {
  left: () => t("side_panel.drop_left"),
  right: () => t("side_panel.drop_right"),
  top: () => t("side_panel.drop_top"),
  bottom: () => t("side_panel.drop_bottom"),
};
const SPLIT_LABELS: Record<DocumentDropEdge, () => string> = {
  left: () => t("side_panel.split_left"),
  right: () => t("side_panel.split_right"),
  top: () => t("side_panel.split_top"),
  bottom: () => t("side_panel.split_bottom"),
};

type TabDrag = { id: string; pane: ViewerPane };

type TabDropZoneProps = {
  pane: ViewerPane;
  dragging: TabDrag | null;
  // Edge drops split the pane under the pointer.
  edge?: boolean;
  splitBlocked?: boolean;
  inset?: boolean;
  label: string;
  onDrop: (tabId: string, split?: DocumentDropEdge) => void;
  onFileDrop: (drop: ReturnType<typeof readViewerFileDrop>, pane: ViewerPane, split?: DocumentDropEdge) => void;
  className?: string;
  children: React.ReactNode;
};

function TabDropZone({ pane, dragging, edge = false, splitBlocked = false, inset = false, label, onDrop, onFileDrop, className, children }: TabDropZoneProps) {
  const [over, setOver] = React.useState<{ pane: ViewerPane; file: boolean; split: DocumentDropEdge | null } | null>(null);
  const [dragActive, setDragActive] = React.useState(false);
  const zone = React.useRef<HTMLDivElement>(null);
  const accepts = dragging !== null && (edge || dragging.pane !== pane);

  React.useEffect(() => {
    const element = zone.current;
    if (!element) return;
    const splitEdge = (event: DragEvent) => {
      const rect = element.getBoundingClientRect();
      const split = edge ? documentSplitDropEdge(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height) : null;
      return split;
    };
    const over = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (!data) return;
      const file = hasViewerFileDrag(data);
      const split = splitEdge(event);
      const hit = file || (accepts && data.types.includes(TAB_DRAG_TYPE) && (dragging?.pane !== pane || split));
      if (!hit) { setOver(null); return; }
      const target = pane;
      setOver((previous) => previous?.pane === target && previous.file === file && previous.split === split ? previous : { pane: target, file, split });
      event.preventDefault();
      event.stopPropagation();
      // File identity is only readable on drop. It may be an already-open
      // lone tab that can relocate even at the cap; the store decides atomically.
      data.dropEffect = file ? "copy" : split && splitBlocked ? "none" : "move";
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
        onFileDrop(readViewerFileDrop(data), pane, split ?? undefined);
        return;
      }
      const tabId = data.getData(TAB_DRAG_TYPE);
      if (!accepts || !tabId || (dragging?.pane === pane && !split)) return;
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
  }, [accepts, edge, splitBlocked, dragging?.pane, inset, pane, onDrop, onFileDrop]);

  return (
    <div ref={zone} data-document-drop-pane={inset ? pane : undefined} className={cn("relative", className)}>
      {children}
      {dragActive && <div aria-hidden data-viewer-drop-overlay data-viewer-drag-shield className="absolute inset-0 z-30" />}
      {over ? (
        <div
          aria-hidden
          data-viewer-drop-overlay
          data-document-drop-edge={over.split ?? "center"}
          className={cn(
            "pointer-events-none absolute z-40 flex items-center justify-center rounded-xl border border-primary/30 bg-primary/10 p-3 text-center text-xs font-medium text-primary shadow-[inset_0_0_0_1px_hsl(var(--background)/0.6),0_8px_28px_-16px_hsl(var(--foreground)/0.25)] transition-[top,right,bottom,left] duration-150 ease-out motion-reduce:transition-none",
            over.split && splitBlocked && "border-border bg-muted/60 text-muted-foreground",
          )}
          style={{
            top: over.split === "bottom" ? "50%" : inset ? "min(8rem, 25%)" : 4,
            bottom: over.split === "top" ? "50%" : inset ? 12 : 4,
            left: over.split === "right" ? "50%" : 8,
            right: over.split === "left" ? "50%" : 8,
          }}
        >
          <span className="flex max-w-full items-center gap-2 rounded-lg border border-border/50 bg-background/95 px-3 py-2 shadow-sm">
            <PanelsTopLeft className="size-4 shrink-0" />
            {over.split && splitBlocked ? t("side_panel.pane_limit", { count: MAX_DOCUMENT_PANES }) : over.split ? DROP_LABELS[over.split]() : over.file ? t("side_panel.drop_to_open_here") : label}
          </span>
        </div>
      ) : null}
    </div>
  );
}

type SidePanelTabProps = {
  tab: PanelTabEntry;
  pane: ViewerPane;
  destinations: DocumentPaneState[];
  canSplit: boolean;
  active: boolean;
  canMove: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tab: PanelTabEntry) => void;
  onMove: (tabId: string, pane: string) => void;
  onSplit: (tabId: string, split: DocumentDropEdge) => void;
  onDragChange: (tabId: string | null) => void;
};

function SidePanelTab({ tab, pane, destinations, canSplit, active, canMove, onSelect, onClose, onMove, onSplit, onDragChange }: SidePanelTabProps) {
  const dragControls = useDragControls();
  const tabRef = React.useRef<HTMLDivElement>(null);
  const label = tab.type === "artifact" && tab.value && !tab.storage
    ? projectFileDisplayName(tab.value, tab.label) : tab.label;
  const fileTab = tab.type === "artifact" ? tab : null;


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

  const item = (
    <PanelTabItem
      value={tab.id}
      id={tab.id}
      // Pane resizing must move the strip and its tabs together, without
      // Reorder.Item springing back from their previous screen positions.
      transition={{ layout: { duration: 0 } }}
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
        <PanelTabClose
          active={active}
          label={label}
          onClose={() => onClose(tab)}
        />
      </div>
    </PanelTabItem>
  );
  if (!fileTab) return item;
  return <ContextMenu>
    <ContextMenuTrigger render={<div className="contents" />}>{item}</ContextMenuTrigger>
    <ContextMenuContent>
      {destinations.map((destination, index) => <ContextMenuItem key={destination.id} disabled={!canMove || destination.id === pane} onClick={() => onMove(tab.id, destination.id)}>
        {t("side_panel.move_to_pane", { number: index + 1 })}
      </ContextMenuItem>)}
      {canSplit && <>
        {(["left", "right", "top", "bottom"] satisfies DocumentDropEdge[]).map(edge => <ContextMenuItem key={edge} onClick={() => onSplit(tab.id, edge)}>{SPLIT_LABELS[edge]()}</ContextMenuItem>)}
      </>}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onClose(tab)}>{t("panel_tabs.close_tab")}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
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
  const session = useSessionPanelState(sessionId);
  const { tabs, panes, tree } = session;
  const [destinations, setDestinations] = React.useState<Record<string, HTMLDivElement | null>>({});
  const destinationRefs = React.useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const destinationRef = (id: string) => {
    let ref = destinationRefs.current.get(id);
    if (!ref) {
      ref = element => setDestinations(current => current[id] === element ? current : { ...current, [id]: element });
      destinationRefs.current.set(id, ref);
    }
    return ref;
  };
  const [focusedTabId, setFocusedTabId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [openingFile, setOpeningFile] = React.useState<string | null>(null);
  const importing = React.useRef(false);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const openFilesInViewer = React.useCallback(async (drop: ReturnType<typeof readViewerFileDrop>, pane?: ViewerPane, split?: DocumentDropEdge) => {
    if (importing.current) return;
    if (!client || !workspaceId) { toast.error(t("side_panel.wait_for_workspace")); return; }
    let destination = pane;
    let pendingSplit = split;
    importing.current = true;
    setOpeningFile(drop.workspace?.name ?? drop.storage?.name ?? drop.memory?.name ?? drop.files[0]?.name ?? null);
    try {
      for await (const tab of viewerFileTabs(client, workspaceId, drop)) {
        if (!mounted.current) return;
        const store = usePanelTabStore.getState();
        const before = store.sessions[sessionId];
        if (destination && before && !before.panes.some(pane => pane.id === destination)) { toast.error(t("side_panel.drop_target_closed")); break; }
        store.openTab(sessionId, tab, destination, pendingSplit);
        const next = usePanelTabStore.getState().sessions[sessionId];
        const opened = next?.tabs.find(entry => entry.id === tab.id || (entry.type === "artifact" && !entry.storage && !tab.storage && tab.value && entry.value === tab.value));
        if (next === before) {
          if (pendingSplit && before.panes.length >= MAX_DOCUMENT_PANES) toast.info(t("side_panel.pane_limit", { count: MAX_DOCUMENT_PANES }));
          break;
        }
        const openedPane = next?.panes.find(pane => pane.activeTabId === opened?.id);
        if (!opened || !openedPane) break;
        destination = openedPane.id;
        pendingSplit = undefined;
        setFocusedTabId(opened.id);
      }
      void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
    } catch (error) {
      toast.error(t("side_panel.file_open_failed"), { description: error instanceof Error ? error.message : t("side_panel.file_copy_failed") });
    } finally { importing.current = false; if (mounted.current) setOpeningFile(null); }
  }, [client, workspaceId, sessionId, queryClient]);

  const visibleIds = panes.flatMap(pane => pane.activeTabId ? [pane.activeTabId] : []);
  const focusedId = focusedTabId && visibleIds.includes(focusedTabId) ? focusedTabId : panes[0].activeTabId;
  const transcriptTargets = usePanelTabStore((state) => state.transcriptArtifactTargets[sessionId]);
  const openFiles = React.useMemo(() => tabs.flatMap((tab) => {
    if (tab.type !== "artifact") return [];
    const path = tab.value ?? transcriptTargets?.find((target) => target.id === tab.id)?.value;
    const active = tab.id === focusedId;
    return path ? [{ id: tab.id, sessionId, name: tab.label, path, active }] : [];
  }), [tabs, transcriptTargets, sessionId, focusedId]);
  useControlOpenFiles(openFiles);
  const isBrowserAvailable = Boolean(getElectronBrowser());

  const { createTab, closeTab, selectTab, reorderTabs } = useSidePanelTabs(sessionId);
  const closeDocumentTab = React.useCallback((tab: PanelTabEntry) => {
    const source = panes.find(pane => pane.tabIds.includes(tab.id));
    closeTab(tab);
    const next = usePanelTabStore.getState().sessions[sessionId];
    if (!source || !next || next.tabs.some(entry => entry.id === tab.id) || focusedId !== tab.id) return;
    const replacement = next.panes.find(pane => pane.id === source.id) ??
      siblingPaneIds(tree, source.id).flatMap(id => next.panes.filter(pane => pane.id === id))[0];
    setFocusedTabId(replacement?.activeTabId ?? next.activeTabId);
  }, [closeTab, focusedId, panes, sessionId, tree]);
  const moveToPane = React.useCallback((tabId: string, pane: string, split?: DocumentDropEdge) => {
    const store = usePanelTabStore.getState();
    const before = store.sessions[sessionId];
    store.moveTab(sessionId, tabId, pane, split);
    const next = usePanelTabStore.getState().sessions[sessionId];
    if (next !== before && next?.panes.some(pane => pane.activeTabId === tabId)) setFocusedTabId(tabId);
    else if (split && before?.panes.length >= MAX_DOCUMENT_PANES) toast.info(t("side_panel.pane_limit", { count: MAX_DOCUMENT_PANES }));
  }, [sessionId]);
  const [draggingTabId, setDraggingTabId] = React.useState<string | null>(null);
  React.useEffect(() => {
    const stop = () => setDraggingTabId(null);
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
    window.addEventListener("drop", stop);
    window.addEventListener("dragend", stop);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("drop", stop);
      window.removeEventListener("dragend", stop);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", cancel);
    };
  }, []);
  const draggingTab = React.useMemo<TabDrag | null>(() => {
    const pane = panes.find(pane => pane.tabIds.includes(draggingTabId ?? ""));
    return draggingTabId && pane ? { id: draggingTabId, pane: pane.id } : null;
  }, [draggingTabId, panes]);

  const selectFileAction = React.useMemo<LegalworkControlAction>(() => ({
    id: "documents.select_open", label: "Show an open file", sideEffect: "navigation", requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true }, { name: "path", type: "string", required: true }],
    execute: (args) => {
      if (typeof args !== "object" || !args || Reflect.get(args, "sessionId") !== sessionId) return { ok: false, error: "No matching sidebar for this session." };
      const file = openFiles.find((file) => file.path === Reflect.get(args, "path"));
      if (!file) return { ok: false, error: "This file is not open in the sidebar." };
      const visible = panes.some(pane => pane.activeTabId === file.id);
      if (!visible) {
        const session = usePanelTabStore.getState().sessions[sessionId];
        const replaced = session?.panes.find(pane => pane.tabIds.includes(file.id))?.activeTabId ?? null;
        if (!confirmDiscardSessionDocuments(sessionId, [replaced], () => false)) return { ok: false, error: "Save the current draft before switching files." };
      }
      setFocusedTabId(file.id);
      selectTab(file.id);
      const session = usePanelTabStore.getState().sessions[sessionId];
      if (!session?.panes.some(pane => pane.activeTabId === file.id)) return { ok: false, error: "The file could not be selected." };
      return { ok: true, file: { ...file, active: true }, message: "Read the document after the editor finishes loading." };
    },
  }), [openFiles, sessionId, selectTab, panes]);
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
      const pane = panes.find(pane => pane.activeTabId === focusedId) ?? panes[0];
      const paneTabs = tabs.filter(tab => pane.tabIds.includes(tab.id));
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab" || paneTabs.length < 2) return;
      const index = paneTabs.findIndex(tab => tab.id === pane.activeTabId);
      event.preventDefault();
      const next = paneTabs[(index + (event.shiftKey ? -1 : 1) + paneTabs.length) % paneTabs.length];
      selectTab(next.id); setFocusedTabId(next.id);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [panes, tabs, focusedId, selectTab]);

  const portaledHeader = expanded ? null : headerTarget;
  const [liveSizes, setLiveSizes] = React.useState<Record<string, Record<string, number>>>({});
  const topPaneIds = topLayoutLeaves(tree);
  const controlsPane = topPaneIds[topPaneIds.length - 1];
  const orderedPanes = layoutLeaves(tree).flatMap(id => panes.filter(pane => pane.id === id));
  const workspaceControls = <div className="ml-auto flex shrink-0">
    <Button variant="ghost" size="icon-sm" onClick={() => setExpanded(!expanded)} aria-label={expanded ? t("side_panel.restore_workspace") : t("side_panel.expand_workspace")} title={expanded ? t("side_panel.restore_workspace") : t("side_panel.expand_workspace")}>
      {expanded ? <Minimize2 /> : <Maximize2 />}
    </Button>
    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("side_panel.close_preview")} title={t("side_panel.close_preview")}><X /></Button>
  </div>;

  const strip = (pane: DocumentPaneState, docked = false) => {
    const paneTabs = tabs.filter(tab => pane.tabIds.includes(tab.id));
    const canMove = panes.length > 1 || paneTabs.length > 1;
    return <TabDropZone pane={pane.id} dragging={draggingTab} label={t("side_panel.drop_to_move_here")} onDrop={id => moveToPane(id, pane.id)} onFileDrop={openFilesInViewer} className={cn("shrink-0 titlebar-no-drag", docked ? "h-full" : "bg-muted/35")}>
      <div className={cn("flex items-center gap-1 px-2", docked ? "h-full" : "h-11 border-b border-border/70")}>
        <div className="no-scrollbar min-w-0 overflow-x-auto">
          <PanelTabList values={paneTabs.map(tab => tab.id)} onReorder={reorderTabs}>
            {paneTabs.map(tab => <SidePanelTab key={tab.id} tab={tab} pane={pane.id} destinations={orderedPanes} canSplit={panes.length < MAX_DOCUMENT_PANES && paneTabs.length > 1} active={pane.activeTabId === tab.id} canMove={canMove}
              onSelect={id => { selectTab(id); setFocusedTabId(id); }} onClose={closeDocumentTab} onMove={moveToPane} onSplit={(id, split) => moveToPane(id, pane.id, split)} onDragChange={setDraggingTabId} />)}
          </PanelTabList>
        </div>
        {pane.id === panes[0].id && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("side_panel.new_tab")} title={t("side_panel.new_tab")}><Plus /></Button>} />
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!client || !workspaceId || Boolean(openingFile)} onClick={() => fileInputRef.current?.click()}><FolderInput /> {t("side_panel.files")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!isBrowserAvailable} onClick={() => createTab()}><Globe /> {t("side_panel.browser")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
        {pane.id === controlsPane && workspaceControls}
      </div>
    </TabDropZone>;
  };
  const content = (pane: DocumentPaneState) => {
    const tab = tabs.find(tab => tab.id === pane.activeTabId);
    const relocating = draggingTab && draggingTab.pane !== pane.id && panes.find(source => source.id === draggingTab.pane)?.tabIds.length === 1;
    const sameLoneTab = draggingTab?.pane === pane.id && pane.tabIds.length === 1;
    return <TabDropZone pane={pane.id} dragging={draggingTab} edge={Boolean(tab) && !sameLoneTab} splitBlocked={panes.length >= MAX_DOCUMENT_PANES && !relocating} inset
      label={t("side_panel.drop_to_move_here")} onDrop={(id, split) => moveToPane(id, pane.id, split)} onFileDrop={openFilesInViewer} className="flex min-h-0 flex-1 flex-col">
      {tab?.type === "browser" ? <BrowserPanelContent tab={tab} onClose={onClose} />
        : tab?.type === "artifact" ? <div ref={destinationRef(pane.id)} className="min-h-0 flex-1 overflow-hidden" />
        : tab?.type === "task" ? <TaskPanel projects={projects} sessionId={sessionId} tab={tab} client={client} workspaceId={workspaceId} onClose={() => closeDocumentTab(tab)} />
        : tab?.type === "workflow" ? <WorkflowEditorPanel key={tab.id} id={tab.id} onClose={() => closeDocumentTab(tab)} />
        : tab?.type === "workflow-resource" ? <WorkflowResourceEditorPanel key={tab.id} id={tab.id} onClose={() => closeDocumentTab(tab)} />
        : <PanelEmpty />}
    </TabDropZone>;
  };
  const renderLayout = (node: DocumentLayoutNode): React.ReactNode => {
    if (node.type === "pane") {
      const pane = panes.find(pane => pane.id === node.id);
      if (!pane) return null;
      return <div className="flex h-full min-h-0 min-w-0 flex-col" data-document-pane={pane.id}>
        {portaledHeader && topPaneIds.includes(pane.id) ? null : strip(pane)}
        {content(pane)}
      </div>;
    }
    return <ResizablePanelGroup key={`${node.id}:${node.first.id}:${node.second.id}`} orientation={node.direction} defaultLayout={session.sizes[node.id]}
      onLayoutChange={next => setLiveSizes(current => ({ ...current, [node.id]: next }))}
      onLayoutChanged={next => usePanelTabStore.getState().setPaneSizes(sessionId, node.id, next)}>
      <ResizablePanel id={node.first.id} minSize="15%">{renderLayout(node.first)}</ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id={node.second.id} minSize="15%">{renderLayout(node.second)}</ResizablePanel>
    </ResizablePanelGroup>;
  };
  const renderHeader = (node: DocumentLayoutNode): React.ReactNode => {
    if (node.type === "pane") {
      const pane = panes.find(pane => pane.id === node.id);
      return pane ? strip(pane, true) : null;
    }
    if (node.direction === "vertical") return renderHeader(node.first);
    const live = liveSizes[node.id];
    const sizes = live?.[node.first.id] !== undefined && live?.[node.second.id] !== undefined ? live : session.sizes[node.id];
    const first = sizes?.[node.first.id] ?? 50;
    return <div className="flex h-full min-w-0">
      <div className="h-full min-w-0" style={{ width: `${first}%` }}>{renderHeader(node.first)}</div>
      <div className="h-full min-w-0 border-l border-border/70" style={{ width: `${100 - first}%` }}>{renderHeader(node.second)}</div>
    </div>;
  };

  return <TooltipProvider delay={1000}>
    <div data-viewer-drop-target data-document-layout="free" data-document-workspace-expanded={expanded} className={cn("flex h-full min-h-0 flex-col bg-background", expanded ? "fixed inset-0 z-40 mac:top-11" : "relative")}>
      {expanded && <ExpandedDocumentBar label={t("side_panel.restore_workspace")} onRestore={() => setExpanded(false)} />}
      <input ref={fileInputRef} type="file" multiple className="hidden" aria-label={t("side_panel.open_in_viewer")} onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
        void openFilesInViewer({ workspace: null, storage: null, memory: null, files });
      }} />
      {openingFile && <div role="status" className="pointer-events-none absolute bottom-4 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs shadow-sm">
        <Loader2 className="size-4 shrink-0 animate-spin" /><span className="truncate">{t("side_panel.opening_file", { name: openingFile })}</span>
      </div>}
      {portaledHeader && <PanelHeaderPortal target={portaledHeader}>{renderHeader(tree)}</PanelHeaderPortal>}
      <div className="min-h-0 flex-1">{renderLayout(tree)}</div>
      {tabs.flatMap(tab => {
        const pane = panes.find(pane => pane.activeTabId === tab.id);
        if (tab.type !== "artifact" || !pane) return [];
        return [<DocumentPane key={`${workspaceId}:${sessionId}:${tab.id}`} destination={destinations[pane.id] ?? null}>
          <ControlActionScope active={tab.id === focusedId}><div className="h-full" onFocusCapture={() => setFocusedTabId(tab.id)} onPointerDownCapture={() => setFocusedTabId(tab.id)}>
            <ArtifactPanel sessionId={sessionId} tab={tab} client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} isRemoteWorkspace={isRemoteWorkspace} onClose={() => closeDocumentTab(tab)} />
          </div></ControlActionScope>
        </DocumentPane>];
      })}
    </div>
  </TooltipProvider>;
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
