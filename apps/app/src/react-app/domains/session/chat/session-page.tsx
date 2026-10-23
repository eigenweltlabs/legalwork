import { openWikiProjectPicker } from "../../wiki/wiki-project-files-dialog";
import { sessionDeleteError } from "../../views/session-view-delete";
import { viewPanelTab } from "../../views/view-reference";
import { ProjectDashboards } from "../../views/project-dashboards";
import { workflowsPanelKey } from "../panel/panel-scope";
import { WorkspaceWindowButton } from "../panel/workspace-window-button";
import { WorkspaceTabDropTarget } from "../sidebar/workspace-tab-drop-target";
import { ProjectFileProvider } from "../../workspace/project-file-context";
import { isSessionListed, useSessionListRevision } from "../sidebar/session-list-visibility";
import { ProjectFilesPage } from "../../workspace/project-files-page";
import { ProjectSessionsPage } from "../../workspace/project-sessions-page";
import { workspaceViewRoute } from "../../../shell/workspace-routes";
import { PanelTabDestinationProvider } from "../panel/panel-tab-destination";
import { WorkspaceViewMenu } from "../panel/workspace-view-menu";
import { openWorkspaceWindow, restoreWorkspaceWindow } from "../panel/workspace-window";
import { chatPanelTab, projectViewTab, type ProjectView } from "../panel/panel-tab-store";
import { projectViewLabel } from "../panel/side-panel";
import { WindowMenubar } from "@/react-app/shell/window-menubar";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import { useSearchNavigation } from "@/react-app/shell/search-navigation";
import { ProjectReviews } from "../../reviews/project-reviews";
import { ProjectsPage } from "../../workspace/projects-page";
import { ProjectHome } from "../../workspace/project-home";
import { ProjectPersonalisationProvider } from "../../workspace/project-personalisation-modal";
/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Columns2, Folder, MessageSquare, PanelsTopLeft, Plus, Settings2, X, Zap } from "lucide-react";

import { t } from "../../../../i18n";
import {
  type LegalworkServerClient,
  type LegalworkServerStatus,
  type LegalworkWorkspaceDirectoryEntry,
  type LegalMemoryTreeFile,
} from "../../../../app/lib/legalwork-server";
import { materializeLegalMemoryFile } from "../../../../app/lib/legalmemory-file";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { BootPhase } from "../../../../app/lib/startup-boot";
import { desktopBridge, openDesktopPath, openDesktopUrl, revealDesktopItemInDir, type WorkspaceInfo } from "../../../../app/lib/desktop";
import type {
  PendingPermission,
  PendingQuestion,
  ProviderListItem,
  TodoItem,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import ProviderAuthModal, { type ProviderAuthModalProps } from "../../connections/provider-auth/provider-auth-modal";
import { RenameSessionModal } from "../modals/rename-session-modal";
import { AppSidebar } from "../sidebar/app-sidebar";
import { AssistantIdentity } from "../sidebar/assistant-identity";
import { AssistantAttentionPanel } from "../sidebar/assistant-attention-panel";
import { useSessionManagementStore } from "../sidebar/session-management-store";
import { type SessionSurfaceProps } from "../surface/session-surface";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { StatusBar, type StatusBarProps } from "./status-bar";
import { OwDotTicker } from "../../../shell/dot-ticker";
import { NotificationBell } from "../../../shell/notification-center";
import { useReactRenderWatchdog } from "../../../shell/react-render-watchdog";
import { navigationTab } from "../../../shell/panel-navigation-history";
import { usePanelNavigationHistory } from "../../../shell/use-panel-navigation-history";
import { useShellConfig, type ShellNavKey } from "../../../shell/shell-config";
import { readWikiNavigationWidth, writeWikiNavigationWidth, readWikiNavigationOpen, writeWikiNavigationOpen } from "../../../shell/session-memory";
import { wikiWorkspaceRoute, workspaceSessionRoute, workspaceProjectRoute, workspaceReviewsRoute, workspaceTasksRoute, workspaceCalendarRoute } from "../../../shell/workspace-routes";
import { type SidePanelItem, useUiStateStore } from "../../../shell/ui-state-store";

import { isElectronRuntime } from "../../../../app/utils";
import { classifyOpenTarget, isCollectibleArtifactTarget, isLocalhostBrowserTarget, isOpenableFileTarget, resolvePathOpenTarget, type OpenTarget } from "../artifacts/open-target";
import { attachmentFilename } from "@/app/lib/attachment-filename";
import { confirmDiscardSessionDocuments } from "../artifacts/docx-document-state";
import type { OpenTargetOptions } from "@/lib/target-provider";
import { SidePanel } from "../panel/side-panel";
import { DocumentPane } from "../panel/document-pane";
import { WorkspaceChat } from "./workspace-chat";
import { WorkspaceFilesPanel } from "../panel/workspace-files-panel";
import { FileSidebars } from "../panel/file-sidebars";
import { MemoryDriveIcon } from "../panel/memory-drive-icon";
import { LegalMemoryFilesPanel } from "../panel/legalmemory-files-panel";
import type { WikiVault } from "@legalwork/types/wiki";
import { WikiPagePicker } from "../../wiki/wiki-page-picker";
import { WikiPane, type WikiPaneProps } from "../../wiki/wiki-pane";
import { wikiPanelTab, wikiTabForFileTarget, type WikiPanelTab } from "../../wiki/wiki-tabs";
import { TerminalDock } from "../terminal/terminal-dock";
import {
  EVALS_PANEL_SESSION_ID,
  PANEL_OPEN_TAB_EVENT,
  useActivePanelTab,
  useSessionPanelState,
  workspacePanelKey,
  usePanelTabStore,
  type PanelTab,
} from "../panel/panel-tab-store";
import { storageFileTab } from "../panel/storage-file-tab";
import type { StorageEntry, StorageRoot } from "@legalwork/types/file-storage";
import { useWorkspaceShellLayout } from "../../../shell/workspace-shell-layout";
import { ControlActionScope, useControlAction, type LegalworkControlAction } from "../../../shell/control/control-provider";
import { cn } from "@/lib/utils";
import "@/components/chat/session-surfaces.css";
import { ChatWorkspaceContext } from "@/components/chat/chat-workspace-context";
import { WelcomeSurface } from "@/components/chat/session-welcome";
import { TaskSuggestionCards } from "@/components/chat/task-suggestions";

const STARTUP_SKELETON_ROWS = [
  { id: "intro", titleWidth: "42%", bodyWidth: "88%" },
  { id: "middle", titleWidth: "56%", bodyWidth: "88%" },
  { id: "final", titleWidth: "36%", bodyWidth: "74%" },
];
const GLOBAL_VOICE_SIDE_PANEL_KEY = "__legalwork_voice__";
const EMPTY_TRANSCRIPT_TARGETS: OpenTarget[] = [];

export type OpenSessionTab = {
  workspaceId: string;
  sessionId: string;
};

type StatusBarOverrides = Pick<
  StatusBarProps,
  | "loading"
  | "showSettingsButton"
  | "settingsOpen"
>;

export type SessionPageHistoryControls = {
  canUndo: boolean;
  canRedo: boolean;
  busyAction: "undo" | "redo" | null;
  onUndo: () => void | Promise<void>;
  onRedo: () => void | Promise<void>;
};

export type SessionPageSidebarProps = {
  onOpenSearch?: () => void;
  onShowChats?: () => void;
  onNewChat?: () => void;
  onOpenAssistant?: () => void;
  assistantProfile?: AssistantProfile;
  assistantWorkspaceId?: string;
  onSaveAssistantProfile?: (profile: AssistantProfile) => Promise<void>;
  assistantActive?: boolean;
  assistantGreetingUnread?: boolean;
  assistantDisabled?: boolean;
  onShowProjects?: () => void;
  onShowWikis?: () => void;
  onShowEvals?: () => void;
  onShowWorkflows?: () => void;
  onShowExtensions?: () => void;
  onShowFileStorage?: () => void;
  onShowRecorder?: () => void;
  /** Omitted when the firm's plan has no intake, which hides the nav row. */
  onShowTasks?: () => void;
  activeNav?: "wikis" | "scheduled" | "calendar" | "evals" | "workflows" | "extensions" | "recorder" | "tasks" | null;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  developerMode: boolean;
  sessionStatusById: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newChatDisabled: boolean;
  sidebarHydratedFromCache: boolean;
  startupPhase: BootPhase;
  onSelectWorkspace: (workspaceId: string, options?: { navigate?: boolean }) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onPrefetchSession?: (workspaceId: string, sessionId: string) => void;
  onCreateChatInWorkspace: (workspaceId: string, options?: { paneId?: string }) => void | string | Promise<string | void>;
  onCreateChatWithPrompt?: (workspaceId: string, prompt: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
  onCreateChatInNewWorkspace: () => void;
  onReorderWorkspaces?: (workspaceIds: string[]) => void;
};

export type SessionPageSurfaceProps = Omit<
  SessionSurfaceProps,
  "client" | "workspaceId" | "sessionId" | "opencodeBaseUrl" | "legalworkToken"
>;

export type SessionPageProps = {
  selectedSessionId: string | null;
  selectedWorkspaceId: string;
  selectedWorkspaceDisplay: {
    id?: string;
    name?: string;
    displayName?: string;
    workspaceType?: WorkspaceInfo["workspaceType"];
  };
  selectedWorkspaceRoot: string;
  selectedWorkspaceError?: string | null;
  runtimeWorkspaceId: string | null;
  /**
   * Pre-built OpenCode SDK base URL for the selected workspace's owning
   * server. The parent route resolves this through `resolveWorkspaceEndpoint`
   * so we never compose `<baseUrl>/workspace/<id>/opencode` here.
   */
  opencodeBaseUrl?: string | null;
  workspaces: WorkspaceInfo[];
  clientConnected: boolean;
  legalworkServerStatus: LegalworkServerStatus;
  legalworkServerClient: LegalworkServerClient | null;
  environmentClient?: LegalworkServerClient | null;
  legalworkServerToken?: string | null;
  developerMode: boolean;
  headerStatus: string;
  busyHint: string | null;
  startupPhase: BootPhase;
  providerConnectedIds: string[];
  /** Connected providers that can actually serve a model right now. */
  providerConnectedCount?: number;
  providers?: ProviderListItem[];
  mcpConnectedCount: number;
  onOpenSettings: () => void;
  sidebar: SessionPageSidebarProps;
  surface?: SessionPageSurfaceProps | null;
  history?: SessionPageHistoryControls | null;
  todos: TodoItem[];
  sessionLoadingById: (sessionId: string | null) => boolean;
  providerAuthModal?: ProviderAuthModalProps | null;
  /**
   * A full-window screen covers the page (the plan screen): hide the macOS
   * titlebar sidebar toggle, which otherwise stays clickable above it.
   */
  titlebarControlsHidden?: boolean;
  activePermission?: PendingPermission | null;
  permissionReplyBusy?: boolean;
  respondPermission?: (requestID: string, reply: "once" | "always" | "reject") => void;
  safeStringify?: (value: unknown) => string;
  activeQuestion?: PendingQuestion | null;
  questionReplyBusy?: boolean;
  respondQuestion?: (requestID: string, answers: string[][]) => void;
  onOpenInteractionSession?: (sessionId: string) => void;
  statusBar?: Partial<StatusBarOverrides>;
  notFoundMessage?: string | null;
  onOpenProviderAuth?: () => void;
  onRenameSession?: (sessionId: string, title: string) => Promise<void> | void;
  onDeleteSession?: (sessionId: string) => Promise<void> | void;
  onArchiveSession?: (sessionId: string, archived: boolean) => Promise<void> | void;
  onAccessibleTargetsChange?: (targets: OpenTarget[]) => void;
  /** When set, replaces the session main pane (keeps the sidebar). Used for the Evals screen. */
  mainView?: React.ReactNode;
  /** Live workflow service host, also needed when returning to an open editor. */
  workflowLibraryView?: React.ReactNode;
  wiki?: WikiPaneProps;
  wikiWorkspace?: WikiVault;
  /** File sources remain available when wiki navigation hides the project list. */
  fileWorkspaceGroups?: WorkspaceSessionGroup[];
  projectsPage?: boolean;
  homePage?: boolean;
  projectPage?: ProjectView;
  onRenameProject?: (name: string) => Promise<boolean>;
  projectTasksView?: React.ReactNode | ((embedded: boolean, inWorkspace: boolean) => React.ReactNode);
  projectCalendarView?: React.ReactNode;
  onStartProjectRecording: () => void;
  onCreateProjectSession?: (shareRecording: boolean) => void | Promise<void>;
  terminalOpen?: boolean;
  onTerminalOpenChange?: (open: boolean) => void;
  onSessionTabsChange?: (tabs: OpenSessionTab[]) => void;
};

function getSidebarInitialLoading(props: SessionPageSidebarProps) {
  if (props.workspaceSessionGroups.some((group) => group.sessions.length > 0)) {
    return false;
  }
  if (props.sidebarHydratedFromCache) return false;
  if (
    props.startupPhase !== "sessionIndexReady" &&
    props.startupPhase !== "firstSessionReady" &&
    props.startupPhase !== "ready"
  ) {
    return true;
  }
  return props.workspaceSessionGroups.some(
    (group) => group.status === "loading" || group.status === "idle",
  );
}

function sessionTitleForId(groups: WorkspaceSessionGroup[], id: string | null | undefined) {
  if (!id) return "";
  const sessionsById = new Map(groups.flatMap((group) => group.sessions.map((session) => [session.id, session] as const)));
  const match = sessionsById.get(id);
  return match ? getDisplaySessionTitle(match.title) : "";
}



function isTrackableAccessibleTarget(target: OpenTarget) {
  return isOpenableFileTarget(target) || isLocalhostBrowserTarget(target);
}

function absoluteWorkspacePath(root: string | null | undefined, value: string) {
  const target = value.trim();
  if (!target) return "";
  if (/^file:\/\//i.test(target)) {
    try {
      const pathname = new URL(target).pathname;
      return /^\/[a-zA-Z]:/.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return target.replace(/^file:\/\//i, "");
    }
  }
  if (target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(target)) return target;
  const cleanRoot = root?.trim().replace(/[/\\]+$/, "") ?? "";
  const cleanTarget = target.replace(/^[.][\\/]/, "");
  return cleanRoot ? `${cleanRoot}/${cleanTarget}` : cleanTarget;
}

function hiddenAccessibleTargetsStorageKey(workspaceId: string | null | undefined, sessionId: string | null | undefined) {
  if (!workspaceId || !sessionId) return null;
  return `legalwork.session.hiddenAccessibleTargets.v1:${workspaceId}:${sessionId}`;
}

function readHiddenAccessibleTargetIds(workspaceId: string | null | undefined, sessionId: string | null | undefined): Set<string> {
  const key = hiddenAccessibleTargetsStorageKey(workspaceId, sessionId);
  if (!key || typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function writeHiddenAccessibleTargetIds(workspaceId: string | null | undefined, sessionId: string | null | undefined, ids: Set<string>) {
  const key = hiddenAccessibleTargetsStorageKey(workspaceId, sessionId);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore storage failures
  }
}

function controlObjectArg(args: unknown) {
  return args && typeof args === "object" && !Array.isArray(args) ? args : null;
}

function controlStringArg(args: unknown, key: string) {
  const object = controlObjectArg(args);
  const value = object ? Reflect.get(object, key) : null;
  return typeof value === "string" ? value.trim() : "";
}

export function SessionPage(props: SessionPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const wikiWorkspace = props.wikiWorkspace;
  const [wikiNavigationStates, setWikiNavigationStates] = useState<Record<string, boolean>>({});
  const wikiNavigationOpen = wikiWorkspace ? wikiNavigationStates[wikiWorkspace.workspaceId] ?? readWikiNavigationOpen(wikiWorkspace.workspaceId) : false;
  const toggleWikiNavigation = () => {
    if (!wikiWorkspace) return;
    const id = wikiWorkspace.workspaceId;
    const open = !wikiNavigationOpen;
    writeWikiNavigationOpen(id, open);
    setWikiNavigationStates(current => ({ ...current, [id]: open }));
  };
  const [wikiPickerPane, setWikiPickerPane] = useState<string | null>(null);
  const hasMainView = Boolean(props.mainView || props.projectsPage || props.projectPage);
  const { config: shellConfig } = useShellConfig();
  const queryClient = useQueryClient();
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStateStore((state) => state.setSidebarOpen);
  const topLevelPage = Boolean(props.projectsPage || props.sidebar.activeNav);
  const chatSidebarOpen = sidebarOpen && !topLevelPage;
  // A project window owns one layout, independently of the currently focused chat.
  const panelStateSessionId = props.sidebar.activeNav === "evals" ? EVALS_PANEL_SESSION_ID : workspacePanelKey(props.selectedWorkspaceId);
  const workspaceScope = workspacePanelKey(props.selectedWorkspaceId);
  const assistantWorkspace = props.sidebar.assistantWorkspaceId === props.selectedWorkspaceId || Boolean(props.sidebar.assistantActive);
  useEffect(() => {
    if (assistantWorkspace) usePanelTabStore.getState().setAssistantWorkspace(props.selectedWorkspaceId);
  }, [assistantWorkspace, props.selectedWorkspaceId]);
  useEffect(() => setWikiPickerPane(null), [workspaceScope]);
  const workspacePanel = useSessionPanelState(workspaceScope);
  const controlSessionIds = useMemo(() => workspacePanel.tabs.flatMap(tab => tab.type === "chat" ? [tab.sessionId] : []), [workspacePanel.tabs]);
  const [overviewHost, setOverviewHost] = useState<HTMLDivElement | null>(null);
  const [overviewVisits, setOverviewVisits] = useState<{ workspaceId: string; views: ProjectView[] }>({ workspaceId: props.selectedWorkspaceId, views: [] });
  const visitedOverviews = overviewVisits.workspaceId === props.selectedWorkspaceId ? overviewVisits.views : [];
  useEffect(() => {
    const view = props.projectPage;
    setOverviewVisits(previous => {
      const views = previous.workspaceId === props.selectedWorkspaceId ? previous.views : [];
      return { workspaceId: props.selectedWorkspaceId, views: view && !views.includes(view) ? [...views, view] : views };
    });
  }, [props.projectPage, props.selectedWorkspaceId]);
  useEffect(() => { void restoreWorkspaceWindow(props.selectedWorkspaceId).catch(() => toast.error(t("projects.open_in_new_window_failed"))); }, [props.selectedWorkspaceId]);
  const [workspaceHost, setWorkspaceHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => { usePanelTabStore.getState().migrateWorkspace(props.selectedWorkspaceId); }, [props.selectedWorkspaceId]);
  const workflowsPage = props.sidebar.activeNav === "workflows";
  const workflowPanel = useSessionPanelState(workflowsPanelKey(props.selectedWorkspaceId));
  // Bind from current project props, even on a direct return to an editor.
  // Caching the last visited library would lose its services on project changes.
  const workflowLibrary = workflowsPage || workflowPanel.tabs.length > 0 || workspacePanel.tabs.some(tab => tab.type === "workflow" || tab.type === "workflow-resource")
    ? props.workflowLibraryView : null;
  const [workflowLibraryHost, setWorkflowLibraryHost] = useState<HTMLDivElement | null>(null);
  const mobile = useIsMobile();
  const sessionSidePanel = useUiStateStore((state) => (
    panelStateSessionId ? state.sidePanelState[panelStateSessionId] ?? null : null
  ));
  const voiceSidePanelOpen = useUiStateStore((state) => state.sidePanelState[GLOBAL_VOICE_SIDE_PANEL_KEY] === "voice");
  const setSidePanelState = useUiStateStore((state) => state.setSidePanelState);
  const toggleSidePanelState = useUiStateStore((state) => state.toggleSidePanelState);
  const storedFileSidebar = useUiStateStore((state) => state.fileSidebarState[panelStateSessionId] ?? null);
  const fileSidebar = storedFileSidebar === "wiki" ? null : storedFileSidebar;
  const setFileSidebarState = useUiStateStore((state) => state.setFileSidebarState);
  useEffect(() => {
    const search = new URLSearchParams(location.search);
    if (props.projectPage && search.get("panel") === "files") {
      search.delete("panel");
      navigate({ pathname: workspaceViewRoute(props.selectedWorkspaceId, "files"), search: search.toString() }, { replace: true });
    }
    if (search.get("panel") === "wiki") {
      navigate("/wikis", { replace: true });
    }
  }, [props.projectPage, props.selectedWorkspaceId, location.pathname, location.search, navigate, panelStateSessionId, setFileSidebarState]);
  const openTab = usePanelTabStore((state) => state.openTab);
  const closeTab = usePanelTabStore((state) => state.closeTab);
  const transcriptTargets = usePanelTabStore((state) => (
    props.selectedSessionId ? state.transcriptArtifactTargets[props.selectedSessionId] ?? EMPTY_TRANSCRIPT_TARGETS : EMPTY_TRANSCRIPT_TARGETS
  ));
  const activePanelTab = useActivePanelTab(panelStateSessionId);
  const [hiddenTargetRevision, setHiddenTargetRevision] = useState(0);
  const hiddenAccessibleTargetIds = useMemo(
    () => readHiddenAccessibleTargetIds(props.selectedWorkspaceId, props.selectedSessionId),
    [props.selectedSessionId, props.selectedWorkspaceId, hiddenTargetRevision],
  );
  const accessibleTargets = useMemo(
    () => transcriptTargets.filter((target) => isTrackableAccessibleTarget(target) && !hiddenAccessibleTargetIds.has(target.id)),
    [hiddenAccessibleTargetIds, transcriptTargets],
  );
  // Ignore a previously persisted settings pane; settings now live at the cog.
  const activeSidePanel = sessionSidePanel === "extensions" ? null : sessionSidePanel;
  const driveOpen = fileSidebar === "memory";
  const sidePanelOpen = hasMainView && panelStateSessionId === EVALS_PANEL_SESSION_ID && activeSidePanel === "panel";
  const workflowFocusMode = workflowsPage && mobile && sidePanelOpen;
  const panelRailActive = activeSidePanel === "panel";
  const filesRailActive = fileSidebar === "files";
  const openAiProviderConnected = props.providerConnectedIds.includes("openai");
  const voiceCapabilityQuery = useQuery({
    queryKey: ["voice-realtime-capability", props.runtimeWorkspaceId, props.providerConnectedIds.join("|")],
    queryFn: () => props.legalworkServerClient!.getVoiceRealtimeCapability(),
    enabled: Boolean(props.legalworkServerClient && props.runtimeWorkspaceId && props.selectedSessionId && openAiProviderConnected),
    retry: false,
    staleTime: 30_000,
    refetchInterval: voiceSidePanelOpen ? 5_000 : false,
  });
  const realtimeVoiceSupported = openAiProviderConnected && voiceCapabilityQuery.data?.supported === true;

  useReactRenderWatchdog("SessionPage", {
    selectedSessionId: props.selectedSessionId,
    selectedWorkspaceId: props.selectedWorkspaceId,
    clientConnected: props.clientConnected,
    startupPhase: props.startupPhase,
    hasSurface: Boolean(props.surface),
    workspaceCount: props.workspaces.length,
  });

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [sessionActionId, setSessionActionId] = useState<string | null>(null);
  const sessionTabs = useMemo<OpenSessionTab[]>(() => workspacePanel.tabs.flatMap(tab => tab.type === "chat" ? [{ workspaceId: props.selectedWorkspaceId, sessionId: tab.sessionId }] : []), [workspacePanel.tabs, props.selectedWorkspaceId]);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [createGroupLabel, setCreateGroupLabel] = useState("");
  const [createGroupWorkspaceId, setCreateGroupWorkspaceId] = useState<string | null>(null);
  const preserveSidePanelOnPanelOpenRef = useRef(false);

  const setCurrentSidePanel = useCallback(function setPanel(panel: SidePanelItem | null) {
    if (panel === "files" || panel === "memory" || panel === "wiki") {
      setFileSidebarState(panelStateSessionId, panel);
      return;
    }
    if (panel === "voice") {
      setSidePanelState(GLOBAL_VOICE_SIDE_PANEL_KEY, "voice");
      return;
    }
    // Only the evaluations pane unmounts here. Workspace editors remain alive,
    // including drafts parked by other chats, so hiding chrome cannot discard them.
    if (sidePanelOpen && panel !== "panel" && !confirmDiscardSessionDocuments(panelStateSessionId, usePanelTabStore.getState().sessions[panelStateSessionId]?.tabs.map(tab => tab.id) ?? [], undefined, false, () => setPanel(panel))) return;
    setSidePanelState(panelStateSessionId, panel);
    if (panel === "panel" && hasMainView && panelStateSessionId !== EVALS_PANEL_SESSION_ID) {
      navigate(workspaceSessionRoute(props.selectedWorkspaceId, props.selectedSessionId) + (props.selectedSessionId ? "" : "?view=workspace"));
    }
  }, [sidePanelOpen, panelStateSessionId, setSidePanelState, setFileSidebarState, hasMainView, navigate, props.selectedWorkspaceId, props.selectedSessionId]);

  // A mainView (the Tasks pane) hands the page a file to show in the panel.
  useEffect(() => {
    const handleOpenTab = (event: Event) => {
      const tab = (event as CustomEvent<import("../panel/panel-tab-request").PanelTabRequest>).detail;
      if (!tab) return;
      const destination = "destination" in tab ? tab.destination : undefined;
      if (destination && typeof destination === "object" && "kind" in destination && destination.kind === "workflows") return;
      if (destination && typeof destination === "object" && "kind" in destination && destination.kind === "evals" && props.sidebar.activeNav !== "evals") return;
      if (hasMainView && props.sidebar.activeNav !== "evals" && !destination) return;
      const scope = destination && typeof destination === "object" && "workspaceId" in destination && typeof destination.workspaceId === "string" ? workspacePanelKey(destination.workspaceId) : panelStateSessionId;
      const pane = destination && typeof destination === "object" && "paneId" in destination && typeof destination.paneId === "string" ? destination.paneId : undefined;
      openTab(scope, tab, pane, undefined, { preview: tab.openAsPreview, besideChat: tab.openBesideChat });
      if (destination?.kind === "workspace" && ((tab.type === "artifact" && tab.pendingImportId) || (tab.type === "recording" && hasMainView))) {
        navigate(workspaceSessionRoute(destination.workspaceId) + "?view=workspace");
      }
      if (scope !== panelStateSessionId) return;
      preserveSidePanelOnPanelOpenRef.current = true;
      setCurrentSidePanel("panel");
    };
    window.addEventListener(PANEL_OPEN_TAB_EVENT, handleOpenTab);
    return () => window.removeEventListener(PANEL_OPEN_TAB_EVENT, handleOpenTab);
  }, [openTab, panelStateSessionId, setCurrentSidePanel, hasMainView, navigate, props.selectedWorkspaceId, props.selectedSessionId]);

  const closeFileSidebar = useCallback(() => {
    setFileSidebarState(panelStateSessionId, null);
  }, [panelStateSessionId, setFileSidebarState]);

  const closeVoicePanel = useCallback(() => {
    setSidePanelState(GLOBAL_VOICE_SIDE_PANEL_KEY, null);
  }, [setSidePanelState]);

  const toggleCurrentSidePanel = useCallback(function togglePanel(panel: SidePanelItem) {
    if (panel === "files" || panel === "memory" || panel === "wiki") {
      setFileSidebarState(panelStateSessionId, fileSidebar === panel ? null : panel);
      return;
    }
    if (panel === "voice") {
      toggleSidePanelState(GLOBAL_VOICE_SIDE_PANEL_KEY, "voice");
      return;
    }
    if (sidePanelOpen && !confirmDiscardSessionDocuments(panelStateSessionId, usePanelTabStore.getState().sessions[panelStateSessionId]?.tabs.map(tab => tab.id) ?? [], undefined, false, () => togglePanel(panel))) return;
    toggleSidePanelState(panelStateSessionId, panel);
  }, [sidePanelOpen, panelStateSessionId, toggleSidePanelState, fileSidebar, setFileSidebarState]);

  // A user-opened browser needs panel chrome. Closing its last tab only removes
  // that browser view; it must not close the shared workspace or other drafts.
  useEffect(() => {
    if (!isElectronRuntime()) return;
    const browser = (window as Window).__LEGALWORK_ELECTRON__?.browser;
    if (!browser) return;
    const unsubOpen = browser.onPanelOpened?.(() => {
      if (preserveSidePanelOnPanelOpenRef.current) {
        preserveSidePanelOnPanelOpenRef.current = false;
        return;
      }
      setCurrentSidePanel("panel");
    });
    return unsubOpen;
  }, [setCurrentSidePanel]);
  const {
    leftSidebarResizing,
    leftSidebarWidth,
    rightSidebarExpandedWidth: browserPanelWidth,
    startLeftSidebarResize,
  } = useWorkspaceShellLayout({
    expandedRightWidth: 520,
    minRightWidth: 320,
  });
  const [viewerHeaderWidth, setViewerHeaderWidth] = useState(browserPanelWidth);
  const [filesHeaderWidth, setFilesHeaderWidth] = useState(300);
  const [viewerHeaderTarget, setViewerHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [filesHeaderTarget, setFilesHeaderTarget] = useState<HTMLDivElement | null>(null);
  const sidebarProviderStyle: CSSProperties & Record<"--sidebar-width" | "--sidebar-width-icon", string> = {
    "--sidebar-width-icon": "var(--lw-window-left-rail-width)",
    "--sidebar-width": `calc(${leftSidebarWidth}px + var(--lw-window-left-rail-width))`,
  };
  useEffect(() => {
    props.onAccessibleTargetsChange?.(accessibleTargets);
  }, [accessibleTargets, props.onAccessibleTargetsChange]);
  const browserUrlForTarget = useCallback((target: OpenTarget) => {
    if (/^wss?:\/\//i.test(target.value)) return target.value.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
    return target.value;
  }, []);
  const downloadOpenTarget = useCallback(async (target: OpenTarget) => {
    if (target.kind !== "file" || !props.legalworkServerClient || !props.runtimeWorkspaceId) {
      return;
    }

    const result = await props.legalworkServerClient.downloadWorkspaceFile(props.runtimeWorkspaceId, target.value);
    const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = target.name;
    anchor.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [props.legalworkServerClient, props.runtimeWorkspaceId]);
  const openTarget = useCallback((target: OpenTarget, options?: OpenTargetOptions, sourceSessionId?: string) => {
    if (target.kind === "url" || target.preview === "browser") {
      const url = browserUrlForTarget(target);
      if (options?.external && isElectronRuntime()) {
        void openDesktopUrl(url);
        return;
      }
      if (isElectronRuntime()) {
        setCurrentSidePanel("panel");
        void window.__LEGALWORK_ELECTRON__?.browser?.createTab?.(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      return;
    }
    if (options?.external && target.kind === "file" && props.selectedWorkspaceDisplay.workspaceType !== "remote") {
      const path = absoluteWorkspacePath(props.selectedWorkspaceRoot, target.value);
      if (path && isElectronRuntime()) {
        void (async () => {
          try {
            if (options.reveal) {
              await revealDesktopItemInDir(path);
            } else {
              await openDesktopPath(path);
            }
          } catch {
            await revealDesktopItemInDir(path).catch(() => undefined);
          }
        })();
      }
      return;
    }

    const wikiTab = wikiWorkspace && props.wiki?.client
      ? wikiTabForFileTarget(props.wiki.serverUrl, wikiWorkspace, target) : null;
    if (wikiTab) {
      openTab(panelStateSessionId, wikiTab);
      preserveSidePanelOnPanelOpenRef.current = true;
      setCurrentSidePanel("panel");
      return;
    }

    if (!isCollectibleArtifactTarget(target)) {
      if (isOpenableFileTarget(target)) {
        if (props.selectedWorkspaceDisplay.workspaceType === "remote") {
          void downloadOpenTarget(target).catch(() => undefined);
        } else if (isElectronRuntime()) {
          void openDesktopPath(absoluteWorkspacePath(props.selectedWorkspaceRoot, target.value)).catch(() => undefined);
        }
      }
      return;
    }

    const sessionId = sourceSessionId ?? props.selectedSessionId;
    if (!sessionId) return;
    if (options?.auto && activePanelTab?.id === target.id) return;
    openTab(panelStateSessionId, {
      sourceSessionId: sessionId,
      id: target.id,
      type: "artifact",
      label: target.name,
      preview: target.preview,
      // Carry the path. The panel resolves a tab against targets derived from
      // the transcript and falls back to tab.value when it finds none — and a
      // file the app itself put in the workspace is never mentioned in the
      // transcript, so without this it resolves to nothing and renders empty.
      value: target.value,
      size: target.size,
      updatedAt: target.updatedAt,
    });
    preserveSidePanelOnPanelOpenRef.current = true;
    setCurrentSidePanel("panel");
  }, [panelStateSessionId, activePanelTab?.id, browserUrlForTarget, downloadOpenTarget, openTab, props.selectedSessionId, props.selectedWorkspaceDisplay.workspaceType, props.selectedWorkspaceRoot, props.wiki?.client, props.wiki?.serverUrl, wikiWorkspace, setCurrentSidePanel]);
  const closeRightPane = useCallback(() => {
    setCurrentSidePanel(null);
  }, [setCurrentSidePanel]);
  const openFilesRailPane = useCallback(() => {
    if (wikiWorkspace && props.selectedSessionId) { openWikiProjectPicker(props.selectedSessionId); return; }
    toggleCurrentSidePanel("files");
  }, [toggleCurrentSidePanel, wikiWorkspace, props.selectedSessionId]);
  const openWorkspaceFileEntry = useCallback((entry: LegalworkWorkspaceDirectoryEntry, permanent = false) => {
    const preview = classifyOpenTarget(entry.name, "file");
    if (preview === "external" || preview === "browser") {
      if (props.selectedWorkspaceDisplay.workspaceType !== "remote" && isElectronRuntime()) {
        void openDesktopPath(absoluteWorkspacePath(props.selectedWorkspaceRoot, entry.path)).catch(() => undefined);
      } else {
        void downloadOpenTarget({
          id: `file:${entry.path}`,
          kind: "file",
          value: entry.path,
          name: entry.name,
          preview,
          confidence: 100,
          reason: "workspace file",
          exists: true,
          size: entry.size,
          updatedAt: entry.updatedAt,
        }).catch(() => undefined);
      }
      return;
    }
    openTab(panelStateSessionId, {
      id: `file:${entry.path}`,
      type: "artifact",
      label: entry.name,
      preview,
      value: entry.path,
      size: entry.size,
      updatedAt: entry.updatedAt,
    }, undefined, undefined, { preview: !permanent });
    preserveSidePanelOnPanelOpenRef.current = true;
    setCurrentSidePanel("panel");
  }, [downloadOpenTarget, openTab, panelStateSessionId, props.selectedWorkspaceDisplay.workspaceType, props.selectedWorkspaceRoot, setCurrentSidePanel]);
  const searchTarget = useSearchNavigation(state => state.target);
  useEffect(() => {
    if (searchTarget?.kind !== "files" || !searchTarget.path || searchTarget.workspaceId !== props.selectedWorkspaceId || !props.projectPage) return;
    if (searchTarget.sources?.some(source => source.page)) {
      openTab(panelStateSessionId, { id: `search-source:${searchTarget.path}`, type: "artifact", label: searchTarget.title,
        value: searchTarget.path, preview: classifyOpenTarget(searchTarget.path, "file"), searchSources: searchTarget.sources });
      preserveSidePanelOnPanelOpenRef.current = true; setCurrentSidePanel("panel");
    } else openWorkspaceFileEntry({ name: searchTarget.title, path: searchTarget.path, kind: "file", updatedAt: searchTarget.updatedAt });
    useSearchNavigation.getState().setTarget(null);
  }, [searchTarget, props.selectedWorkspaceId, props.projectPage, openWorkspaceFileEntry, openTab, panelStateSessionId, setCurrentSidePanel]);
  const openStorageFile = useCallback((root: StorageRoot, file: StorageEntry) => {
    if (!props.runtimeWorkspaceId) return;
    const tab = storageFileTab(props.runtimeWorkspaceId, root, file);
    openTab(panelStateSessionId, tab, undefined, undefined, { preview: true });
    if (!usePanelTabStore.getState().sessions[panelStateSessionId]?.panes.some(pane => pane.activeTabId === tab.id)) return;
    preserveSidePanelOnPanelOpenRef.current = true;
    setCurrentSidePanel("panel");
  }, [openTab, panelStateSessionId, props.runtimeWorkspaceId, setCurrentSidePanel]);
  const openLegalMemoryFile = useCallback(async (file: LegalMemoryTreeFile) => {
    const client = props.legalworkServerClient;
    const workspaceId = props.runtimeWorkspaceId;
    if (!client || !workspaceId) {
      toast.error(t("session.memory_file_open_failed"), { description: t("session.workspace_not_connected") });
      throw new Error(t("session.workspace_not_connected"));
    }
    try {
      const result = await materializeLegalMemoryFile(client, workspaceId, file.document_id);
      const target = resolvePathOpenTarget(result.path, accessibleTargets, "legalmemory");
      if (!target) throw new Error(t("session.legalmemory_unusable_path"));
      queryClient.removeQueries({ queryKey: ["artifact-panel", workspaceId, target.id] });
      openTarget(target, undefined, hasMainView ? panelStateSessionId : undefined);
    } catch (error) {
      toast.error(t("session.open_failed", { name: file.name }), {
        description: error instanceof Error ? error.message : t("session.legalmemory_download_failed"),
      });
      throw error;
    }
  }, [accessibleTargets, openTarget, props.legalworkServerClient, hasMainView, panelStateSessionId, props.runtimeWorkspaceId, queryClient]);
  const removeAccessibleTarget = useCallback((target: OpenTarget) => {
    const nextHiddenIds = new Set(hiddenAccessibleTargetIds);
    nextHiddenIds.add(target.id);
    writeHiddenAccessibleTargetIds(props.selectedWorkspaceId, props.selectedSessionId, nextHiddenIds);
    setHiddenTargetRevision((value) => value + 1);
    if (props.selectedSessionId) {
      closeTab(props.selectedSessionId, target.id);
    }
  }, [closeTab, hiddenAccessibleTargetIds, props.selectedSessionId, props.selectedWorkspaceId]);
  useEffect(() => {
    const open = (event: Event) => {
      const requested = (event as CustomEvent<OpenTarget>).detail;
      const target = accessibleTargets.find((item) => item.id === requested?.id || item.value === requested?.value) ?? (
        requested?.kind && requested?.value ? requested : null
      );
      // On mainView pages (Evals / Benchmark) tabs live under the synthetic
      // panel session so the side panel can render without a chat session.
      if (target) openTarget(target, undefined, hasMainView ? panelStateSessionId : undefined);
    };
    const hide = (event: Event) => {
      const requested = (event as CustomEvent<OpenTarget>).detail;
      const target = accessibleTargets.find((item) => item.id === requested?.id || item.value === requested?.value);
      if (target) removeAccessibleTarget(target);
    };
    window.addEventListener("legalwork-open-accessible-target", open);
    window.addEventListener("legalwork-hide-accessible-target", hide);
    return () => {
      window.removeEventListener("legalwork-open-accessible-target", open);
      window.removeEventListener("legalwork-hide-accessible-target", hide);
    };
  }, [accessibleTargets, openTarget, removeAccessibleTarget, hasMainView, panelStateSessionId]);
  useEffect(() => {
    const handler = () => setCurrentSidePanel(null);
    window.addEventListener("legalwork-close-right-pane", handler);
    return () => window.removeEventListener("legalwork-close-right-pane", handler);
  }, [setCurrentSidePanel]);
  useEffect(() => {
    if (voiceSidePanelOpen && !realtimeVoiceSupported) {
      closeVoicePanel();
    }
  }, [closeVoicePanel, realtimeVoiceSupported, voiceSidePanelOpen]);
  const openVoicePanelControlAction = useMemo<LegalworkControlAction | null>(() => (
    realtimeVoiceSupported ? {
      id: "voice.panel.open",
      label: t("control.open_voice_mode"),
      description: "Open immersive Voice Mode for the current session.",
      sideEffect: "none",
      execute: () => {
        setCurrentSidePanel("voice");
        return { open: true };
      },
    } : null
  ), [realtimeVoiceSupported, setCurrentSidePanel]);
  useControlAction(openVoicePanelControlAction);

  const closeVoicePanelControlAction = useMemo<LegalworkControlAction | null>(() => (
    realtimeVoiceSupported && voiceSidePanelOpen ? {
      id: "voice.panel.close",
      label: t("control.close_voice_mode"),
      description: "Close immersive Voice Mode.",
      sideEffect: "none",
      execute: () => {
        closeVoicePanel();
        return { open: false };
      },
    } : null
  ), [closeVoicePanel, realtimeVoiceSupported, voiceSidePanelOpen]);
  useControlAction(closeVoicePanelControlAction);
  const [showDelayedSessionLoadingState, setShowDelayedSessionLoadingState] = useState(false);

  // A reload may restore a wiki page focused beside the chat named in the URL.
  const previousRouteChat = useRef<string | null>(props.sidebar.activeNav === "wikis" ? `${panelStateSessionId}:${props.selectedSessionId}` : null);
  const selectedSessionTitle = useMemo(
    () => assistantWorkspace ? props.sidebar.assistantProfile?.name ?? t("assistant.title") : sessionTitleForId(props.sidebar.workspaceSessionGroups, props.selectedSessionId),
    [props.selectedSessionId, props.sidebar.workspaceSessionGroups, assistantWorkspace, props.sidebar.assistantProfile?.name],
  );
  useEffect(() => {
    if (!assistantWorkspace) return;
    for (const tab of workspacePanel.tabs) {
      if (tab.type === "chat") usePanelTabStore.getState().updateTabLabel(workspaceScope, tab.id, selectedSessionTitle);
    }
  }, [assistantWorkspace, workspaceScope, workspacePanel.tabs, selectedSessionTitle]);
  useEffect(() => {
    if (!props.selectedSessionId || hasMainView) return;
    const store = usePanelTabStore.getState();
    const tab = store.sessions[panelStateSessionId]?.tabs.find(tab => tab.type === "chat" && tab.sessionId === props.selectedSessionId);
    const routeChat = `${panelStateSessionId}:${props.selectedSessionId}`;
    // Back/Forward may target a file beside the chat named in this route.
    const restoringTab = navigationTab(window.history.state?.usr, panelStateSessionId);
    if (tab) {
      store.updateTabLabel(panelStateSessionId, tab.id, selectedSessionTitle || tab.label);
      if (!restoringTab && previousRouteChat.current !== routeChat) store.selectTab(panelStateSessionId, tab.id);
    }
    else if (!restoringTab) store.adoptChat(panelStateSessionId, props.selectedSessionId, selectedSessionTitle || t("session.default_title"));
    previousRouteChat.current = routeChat;
  }, [panelStateSessionId, props.selectedSessionId, selectedSessionTitle, hasMainView]);
  usePanelNavigationHistory(!hasMainView || sidePanelOpen ? panelStateSessionId : null);
  useEffect(() => { props.onSessionTabsChange?.(sessionTabs); }, [sessionTabs, props.onSessionTabsChange]);
  const sessionActionTitle = useMemo(
    () => sessionTitleForId(props.sidebar.workspaceSessionGroups, sessionActionId),
    [props.sidebar.workspaceSessionGroups, sessionActionId],
  );
  const workspaceName =
    props.selectedWorkspaceDisplay.displayName?.trim() ||
    props.selectedWorkspaceDisplay.name?.trim() ||
    t("session.workspace_fallback");
  const providerCount = props.providerConnectedCount ?? props.providerConnectedIds.length;
  const messageCountVisible = props.selectedSessionId ? 1 : 0;
  const showWorkspaceSetupEmptyState = props.workspaces.length === 0 && !props.selectedSessionId;
  const showStartupSkeleton =
    !props.selectedSessionId &&
    !props.clientConnected &&
    props.startupPhase !== "sessionIndexReady" &&
    props.startupPhase !== "firstSessionReady" &&
    props.startupPhase !== "ready";
  const sidebarInitialLoading = useMemo(() => getSidebarInitialLoading(props.sidebar), [props.sidebar]);
  // Derive the main-pane error from the same data the sidebar uses so the two
  // panes can never disagree. We check (in priority order):
  // 1. selectedWorkspaceError (errorsByWorkspaceId[selectedWorkspaceId])
  // 2. workspaceConnectionStateById[selectedWorkspaceId].message (covers test/recover paths)
  // 3. group.error from workspaceSessionGroups (the same source the sidebar reads)
  const selectedWorkspaceConnectionMessage = (() => {
    const state = props.sidebar.workspaceConnectionStateById[props.selectedWorkspaceId];
    if (state?.status === "error") return state.message?.trim() ?? "";
    return "";
  })();
  const selectedWorkspaceGroupError = (() => {
    const group = props.sidebar.workspaceSessionGroups.find(
      (item) => item.workspace.id === props.selectedWorkspaceId,
    );
    return group?.error?.trim() ?? "";
  })();
  const selectedWorkspaceErrorMessage =
    props.selectedWorkspaceError?.trim() ||
    selectedWorkspaceConnectionMessage ||
    selectedWorkspaceGroupError ||
    "";
  const showSelectedWorkspaceError = Boolean(selectedWorkspaceErrorMessage);
  const selectedWorkspaceErrorTitle =
    props.selectedWorkspaceDisplay.workspaceType === "remote"
      ? "Remote workspace unavailable"
      : "OpenCode unavailable";

  const reactSessionBaseUrl = props.opencodeBaseUrl?.trim() ?? "";
  const reactSessionToken =
    props.legalworkServerToken?.trim() ||
    props.legalworkServerClient?.token?.trim() ||
    "";
  const canRenderReactSurface = Boolean(
    props.selectedSessionId &&
      props.runtimeWorkspaceId &&
      props.legalworkServerClient &&
      reactSessionBaseUrl &&
      reactSessionToken &&
      props.surface,
  );
  const canRenderWorkspace = canRenderReactSurface || Boolean(props.legalworkServerClient && props.runtimeWorkspaceId);
  // The chat owns snapshot loading once its endpoint is ready. Background
  // workspace refreshes must not unmount an already-visible conversation.
  const showSessionLoadingState = !canRenderReactSurface &&
    Boolean(props.selectedSessionId) && props.sessionLoadingById(props.selectedSessionId) && !showWorkspaceSetupEmptyState;

  const openSessionTab = useCallback((workspaceId: string, sessionId: string) => {
    const store = usePanelTabStore.getState();
    const scope = workspacePanelKey(workspaceId);
    const state = store.sessions[scope];
    const tab = state?.tabs.find(tab => tab.type === "chat" && tab.sessionId === sessionId);
    if (tab) store.selectTab(scope, tab.id);
    else {
      const title = workspaceId === props.sidebar.assistantWorkspaceId
        ? props.sidebar.assistantProfile?.name ?? t("assistant.title")
        : sessionTitleForId(props.sidebar.workspaceSessionGroups, sessionId) || t("session.default_title");
      store.adoptChat(scope, sessionId, title, { preserveLayout: true });
    }
    if (props.selectedSessionId !== sessionId || props.selectedWorkspaceId !== workspaceId || hasMainView || props.projectPage) props.sidebar.onOpenSession(workspaceId, sessionId);
  }, [props.sidebar, props.selectedSessionId, props.selectedWorkspaceId, hasMainView, props.projectPage]);

  const openSessionWindow = useCallback((workspaceId: string, sessionId: string) => {
    if (!isElectronRuntime()) return;
    const title = sessionTitleForId(props.sidebar.workspaceSessionGroups, sessionId);
    void desktopBridge.openSessionWindow({ workspaceId, sessionId, title }).catch(() => {
      toast.error(t("session.open_in_new_window_failed"));
    });
  }, [props.sidebar.workspaceSessionGroups]);

  const openNavWindow = useCallback((key: ShellNavKey) => {
    const pages = {
      navHome: "home", navScheduled: "scheduled", navCalendar: "calendar", navProjects: "projects", navWorkflows: "workflows",
      navTasks: "tasks", navRecorder: "recorder", navWikis: "wikis", navEvaluations: "evals",
    } satisfies Record<ShellNavKey, Parameters<typeof desktopBridge.openAppWindow>[0]["page"]>;
    void desktopBridge.openAppWindow({ page: pages[key] }).catch(() => {
      toast.error(t("projects.open_in_new_window_failed"));
    });
  }, []);

  const openProjectWindow = useCallback((workspaceId: string, page: "home" | "calendar" | "reviews" | "tasks" | "files") => {
    if (!isElectronRuntime()) return;
    const title = t(page === "calendar" ? "calendar.title" : page === "reviews" ? "projects.tab_review" : page === "tasks" ? "projects.tasks" : page === "files" ? "projects.files" : "projects.home");
    void desktopBridge.openProjectWindow({ workspaceId, page, title }).catch(() => {
      toast.error(t("projects.open_in_new_window_failed"));
    });
  }, []);




  useEffect(() => {
    if (!showSessionLoadingState) {
      setShowDelayedSessionLoadingState(false);
      return;
    }
    const id = window.setTimeout(() => {
      setShowDelayedSessionLoadingState(true);
    }, 1000);
    return () => window.clearTimeout(id);
  }, [showSessionLoadingState]);

  useEffect(() => {
    setRenameOpen(false);
    setDeleteOpen(false);
    setRenameBusy(false);
    setDeleteBusy(false);
    setSessionActionId(null);
  }, [props.selectedSessionId]);

  const openRenameModal = (sessionId: string) => {
    if (!props.onRenameSession) return;
    setSessionActionId(sessionId);
    setRenameTitle(sessionTitleForId(props.sidebar.workspaceSessionGroups, sessionId));
    setRenameOpen(true);
  };

  const submitRename = async () => {
    const sessionId = sessionActionId;
    const nextTitle = renameTitle.trim();
    if (!sessionId || !props.onRenameSession || !nextTitle || nextTitle === sessionActionTitle.trim()) return;
    setRenameBusy(true);
    try {
      await props.onRenameSession(sessionId, nextTitle);
      setRenameOpen(false);
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDelete = async () => {
    const sessionId = sessionActionId;
    if (!sessionId || !props.onDeleteSession || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await props.onDeleteSession(sessionId);
      setDeleteOpen(false);
    } catch (error) {
      toast.error(t("session.delete_failed"), { description: sessionDeleteError(error) });
    } finally {
      setDeleteBusy(false);
    }
  };

  const memoryDrivePanel = (
    <LegalMemoryFilesPanel
      headerTarget={!mobile && driveOpen ? filesHeaderTarget : null}
      client={props.legalworkServerClient}
      workspaceId={props.runtimeWorkspaceId}
      onOpenFile={openLegalMemoryFile}
      onOpenStorageFile={openStorageFile}
      onConnectStorage={() => {
        closeFileSidebar();
        props.sidebar.onShowFileStorage?.();
      }}
      onClose={closeFileSidebar}
    />
  );
  const sessionListRevision = useSessionListRevision();
  const listedSessionGroups = useMemo(() => props.sidebar.workspaceSessionGroups.map(group => ({
    ...group, sessions: group.sessions.filter(session => isSessionListed(session.id)),
  })), [props.sidebar.workspaceSessionGroups, sessionListRevision]);

  const mainView = props.projectsPage ? <ProjectsPage
    client={props.environmentClient ?? null}
    groups={listedSessionGroups}
    onOpenSearch={props.sidebar.onOpenSearch}
    onOpenProject={async (id, page) => {
      if (await props.sidebar.onSelectWorkspace(id, { navigate: false }) === false) return;
      navigate(page === "workspace" ? workspaceSessionRoute(id) + "?view=workspace" : page === "projectFiles" ? workspaceViewRoute(id, "files") : page === "projectCalendar" ? workspaceCalendarRoute(id) : page === "projectReviews" ? workspaceReviewsRoute(id) : page === "projectTasks" ? workspaceTasksRoute(id) : workspaceProjectRoute(id));
    }}
    onOpenSession={openSessionTab}
    onNewChat={props.sidebar.onCreateChatInWorkspace}
    onCreate={props.sidebar.onOpenCreateWorkspace}
    onRename={props.sidebar.onOpenRenameWorkspace}
    onReveal={props.sidebar.onRevealWorkspace}
    onForget={props.sidebar.onForgetWorkspace}
    newChatDisabled={props.sidebar.newChatDisabled}
  /> : props.mainView;
  const renderProjectTasks = (embedded: boolean, inWorkspace: boolean) => typeof props.projectTasksView === "function" ? props.projectTasksView(embedded, inWorkspace) : props.projectTasksView;
  const renderProjectView = (view: ProjectView, inWorkspace = true, active = true) => view === "dashboards" ? (
    props.legalworkServerClient && props.runtimeWorkspaceId ? <ProjectDashboards client={props.legalworkServerClient} workspaceId={props.runtimeWorkspaceId} onOpen={view => { openTab(workspaceScope, viewPanelTab(props.legalworkServerClient!.baseUrl, { owner: view.owner, viewId: view.id }, view.title)); navigate(workspaceSessionRoute(props.selectedWorkspaceId) + "?view=workspace"); }} /> : <p className="p-6">{t("projects.connecting")}</p>
  ) : view === "reviews" ? (
    props.legalworkServerClient && props.runtimeWorkspaceId ? <ProjectReviews overview={inWorkspace} localNavigation={!inWorkspace} onOpenInWorkspace={inWorkspace ? undefined : review => { openTab(workspaceScope, review ? { id: `review:${review.id}`, type: "review", reviewId: review.id, label: review.name } : projectViewTab("reviews", projectViewLabel("reviews"))); navigate(workspaceSessionRoute(props.selectedWorkspaceId) + "?view=workspace"); }} onOpenSession={sessionId => openSessionTab(props.selectedWorkspaceId, sessionId)} key={props.selectedWorkspaceId} client={props.legalworkServerClient} workspaceId={props.runtimeWorkspaceId} projectName={props.selectedWorkspaceDisplay.displayName || props.selectedWorkspaceDisplay.name || props.selectedWorkspaceId} /> : <p className="lw-project-page-content lw-project-page-top text-muted-foreground">{t("projects.connecting")}</p>
  ) : view === "files" ? <ProjectFilesPage
    local={{ client: props.legalworkServerClient, workspaceId: props.runtimeWorkspaceId, workspaceRoot: props.selectedWorkspaceRoot, projectName: props.selectedWorkspaceDisplay.displayName || props.selectedWorkspaceDisplay.name, isRemoteWorkspace: props.selectedWorkspaceDisplay.workspaceType === "remote", active, onOpenFile: openWorkspaceFileEntry }}
    connected={{ client: props.legalworkServerClient, workspaceId: props.runtimeWorkspaceId, onOpenFile: openLegalMemoryFile, onOpenStorageFile: openStorageFile, onConnectStorage: props.sidebar.onShowFileStorage }}
  /> : view === "sessions" ? <ProjectSessionsPage
    workspaceId={props.selectedWorkspaceId}
    group={listedSessionGroups.find(group => group.workspace.id === props.selectedWorkspaceId)}
    statuses={props.sidebar.sessionStatusById}
    onOpen={id => openSessionTab(props.selectedWorkspaceId, id)}
    onNew={() => props.sidebar.onCreateChatInWorkspace(props.selectedWorkspaceId)}
    newDisabled={props.sidebar.newChatDisabled}
    onRename={props.onRenameSession ? openRenameModal : undefined}
    onDelete={props.onDeleteSession ? id => { setSessionActionId(id); setDeleteOpen(true); } : undefined}
    onArchive={props.onArchiveSession}
  /> : view === "calendar" ? props.projectCalendarView : view === "tasks" ? renderProjectTasks(false, inWorkspace) : view === "home" ? (
    props.legalworkServerClient && props.runtimeWorkspaceId ? <ProjectHome
      key={props.selectedWorkspaceId}
      client={props.legalworkServerClient}
      workspaceId={props.runtimeWorkspaceId}
      projectId={props.selectedWorkspaceId}
      isRemoteWorkspace={props.selectedWorkspaceDisplay.workspaceType === "remote"}
      onStartRecording={props.onStartProjectRecording}
      inWorkspace={inWorkspace}
      active={active}
      name={props.selectedWorkspaceDisplay.displayName || props.selectedWorkspaceDisplay.name || props.selectedWorkspaceId}
      onOpenFile={openWorkspaceFileEntry}
      onBeforeDeleteNote={(entry) => {
        const tabs = usePanelTabStore.getState().sessions[panelStateSessionId]?.tabs ?? [];
        for (const tab of tabs) {
          if (tab.type !== "artifact" || tab.storage || tab.value !== entry.path) continue;
          closeTab(panelStateSessionId, tab.id);
          if (usePanelTabStore.getState().sessions[panelStateSessionId]?.tabs.some((item) => item.id === tab.id)) return false;
        }
        return true;
      }}
      onNewSession={(shareRecording) => props.onCreateProjectSession
        ? props.onCreateProjectSession(shareRecording)
        : void props.sidebar.onCreateChatInWorkspace(props.selectedWorkspaceId)}
      tasksView={renderProjectTasks(true, inWorkspace)}
      onViewAllDeadlines={inWorkspace ? undefined : () => navigate(workspaceCalendarRoute(props.selectedWorkspaceId))}
      onRename={props.onRenameProject}
    /> : <p className="lw-project-page-content lw-project-page-top text-muted-foreground">{t("projects.connecting")}</p>
  ) : null;

  const fileSidebars = (
    <FileSidebars
      key={props.runtimeWorkspaceId ?? "__no_workspace__"}
      active={fileSidebar}
      viewerOpen={sidePanelOpen}
      onResize={setFilesHeaderWidth}
      memory={memoryDrivePanel}
      files={(
        <WorkspaceFilesPanel
          active={fileSidebar === "files"}
          headerTarget={!mobile && filesRailActive ? filesHeaderTarget : null}
          client={props.legalworkServerClient}
          workspaceId={props.runtimeWorkspaceId}
          workspaceRoot={props.selectedWorkspaceRoot}
          isRemoteWorkspace={props.selectedWorkspaceDisplay.workspaceType === "remote"}
          projectName={props.selectedWorkspaceDisplay.displayName || props.selectedWorkspaceDisplay.name}
          onOpenFile={openWorkspaceFileEntry}
          onClose={closeFileSidebar}
        />
      )}
    />
  );

  const renderWikiTab = (tab: WikiPanelTab) => props.wiki ? <WikiPane key={tab.id} {...props.wiki} client={tab.serverUrl === props.wiki.serverUrl ? props.wiki.client : null} display="tab" tab={tab} onCloseTab={() => closeTab(panelStateSessionId, tab.id)} /> : null;
  const workspaceFilesRailButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("lw-session-rail-button hover:bg-muted hover:text-foreground", filesRailActive && "text-foreground")}
      onClick={openFilesRailPane}
      title={t(wikiWorkspace && props.selectedSessionId ? "wiki.project_files" : "session.workspace_files")}
      aria-label={t(wikiWorkspace && props.selectedSessionId ? "wiki.project_files" : "session.workspace_files")}
      aria-pressed={wikiWorkspace && props.selectedSessionId ? undefined : filesRailActive}
      aria-haspopup={wikiWorkspace && props.selectedSessionId ? "dialog" : undefined}
      disabled={!props.legalworkServerClient || !props.runtimeWorkspaceId}
    >
      <Folder size={17} />
    </Button>
  );

  const windowTitle = props.projectPage ? `${workspaceName} · ${projectViewLabel(props.projectPage)}`
    : props.homePage ? t("home.nav_label")
    : props.projectsPage ? t("projects.plural")
    : props.sidebar.activeNav === "scheduled" ? t("scheduled.title")
    : props.sidebar.activeNav === "calendar" ? t("calendar.title")
    : props.sidebar.activeNav === "workflows" ? t("sidebar.workflows")
    : props.sidebar.activeNav === "recorder" ? t("recorder.nav_label")
    : props.sidebar.activeNav === "tasks" ? t("sidebar.tasks")
    : props.sidebar.activeNav === "wikis" ? wikiWorkspace?.name ?? t("wiki.title")
    : props.sidebar.activeNav === "evals" ? t("sidebar.evals")
    : props.sidebar.activeNav === "extensions" ? t("extensions.title")
    : showWorkspaceSetupEmptyState ? t("session.create_or_connect_workspace")
    : workspaceName || selectedSessionTitle || t("session.default_title");
  const sidebarVisible = shellConfig.sidebar && chatSidebarOpen && !mobile;
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);

  return (
    <ChatWorkspaceContext.Provider value={wikiWorkspace ? "wiki" : "project"}>
    <ProjectFileProvider groups={props.fileWorkspaceGroups ?? listedSessionGroups} client={props.environmentClient ?? null} createChat={props.sidebar.onCreateChatInWorkspace}>
    <ProjectPersonalisationProvider groups={listedSessionGroups} client={props.environmentClient ?? null}>
    <div className="lw-window-frame flex h-full min-h-0 flex-col text-dls-text">
      <SidebarProvider
        open={chatSidebarOpen}
        onOpenChange={setSidebarOpen}
        className={cn(
          "lw-workspace-shell relative min-h-0 flex-1",
          leftSidebarResizing &&
            "**:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none [&_.lw-window-navigation]:transition-none",
          !shellConfig.sidebar && "**:data-[slot=sidebar-container]:hidden **:data-[slot=sidebar-gap]:hidden",
        )}
        style={sidebarProviderStyle}
        data-sidebar-visible={sidebarVisible}
      >
        <header data-panel-rail={shellConfig.panelRail && (!hasMainView || panelStateSessionId === EVALS_PANEL_SESSION_ID)} className="lw-window-topbar absolute inset-x-0 top-0 z-30 flex items-center electron:titlebar-drag">
          <div className="flex h-full min-w-0 flex-1 items-center gap-2 pr-2">
            <div className="lw-window-navigation flex h-6 shrink-0 items-center gap-1 border-r border-border/60 px-3" style={{ width: sidebarVisible ? "var(--sidebar-width)" : undefined }}>
              <Button variant="ghost" size="icon-sm" className="titlebar-no-drag text-muted-foreground" aria-label={t("sidebar.go_back")} title={t("sidebar.go_back")} onClick={() => navigate(-1)}><ArrowLeft className="size-4" /></Button>
              <Button variant="ghost" size="icon-sm" className="titlebar-no-drag text-muted-foreground" aria-label={t("sidebar.go_forward")} title={t("sidebar.go_forward")} onClick={() => navigate(1)}><ArrowRight className="size-4" /></Button>
              {wikiWorkspace ? <SidebarTrigger className="titlebar-no-drag text-muted-foreground" aria-label={t("wiki.toggle_navigation")} title={t("wiki.toggle_navigation")} aria-expanded={wikiNavigationOpen} onToggleSidebar={toggleWikiNavigation} /> : shellConfig.sidebar && !props.titlebarControlsHidden && (!topLevelPage || mobile) && <SidebarTrigger className="titlebar-no-drag text-muted-foreground" />}
              <WindowMenubar />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <h1 className="truncate text-[13px] font-medium tracking-[-0.01em]">{windowTitle}</h1>
              {props.developerMode && <span className="hidden truncate text-xs text-muted-foreground lg:inline">{props.headerStatus}</span>}
              {props.busyHint && <span className="hidden truncate text-xs text-muted-foreground lg:inline">{props.busyHint}</span>}
            </div>
            <div className="flex items-center gap-1.5 text-gray-10 titlebar-no-drag">
              {/* Revert/redo moved to per-message actions */}
              {props.selectedWorkspaceId && isElectronRuntime() ? (
                <WorkspaceWindowButton workspaceId={props.selectedWorkspaceId} showButton={!hasMainView} />
              ) : null}
              {!hasMainView && props.selectedWorkspaceId && <WorkspaceViewMenu scope={workspaceScope} />}
              {hasMainView && !sidebarVisible && props.selectedWorkspaceId && <Button variant="secondary" size="sm" onClick={() => navigate(workspaceSessionRoute(props.selectedWorkspaceId) + "?view=workspace")} title={t("workspace.return_to", { name: workspaceName })}><PanelsTopLeft className="size-4" />{t("workspace.workbench")}</Button>}
              <NotificationBell />
              {props.developerMode ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    try {
                      window.localStorage.removeItem("legalwork.acknowledgedProviders");
                      window.localStorage.removeItem("legalwork.orgOnboardingSeen");
                    } catch {}
                  }}
                  title={t("settings.clear_onboarding_hint")}
                >
                  {t("session.reset_notifications")}
                </Button>
              ) : null}
            </div>
          </div>
          {!mobile && sidePanelOpen && <div ref={setViewerHeaderTarget} data-panel-header="viewer" className="lw-window-panel-header" style={{ width: viewerHeaderWidth }} />}
          {!mobile && fileSidebar && (!hasMainView || panelStateSessionId === EVALS_PANEL_SESSION_ID) && <div ref={setFilesHeaderTarget} data-panel-header="files" className="lw-window-panel-header" style={{ width: filesHeaderWidth }} />}
          {!mobile && (!hasMainView || panelStateSessionId === EVALS_PANEL_SESSION_ID) && (sidePanelOpen || fileSidebar) && <div aria-hidden className="shrink-0" style={{ width: "var(--lw-window-panel-rail-width)" }} />}
        </header>
        <AppSidebar
          accountClient={props.environmentClient ?? props.legalworkServerClient ?? null}
          workspaceSessionGroups={listedSessionGroups}
          selectedWorkspaceId={props.sidebar.selectedWorkspaceId}
          developerMode={props.sidebar.developerMode}
          selectedSessionId={props.sidebar.selectedSessionId}
          projectFilesOpen={!hasMainView && fileSidebar === "files"}
          activeProjectView={props.projectPage ?? (hasMainView ? null : "workspace")}
          onOpenNavWindow={isElectronRuntime() ? openNavWindow : undefined}
          onOpenProjectFiles={workspaceId => {
            void Promise.resolve(props.sidebar.onSelectWorkspace(workspaceId, { navigate: false })).then(ok => { if (ok !== false) navigate(workspaceViewRoute(workspaceId, "files")); });
          }}
          showInitialLoading={sidebarInitialLoading}
          showSessionActions={Boolean(props.onRenameSession || props.onDeleteSession || props.onArchiveSession)}
          sessionStatusById={props.sidebar.sessionStatusById}
          connectingWorkspaceId={props.sidebar.connectingWorkspaceId}
          workspaceConnectionStateById={props.sidebar.workspaceConnectionStateById}
          newChatDisabled={props.sidebar.newChatDisabled}
          onSelectWorkspace={props.sidebar.onSelectWorkspace}
          onOpenSession={openSessionTab}
          onOpenSessionWindow={isElectronRuntime() ? openSessionWindow : undefined}
          onOpenProjectWindow={isElectronRuntime() ? openProjectWindow : undefined}
          onPrefetchSession={props.sidebar.onPrefetchSession}
          onCreateChatInWorkspace={props.sidebar.onCreateChatInWorkspace}
          onOpenRenameSession={props.onRenameSession ? openRenameModal : undefined}
          onOpenDeleteSession={props.onDeleteSession ? (sessionId) => {
            setSessionActionId(sessionId);
            setDeleteOpen(true);
          } : undefined}
          onArchiveSession={props.onArchiveSession ? (sessionId, archived) => {
            void props.onArchiveSession?.(sessionId, archived);
          } : undefined}
          onOpenCreateGroupModal={(workspaceId) => {
            setCreateGroupWorkspaceId(workspaceId);
            setCreateGroupLabel("");
            setCreateGroupOpen(true);
          }}
          onOpenRenameWorkspace={props.sidebar.onOpenRenameWorkspace}
          onRevealWorkspace={props.sidebar.onRevealWorkspace}
          onForgetWorkspace={props.sidebar.onForgetWorkspace}
          onOpenCreateWorkspace={props.sidebar.onOpenCreateWorkspace}
          onCreateChatInNewWorkspace={props.sidebar.onCreateChatInNewWorkspace}
          onShowWikis={props.sidebar.onShowWikis}
          onShowEvals={props.sidebar.onShowEvals}
          onShowWorkflows={props.sidebar.onShowWorkflows}
          onShowExtensions={props.sidebar.onShowExtensions}
          onShowRecorder={props.sidebar.onShowRecorder}
          onShowTasks={props.sidebar.onShowTasks}
          onOpenSearch={props.sidebar.onOpenSearch}
          onShowChats={props.sidebar.onShowChats}
          onNewChat={props.sidebar.onNewChat}
          onOpenAssistant={props.sidebar.onOpenAssistant}
          assistantProfile={props.sidebar.assistantProfile}
          assistantWorkspaceId={props.sidebar.assistantWorkspaceId}
          onSaveAssistantProfile={props.sidebar.onSaveAssistantProfile}
          assistantActive={props.sidebar.assistantActive}
          assistantGreetingUnread={props.sidebar.assistantGreetingUnread}
          assistantDisabled={props.sidebar.assistantDisabled}
          onShowProjects={props.sidebar.onShowProjects}
          activeNav={props.sidebar.activeNav}
          onReorderWorkspaces={props.sidebar.onReorderWorkspaces}
          onStartResize={startLeftSidebarResize}
        />
        {hasMainView ? (
          // Top-level pages (Evals / Skills / Integrations): keep the app chrome the
          // chat has — the draggable top header and the bottom StatusBar (with the
          // settings gear) — and swap only the center content.
          <SidebarInset className="lw-session-workspace min-h-0 overflow-hidden">
            <div className="flex min-h-0 flex-1">
            <ResizablePanelGroup orientation="horizontal" className={cn("lw-workspace-surface min-h-0 flex-1", workflowFocusMode && "!grid !grid-cols-1")}>
              <ResizablePanel id="session-content" minSize={workflowFocusMode ? "0px" : workflowsPage ? "280px" : "360px"} className={cn("min-w-0", workflowFocusMode && "hidden")}>
            <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">

              <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", props.projectPage && "@container/project-page")}>{props.projectPage ? <div ref={setOverviewHost} className="h-full min-h-0" /> : workflowsPage ? <div ref={setWorkflowLibraryHost} className="h-full min-h-0" /> : mainView}</div>
              {shellConfig.statusBar ? (
                <StatusBar
                  clientConnected={props.clientConnected}
                  legalworkServerStatus={props.legalworkServerStatus}
                  developerMode={props.developerMode}
                  settingsOpen={props.statusBar?.settingsOpen ?? false}
                  onOpenSettings={props.onOpenSettings}
                  providerConnectedIds={props.providerConnectedIds}
                  mcpConnectedCount={props.mcpConnectedCount}
                  loading={props.statusBar?.loading ?? false}
                  showSettingsButton={props.statusBar?.showSettingsButton}
                />
              ) : null}
            </main>
              </ResizablePanel>
              {sidePanelOpen ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    id="document-viewer"
                    defaultSize={workflowFocusMode ? "100%" : workflowsPage ? "60%" : "480px"}
                    minSize={workflowFocusMode ? "0px" : "320px"}
                    maxSize={workflowFocusMode ? "100%" : "70%"}
                    onResize={size => setViewerHeaderWidth(size.inPixels)}
                    className="flex min-h-0 flex-col overflow-hidden"
                  >
                    {workflowFocusMode ? <div className="shrink-0 border-b border-border px-3 py-2"><Button variant="ghost" size="sm" onClick={() => setSidePanelState(panelStateSessionId, null)}>{t("workflows.back_to_library")}</Button></div> : null}
                    <div className="min-h-0 flex-1"><SidePanel
                      headerTarget={!mobile ? viewerHeaderTarget : null}
                      sessionId={panelStateSessionId}
                      controlSessionIds={panelStateSessionId === EVALS_PANEL_SESSION_ID ? undefined : controlSessionIds}
                      client={props.legalworkServerClient}
                      workspaceId={props.runtimeWorkspaceId}
                      workspaceRoot={props.selectedWorkspaceRoot}
                      projects={props.workspaces.filter((workspace) => workspace.workspaceType !== "remote").map((workspace) => ({ id: workspace.id, name: workspace.displayName || workspace.name || workspace.id }))}
                      isRemoteWorkspace={props.selectedWorkspaceDisplay.workspaceType === "remote"}
                      onClose={closeRightPane}
                      renderWikiTab={renderWikiTab}
                    /></div>
                  </ResizablePanel>
                </>
              ) : null}
              {panelStateSessionId === EVALS_PANEL_SESSION_ID && fileSidebars}
            </ResizablePanelGroup>
            {/* Same right icon rail as the session view. */}
            {shellConfig.panelRail && panelStateSessionId === EVALS_PANEL_SESSION_ID && <aside aria-label={t("session.workspace_tools")} className="lw-session-rail flex w-[var(--lw-window-right-rail-width)] shrink-0 flex-col items-center gap-1.5 px-1 py-2 text-muted-foreground mac:titlebar-no-drag">
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("lw-session-rail-button hover:bg-muted hover:text-foreground", panelRailActive && "text-foreground")}
                onClick={() => panelStateSessionId === EVALS_PANEL_SESSION_ID ? toggleCurrentSidePanel("panel") : setCurrentSidePanel("panel")}
                title={t("session.viewer")}
                aria-label={t("session.viewer")}
                aria-pressed={panelRailActive}
              >
                <PanelsTopLeft size={17} />
              </Button>

              {workspaceFilesRailButton}

              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("lw-session-rail-button hover:bg-muted hover:text-foreground", driveOpen && "text-foreground")}
                onClick={() => toggleCurrentSidePanel("memory")}
                title={t("sidebar.memory_drive")}
                aria-label={t("sidebar.memory_drive")}
                aria-pressed={driveOpen}
              >
                <MemoryDriveIcon />
              </Button>
          </aside>}
            </div>
          </SidebarInset>
        ) : (
        <SidebarInset className="lw-session-workspace min-h-0 overflow-hidden">
          <div className="flex min-h-0 flex-1">
          <ResizablePanelGroup
            key={workspaceScope}
            orientation="horizontal"
            className="lw-workspace-surface min-h-0 flex-1"
          >
            {wikiWorkspace && props.wiki && wikiNavigationOpen ? <>
              <ResizablePanel key={wikiWorkspace.workspaceId} id="wiki-navigation" defaultSize={`${readWikiNavigationWidth(wikiWorkspace.workspaceId)}px`} onResize={size => writeWikiNavigationWidth(wikiWorkspace.workspaceId, size.inPixels)} groupResizeBehavior="preserve-pixel-size" minSize="200px" maxSize="440px" className="min-w-0 border-r border-border">
                <WikiPane key={wikiWorkspace.id} {...props.wiki} chatHistory={{ group: listedSessionGroups.find(group => group.workspace.id === wikiWorkspace.workspaceId), selectedSessionId: props.selectedSessionId, onOpen: id => openSessionTab(wikiWorkspace.workspaceId, id) }} display="navigation" hideHeader tab={activePanelTab?.type === "wiki" ? activePanelTab : undefined} />
              </ResizablePanel>
              <ResizableHandle />
            </> : null}
            <ResizablePanel id="session-content" minSize="360px" className="min-w-0">
              <main className="flex h-full min-w-0 flex-col overflow-hidden border-r border-border">


          <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1 overflow-hidden">
            <ResizablePanel minSize="180px" className="min-h-0">
            <div className="relative h-full min-w-0 overflow-hidden bg-dls-surface mac:bg-dls-surface/85 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
              {showStartupSkeleton && !canRenderWorkspace ? (
                <div className="px-6 py-14" role="status" aria-live="polite">
                  <div className="mx-auto max-w-2xl space-y-6">
                    <div className="space-y-2">
                      <div className="h-4 w-32 animate-pulse rounded-full bg-dls-hover/80" />
                      <div className="h-3 w-64 animate-pulse rounded-full bg-dls-hover/60" />
                    </div>
                    <div className="space-y-3">
                      {STARTUP_SKELETON_ROWS.map((row) => (
                        <div key={row.id} className="rounded-2xl border border-dls-border bg-dls-hover/40 p-4">
                          <div
                            className="mb-3 h-3 animate-pulse rounded-full bg-dls-hover/80"
                            style={{ width: row.titleWidth }}
                          />
                          <div className="space-y-2">
                            <div className="h-2.5 animate-pulse rounded-full bg-dls-hover/70" />
                            <div
                              className="h-2.5 animate-pulse rounded-full bg-dls-hover/60"
                              style={{ width: row.bodyWidth }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {showDelayedSessionLoadingState && !canRenderWorkspace ? (
                <div className="px-6 py-16">
                  <div
                    className="mx-auto flex max-w-[320px] flex-col items-center gap-3 text-center"
                    role="status"
                    aria-live="polite"
                  >
                    <OwDotTicker size="md" />
                    <div className="text-[12px] leading-5 text-dls-secondary">
                      {t("session.loading_detail")}
                    </div>
                  </div>
                </div>
              ) : null}

              {canRenderWorkspace && <div className="flex h-full min-h-0 flex-col">
                {props.sidebar.assistantActive && props.legalworkServerClient && <AssistantAttentionPanel client={props.legalworkServerClient} profile={props.sidebar.assistantProfile} onOpenSession={props.sidebar.onOpenSession}
                  permission={props.activePermission} question={props.activeQuestion} permissionBusy={props.permissionReplyBusy} questionBusy={props.questionReplyBusy} onPermission={props.respondPermission} onQuestion={props.respondQuestion} />}
                <div ref={setWorkspaceHost} className="min-h-0 flex-1" />
              </div>}

              {!showDelayedSessionLoadingState && !canRenderWorkspace && !showStartupSkeleton ? (
                <div className={`mx-auto h-full max-w-[800px] overflow-y-auto px-6 pb-8 ${showWorkspaceSetupEmptyState ? "pt-20" : "pt-3"}`}>
                  {props.notFoundMessage ? (
                    <div className="px-6 py-16 text-center">
                      <div className="mx-auto max-w-md rounded-2xl border border-dls-border bg-dls-card px-5 py-6 shadow-[var(--dls-card-shadow)]">
                        <h3 className="text-base font-medium text-dls-text">{t("session.not_found")}</h3>
                        <p className="mt-2 text-sm leading-6 text-dls-secondary">{props.notFoundMessage}</p>
                      </div>
                    </div>
                  ) : showWorkspaceSetupEmptyState ? (
                    <div className="space-y-6 px-6 text-center">
                      <div className="mx-auto flex size-16 items-center justify-center rounded-3xl border border-dls-border bg-dls-hover">
                        <Zap className="text-dls-secondary" />
                      </div>
                      <div className="space-y-2">
                        <h3 className="text-xl font-medium">{t("session.create_or_connect_workspace")}</h3>
                        <p className="mx-auto max-w-sm text-sm text-dls-secondary">
                          {t("workspace.empty_state_body")}
                        </p>
                      </div>
                      <div className="flex justify-center">
                        <Button onClick={props.sidebar.onOpenCreateWorkspace}>{t("workspace.create_workspace")}</Button>
                      </div>
                    </div>
                  ) : showSelectedWorkspaceError ? (
                    <div className="px-6 py-16">
                      <div className="mx-auto max-w-lg rounded-2xl border border-red-7/35 bg-red-1/40 p-5 text-left shadow-[var(--dls-card-shadow)]">
                        <div className="text-sm font-medium text-red-11">{selectedWorkspaceErrorTitle}</div>
                        <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm leading-6 text-red-11/90">
                          {selectedWorkspaceErrorMessage}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => props.sidebar.onCreateChatInWorkspace(props.selectedWorkspaceId)}
                          >
                            Retry
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : props.selectedSessionId ? (
                    <div className="px-6 py-16 text-center text-sm text-dls-secondary">
                      {t("session.loading_detail")}
                    </div>
                  ) : (
                    <WelcomeSurface replayKey={props.selectedWorkspaceId}>
                      <TaskSuggestionCards
                        providerConnectedCount={providerCount}
                        onConnect={() => props.onOpenProviderAuth?.()}
                        onSelect={(prompt) => props.sidebar.onCreateChatWithPrompt?.(props.selectedWorkspaceId, prompt)}
                      />
                      <Button variant="ghost" size="sm" className="mt-4 gap-2" onClick={props.onOpenSettings}>
                        <Settings2 size={14} aria-hidden="true" />
                        {t("session.connect_extension")}
                      </Button>
                    </WelcomeSurface>
                  )}
                </div>
              ) : null}
            </div>
            </ResizablePanel>
            {props.terminalOpen ? (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize="280px" minSize="160px" maxSize="55%" className="min-h-0">
                  <TerminalDock
                    workspaceRoot={props.selectedWorkspaceRoot}
                    isRemoteWorkspace={props.selectedWorkspaceDisplay.workspaceType === "remote"}
                    onClose={() => props.onTerminalOpenChange?.(false)}
                  />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>

          {shellConfig.statusBar ? (
            <StatusBar
              clientConnected={props.clientConnected}
              legalworkServerStatus={props.legalworkServerStatus}
              developerMode={props.developerMode}
              settingsOpen={props.statusBar?.settingsOpen ?? false}
              onOpenSettings={props.onOpenSettings}
              providerConnectedIds={props.providerConnectedIds}
              mcpConnectedCount={props.mcpConnectedCount}
              loading={props.statusBar?.loading ?? false}
              showSettingsButton={props.statusBar?.showSettingsButton}
            />
          ) : null}
              </main>
            </ResizablePanel>
          {fileSidebars}
          </ResizablePanelGroup>
          {shellConfig.panelRail ? (
          <aside aria-label={t("session.workspace_tools")} className="lw-session-rail flex w-[var(--lw-window-right-rail-width)] shrink-0 flex-col items-center gap-1.5 px-1 py-2 text-muted-foreground mac:titlebar-no-drag">
              {workspaceFilesRailButton}

              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("lw-session-rail-button hover:bg-muted hover:text-foreground", driveOpen && "text-foreground")}
                onClick={() => toggleCurrentSidePanel("memory")}
                title={t("sidebar.memory_drive")}
                aria-label={t("sidebar.memory_drive")}
                aria-pressed={driveOpen}
              >
                <MemoryDriveIcon />
              </Button>
          </aside>
          ) : null}
          </div>
        </SidebarInset>
        )}
      {visitedOverviews.map(view => <DocumentPane key={`overview:${props.selectedWorkspaceId}:${view}`} destination={props.projectPage === view ? overviewHost : null}>
        <ControlActionScope active={props.projectPage === view}>
          <PanelTabDestinationProvider destination={{ kind: "workspace", workspaceId: props.selectedWorkspaceId }}>
          <WorkspaceTabDropTarget projectId={props.selectedWorkspaceId} projectName={workspaceName} sessionTitle={id => sessionTitleForId(props.sidebar.workspaceSessionGroups, id) || t("session.default_title")} onOpen={async () => { navigate(workspaceSessionRoute(props.selectedWorkspaceId) + "?view=workspace"); }} hint={false} className="flex h-full min-h-0 flex-col">
            <section className="flex h-full min-h-0 flex-col" aria-label={projectViewLabel(view)}>
            {view !== "reviews" && <div className="flex shrink-0 justify-end px-5 pt-2">
              <Button variant="ghost" size="sm" onClick={() => {
                openTab(workspaceScope, projectViewTab(view, projectViewLabel(view)));
                navigate(workspaceSessionRoute(props.selectedWorkspaceId) + "?view=workspace");
              }}><PanelsTopLeft className="size-4" />{t("workspace.open_overview_tab")}</Button>
            </div>}
            <div className="min-h-0 flex-1 overflow-auto">{renderProjectView(view, false, props.projectPage === view)}</div>
          </section>
          </WorkspaceTabDropTarget>
          </PanelTabDestinationProvider>
        </ControlActionScope>
      </DocumentPane>)}
      {canRenderWorkspace && <DocumentPane key={`workspace:${props.selectedWorkspaceId}`} destination={hasMainView ? null : workspaceHost}>
        <ControlActionScope active={!hasMainView}>
          <SidePanel
            renderWikiTab={renderWikiTab}
            onOpenWiki={props.wiki?.client ? setWikiPickerPane : undefined}
            onOpenWikiGraph={wikiWorkspace && props.wiki?.client ? pane => {
              const client = props.wiki?.client;
              if (client) openTab(workspaceScope, wikiPanelTab(client.baseUrl, wikiWorkspace.id, { kind: "graph" }, t("wiki.graph")), pane);
            } : undefined}
            key={workspaceScope}
            sessionId={workspaceScope}
            controlSessionIds={controlSessionIds}
            client={props.legalworkServerClient}
            workspaceId={props.runtimeWorkspaceId}
            workspaceRoot={props.selectedWorkspaceRoot}
            isRemoteWorkspace={props.surface?.isRemoteWorkspace ?? false}
            projects={props.workspaces.filter(workspace => workspace.workspaceType !== "remote").map(workspace => ({ id: workspace.id, name: workspace.displayName || workspace.name || workspace.id }))}
            visible={!hasMainView}
            onClose={closeRightPane}
            projectId={props.selectedWorkspaceId}
            renderProjectView={wikiWorkspace ? undefined : (view, active) => renderProjectView(view, true, active)}
            onOpenTabWindow={isElectronRuntime() ? tab => { void openWorkspaceWindow(props.selectedWorkspaceId, tab).catch(() => toast.error(t("projects.open_in_new_window_failed"))); } : undefined}
            onDropChat={(ids, pane, edge) => {
              let destination = pane;
              for (const [index, id] of ids.entries()) {
                const store = usePanelTabStore.getState();
                const title = assistantWorkspace ? props.sidebar.assistantProfile?.name ?? t("assistant.title") : sessionTitleForId(props.sidebar.workspaceSessionGroups, id) || t("session.default_title");
                store.openTab(workspaceScope, chatPanelTab(id, title), destination, index === 0 ? edge : undefined);
                const opened = usePanelTabStore.getState().sessions[workspaceScope]?.panes.find(pane => pane.activeTabId === `chat:${id}`);
                if (!opened) break;
                destination = opened.id;
                openSessionTab(props.selectedWorkspaceId, id);
              }
            }}
            onNewChat={assistantWorkspace ? undefined : pane => { void props.sidebar.onCreateChatInWorkspace(props.selectedWorkspaceId, { paneId: pane }); }}
            onFocusChat={id => openSessionTab(props.selectedWorkspaceId, id)}
            onCloseChat={(id, nextId) => {
              if (id === props.selectedSessionId) navigate(wikiWorkspace ? wikiWorkspaceRoute(props.selectedWorkspaceId, nextId) : workspaceSessionRoute(props.selectedWorkspaceId, nextId) + (nextId ? "" : "?view=workspace"), { replace: true });
            }}
            renderChat={(sessionId, active) => props.surface ? <WorkspaceChat
              {...props.surface!}
              assistantName={props.sidebar.assistantActive ? props.sidebar.assistantProfile?.name ?? t("assistant.title") : undefined}
              assistantHeader={props.sidebar.assistantActive ? <AssistantIdentity client={props.legalworkServerClient ?? undefined} workspaceId={props.runtimeWorkspaceId!} sessionId={sessionId} profile={props.sidebar.assistantProfile} onSave={props.sidebar.onSaveAssistantProfile} modelSettings={active ? props.surface : undefined} /> : undefined}
              active={active}
              client={props.legalworkServerClient!}
              environmentClient={props.environmentClient}
              workspaceId={props.runtimeWorkspaceId!}
              sessionId={sessionId}
              opencodeBaseUrl={reactSessionBaseUrl}
              legalworkToken={reactSessionToken}
              onOpenInteractionSession={props.onOpenInteractionSession}
              onOpenTarget={(target, options) => openTarget(target, options, sessionId)}
              realtimeVoiceSupported={active && realtimeVoiceSupported}
              realtimeVoiceActive={active && voiceSidePanelOpen}
              onRealtimeVoiceActiveChange={active => active ? setCurrentSidePanel("voice") : closeVoicePanel()}
            /> : <div className="p-6 text-muted-foreground">{t("session.loading_detail")}</div>}
          />
        </ControlActionScope>
      </DocumentPane>}
      {workflowLibrary && <DocumentPane key={props.selectedWorkspaceId} destination={workflowsPage ? workflowLibraryHost : null}><ControlActionScope active={workflowsPage}>{workflowLibrary}</ControlActionScope></DocumentPane>}
      </SidebarProvider>

      {wikiPickerPane && props.wiki?.client ? <WikiPagePicker client={props.wiki.client} serverUrl={props.wiki.serverUrl} initialWikiId={wikiWorkspace?.id} onClose={() => setWikiPickerPane(null)} onOpen={tab => {
        const store = usePanelTabStore.getState();
        if (!store.sessions[workspaceScope]?.panes.some(pane => pane.id === wikiPickerPane)) { toast.error(t("side_panel.drop_target_closed")); return; }
        store.openTab(workspaceScope, tab, wikiPickerPane);
        setWikiPickerPane(null);
      }} /> : null}
      {props.providerAuthModal ? <ProviderAuthModal {...props.providerAuthModal} /> : null}

      {props.onRenameSession ? (
        <RenameSessionModal
          open={renameOpen}
          title={renameTitle}
          busy={renameBusy}
          canSave={renameTitle.trim().length > 0 && renameTitle.trim() !== sessionActionTitle.trim()}
          onClose={() => {
            if (!renameBusy) setRenameOpen(false);
          }}
          onSave={() => void submitRename()}
          onTitleChange={setRenameTitle}
        />
      ) : null}

      {props.onDeleteSession ? (
        <ConfirmModal
          open={deleteOpen}
          title={t("session.delete_session_title")}
          message={
            sessionActionTitle.trim()
              ? t("session.delete_named_session_message", { title: sessionActionTitle.trim() })
              : t("session.delete_session_generic")
          }
          confirmLabel={deleteBusy ? t("session.deleting") : t("session.delete")}
          cancelLabel={t("common.cancel")}
          variant="danger"
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!deleteBusy) setDeleteOpen(false);
          }}
        />
      ) : null}

      <Dialog open={createGroupOpen} onOpenChange={(open) => { if (!open) setCreateGroupOpen(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("session_management.new_group")}</DialogTitle>
          </DialogHeader>
          <Input
            type="text"
            value={createGroupLabel}
            onChange={(e) => setCreateGroupLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && createGroupLabel.trim()) {
                if (createGroupWorkspaceId) useSessionManagementStore.getState().createGroup(createGroupWorkspaceId, createGroupLabel.trim());
                setCreateGroupOpen(false);
              }
            }}
            placeholder={t("session_management.new_group_prompt")}
          />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>{t("common.cancel")}</DialogClose>
            <Button
              type="button"
              disabled={!createGroupLabel.trim()}
              onClick={() => {
                if (createGroupWorkspaceId) useSessionManagementStore.getState().createGroup(createGroupWorkspaceId, createGroupLabel.trim());
                setCreateGroupOpen(false);
              }}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* Cloud provider notifications are now handled globally by CloudProvidersToast in app-root.tsx */}
    </div>
    </ProjectPersonalisationProvider>
    </ProjectFileProvider>
    </ChatWorkspaceContext.Provider>
  );
}
