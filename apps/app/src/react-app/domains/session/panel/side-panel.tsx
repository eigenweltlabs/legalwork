/** @jsxImportSource react */
import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  FolderInput,
  Loader2,
  Plus,
  PanelsTopLeft,
  RotateCw,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useDragControls } from "motion/react";

import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { PanelTab, PanelTabClose, PanelTabItem, PanelTabList } from "@/components/panel-tabs";
import { toast } from "@/components/ui/sonner";
import { useQueryClient } from "@tanstack/react-query";
import { importViewerFile } from "./import-viewer-file";
import { type LegalMemoryFileDragItem, hasLegalMemoryFileDrag, readLegalMemoryFileDrag, materializeLegalMemoryFile } from "@/app/lib/legalmemory-file";
import { classifyOpenTarget } from "../artifacts/open-target";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PanelEmptyState } from "@/react-app/design-system/panel-chrome";

import { ArtifactIcon } from "../artifacts/artifact-icon";
import { confirmDiscardDocuments } from "../artifacts/docx-document-state";
import { MailAttachmentPreview } from "../artifacts/mail-attachment-preview";
import { ArtifactPanel } from "../artifacts/artifact-panel";
import {
  type BrowserPanelTab,
  usePanelTabStore,
  type PanelTab as PanelTabEntry,
  useActivePanelTab,
  useSessionPanelState,
} from "./panel-tab-store";
import { useControlOpenFiles, useControlAction, type LegalworkControlAction } from "../../../shell/control/control-provider";
import type { OpenTarget } from "../artifacts/open-target";
import { useSidePanelTabs } from "./use-side-panel-tabs";
import { t } from "@/i18n";
import {
  computeBounds,
  getElectronBrowser,
  getNativeMenuPoint,
  hasNativeBrowserOccluder,
  sameBounds,
} from "./utils";

type SidePanelProps = {
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

type SidePanelTabProps = {
  tab: PanelTabEntry;
  active: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tab: PanelTabEntry) => void;
};

function SidePanelTab({ tab, active, onSelect, onClose }: SidePanelTabProps) {
  const dragControls = useDragControls();
  const tabRef = React.useRef<HTMLDivElement>(null);

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
      <div ref={tabRef} className="relative">
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
          title={tab.label}
          aria-label={t("side_panel.select_tab", { label: tab.label })}
        >
          {tab.type === "browser" ? (
            tab.favicon ? (
              <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
            ) : tab.status === "loading" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Globe />
            )
          ) : (
            <ArtifactIcon type={tab.preview} />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{tab.label}</span>
        </PanelTab>
        <PanelTabClose
          active={active}
          label={tab.label}
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
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/70 bg-background/80 px-2 backdrop-blur-xl">
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
  sessionId,
  client,
  workspaceId,
  workspaceRoot,
  isRemoteWorkspace = false,
  onClose,
}: SidePanelProps) {
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [fileDragActive, setFileDragActive] = React.useState(false);
  const [dropHovered, setDropHovered] = React.useState(false);
  const [copyingFile, setCopyingFile] = React.useState<string | null>(null);
  const importing = React.useRef(false);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    const start = (event: DragEvent) => {
      if (event.dataTransfer && (Array.from(event.dataTransfer.types).includes("Files") || hasLegalMemoryFileDrag(event.dataTransfer))) {
        setFileDragActive(true);
      }
    };
    const stop = () => { setFileDragActive(false); setDropHovered(false); };
    const leave = (event: DragEvent) => { if (!event.relatedTarget) stop(); };
    window.addEventListener("dragenter", start, true);
    window.addEventListener("drop", stop, true);
    window.addEventListener("dragend", stop, true);
    window.addEventListener("dragleave", leave);
    window.addEventListener("blur", stop);
    return () => {
      mounted.current = false;
      window.removeEventListener("dragenter", start, true);
      window.removeEventListener("drop", stop, true);
      window.removeEventListener("dragend", stop, true);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("blur", stop);
    };
  }, []);

  const openFilesInViewer = async (files: File[], memoryFile: LegalMemoryFileDragItem | null = null) => {
    if (!files.length && !memoryFile) return;
    if (importing.current) return;
    if (!client || !workspaceId) {
      toast.error(t("side_panel.wait_for_workspace"));
      return;
    }
    importing.current = true;
    try {
      if (memoryFile) {
        setCopyingFile(memoryFile.name);
        const result = await materializeLegalMemoryFile(client, workspaceId, memoryFile.document_id);
        usePanelTabStore.getState().openTab(sessionId, {
          id: `file:${result.path}`, type: "artifact", label: memoryFile.name,
          value: result.path, preview: classifyOpenTarget(result.path, "file"),
        });
      } else {
        for (const file of files) {
          if (mounted.current) setCopyingFile(file.name);
          try {
            const tab = await importViewerFile(client, workspaceId, file);
            usePanelTabStore.getState().openTab(sessionId, tab);
            if (usePanelTabStore.getState().sessions[sessionId]?.activeTabId !== tab.id) break;
          } catch (error) {
            toast.error(`Could not open ${file.name}`, { description: error instanceof Error ? error.message : t("side_panel.file_copy_failed") });
          }
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
    } catch (error) {
      toast.error(t("side_panel.file_open_failed"), { description: error instanceof Error ? error.message : t("side_panel.file_copy_failed") });
    } finally {
      importing.current = false;
      if (mounted.current) setCopyingFile(null);
    }
  };

  const dropFiles = (event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files") && !hasLegalMemoryFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setFileDragActive(false);
    setDropHovered(false);
    void openFilesInViewer(Array.from(event.dataTransfer.files), readLegalMemoryFileDrag(event.dataTransfer));
  };

  const { tabs } = useSessionPanelState(sessionId);
  const activeTab = useActivePanelTab(sessionId);
  const transcriptTargets = usePanelTabStore((state) => state.transcriptArtifactTargets[sessionId]);
  const openFiles = React.useMemo(() => tabs.flatMap((tab) => {
    if (tab.type !== "artifact") return [];
    const path = tab.value ?? transcriptTargets?.find((target) => target.id === tab.id)?.value;
    return path ? [{ id: tab.id, sessionId, name: tab.label, path, active: tab.id === activeTab?.id }] : [];
  }), [tabs, transcriptTargets, sessionId, activeTab?.id]);
  useControlOpenFiles(openFiles);
  const isBrowserAvailable = Boolean(getElectronBrowser());

  const { createTab, closeTab, selectTab, reorderTabs } = useSidePanelTabs(sessionId);

  const selectFileAction = React.useMemo<LegalworkControlAction>(() => ({
    id: "documents.select_open", label: "Show an open file", sideEffect: "navigation", requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true }, { name: "path", type: "string", required: true }],
    execute: (args) => {
      if (typeof args !== "object" || !args || Reflect.get(args, "sessionId") !== sessionId) return { ok: false, error: "No matching sidebar for this session." };
      const file = openFiles.find((file) => file.path === Reflect.get(args, "path"));
      if (!file) return { ok: false, error: "This file is not open in the sidebar." };
      if (!file.active && !confirmDiscardDocuments(undefined, () => false)) return { ok: false, error: "Save the current draft before switching files." };
      selectTab(file.id);
      if (usePanelTabStore.getState().sessions[sessionId]?.activeTabId !== file.id) return { ok: false, error: "The file could not be selected." };
      return { ok: true, file: { ...file, active: true }, message: "Read the document after the editor finishes loading." };
    },
  }), [openFiles, sessionId, selectTab]);
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
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab" || tabs.length < 2) {
        return;
      }

      const activeIndex = activeTab ? tabs.findIndex((tab) => tab.id === activeTab.id) : -1;
      if (activeIndex === -1) {
        return;
      }

      event.preventDefault();
      const offset = event.shiftKey ? -1 : 1;
      selectTab(tabs[(activeIndex + offset + tabs.length) % tabs.length].id);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, selectTab, tabs]);

  return (
    <TooltipProvider delay={1000}>
      <div
        data-viewer-drop-target
        className="relative flex h-full min-h-0 flex-col bg-background/90"
        onDragOverCapture={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files") && !hasLegalMemoryFileDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = importing.current ? "none" : "copy";
          setDropHovered(true);
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropHovered(false);
        }}
        onDropCapture={(event) => void dropFiles(event)}
      >
        <AnimatePresence>
          {fileDragActive || copyingFile ? (
            <motion.div
              key="file-drop"
              data-viewer-drop-overlay
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 p-5 backdrop-blur-sm"
            >
              <motion.div
                animate={{ scale: dropHovered ? 1.02 : 1 }}
                className={`flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center ${dropHovered ? "border-primary bg-primary/5" : "border-border bg-muted/30"}`}
                role="status" aria-live="polite"
              >
                {copyingFile ? <Loader2 className="size-8 animate-spin text-primary" /> : <FolderInput className="size-8 text-primary" />}
                <p className="text-sm font-medium">{copyingFile ? "Creating a working copy…" : "Drop files to open"}</p>
                <p className="max-w-full truncate text-xs text-muted-foreground">{copyingFile ?? "Copies go into the workspace. Originals stay intact."}</p>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div className="shrink-0 border-b border-border/70 bg-muted/35 backdrop-blur-xl">
          <div className="flex h-12 items-center gap-1 px-2">
            <div className="no-scrollbar min-w-0 overflow-x-auto">
              <PanelTabList
                values={tabs.map((tab) => tab.id)}
                onReorder={reorderTabs}
              >
                {tabs.map((tab) => (
                  <SidePanelTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTab?.id}
                    onSelect={selectTab}
                    onClose={closeTab}
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
                void openFilesInViewer(files);
              }}
            />
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("side_panel.new_tab")} title={t("side_panel.new_tab")}><Plus /></Button>} />
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!client || !workspaceId || Boolean(copyingFile)} onClick={() => fileInputRef.current?.click()}>
                  <FolderInput /> {t("side_panel.files")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!isBrowserAvailable} onClick={() => createTab()}>
                  <Globe /> {t("side_panel.browser")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {!activeTab ? (
              <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} aria-label={t("side_panel.close_preview")}>
                <X />
              </Button>
            ) : null}
          </div>
        </div>
        {!activeTab ? (
          <PanelEmpty />
        ) : null}
        {activeTab?.type === "browser" ? (
          <BrowserPanelContent tab={activeTab} onClose={onClose} />
        ) : activeTab?.type === "artifact" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab.mailSourceId ? <MailAttachmentPreview sourceId={activeTab.mailSourceId} /> : <ArtifactPanel
              sessionId={sessionId}
              tab={activeTab}
              client={client}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              isRemoteWorkspace={isRemoteWorkspace}
              onClose={onClose}
            />}
          </div>
        ) : null}
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
