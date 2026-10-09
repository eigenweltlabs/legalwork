/** @jsxImportSource react */
import * as React from "react";
import legalworkMarkDark from "@/assets/legalwork-mark-dark.svg";
import {
  Search,
  Clock,
  House,
  MessageSquare,
  Files,
  ListTodo,
  Settings,
  WandSparkles,
  Table2,
  Archive,
  ArchiveRestore,
  FlaskConical,
  ChevronRight,
  FolderPlus,
  Inbox,
  Loader2,
  Mic,
  PenLine,
  Workflow,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  FolderOpen,
  LayoutGrid,
  AppWindowMac,
  Tag,
  UserPlus,
  Users,
} from "lucide-react";
import { LazyMotion, Reorder, domMax, m, useDragControls } from "motion/react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import type {
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import {
  getWorkspaceTaskLoadErrorDisplay,
  isRemoteConnectionWorkspace,
  isWindowsPlatform,
  isMacPlatform,
} from "../../../../app/utils";
import { t } from "../../../../i18n";

import {
  Sidebar,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { useUnreadTaskCount } from "@/react-app/kernel/notification-store";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { SidebarContext, useSidebarContext } from "./app-sidebar-provider";
import { useProjectPersonalisation } from "../../workspace/project-personalisation-modal";
import type { SidebarContextValue } from "./app-sidebar-provider";
import { SidebarUpdateBadge } from "./sidebar-update-badge";
import { SidebarWorkflowGenerationBadge } from "./sidebar-workflow-generation-badge";
import { workspaceProjectRoute, workspaceSessionRoute, workspaceTasksRoute, workspaceReviewsRoute, workspaceCalendarRoute } from "@/react-app/shell/workspace-routes";
import {
  MAX_SESSIONS_PREVIEW,
  flattenSessionRows,
  getRootSessions,
  partitionArchivedSessions,
  buildSessionTreeState,
  isSessionArchived,
  isStreamingSessionStatus,
  workspaceKindLabel,
  workspaceLabel,
} from "./utils";
import type { FlattenedSessionRow, SessionListItem, SessionTreeState } from "./utils";
import {
  useSessionManagementStore,
  usePinnedSessionIds,
  useWorkspaceGroups,
  useSessionOrder,
  type SessionGroupDefinition,
} from "./session-management-store";
import { cn } from "@/lib/utils";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";
import { getSessionActivityStatusLabel, type SessionActivityStatus } from "../status/session-activity-store";
import { DEFAULT_SHELL_CONFIG, useShellConfig, type ShellNavKey } from "../../../shell/shell-config";
import { allProjectSessions, SessionProjectHover } from "./session-project-hover";
import { SidebarCustomization, SIDEBAR_ITEMS } from "./sidebar-customization";
import { startSessionDrag, acceptsSessionDrag, readSessionDrag } from "./session-drag";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { MainActionRail } from "./main-action-rail";
import { EigenweltAccountMenu } from "./eigenwelt-account-menu";
import { ProjectFolderIcon } from "../../workspace/project-sync";
import { useProjectSyncStore } from "../../workspace/project-sync-store";
import { unreadSession, useSessionInboxStore } from "./session-inbox-store";
import { useProjectFavoritesStore } from "../../workspace/project-favorites-store";

function UnreadDot({ unread, className }: { unread: boolean; className?: string }) {
  return unread ? <span className={cn("inline-block size-1.5 shrink-0 rounded-full bg-green-9", className)} role="img" aria-label={t("sidebar.unread_reply")} title={t("sidebar.unread_reply")} /> : null;
}

function useUnreadChats(sessions: SessionListItem[]) {
  return useSessionInboxStore(state => sessions.some(session => !isSessionArchived(session) && unreadSession(state, session.id)));
}

function ScheduledSessionIcon({ sessionId }: { sessionId: string }) {
  const automated = useSessionInboxStore(state => Boolean(state.entries[sessionId]?.automation));
  return automated ? <span className="flex size-3.5 shrink-0 items-center justify-center">
    <Clock strokeWidth={1.5} className="size-3.5! text-muted-foreground" role="img" aria-label={t("sidebar.automated_chat")}><title>{t("sidebar.automated_chat")}</title></Clock>
  </span> : null;
}

function SessionInboxIndicators({ unread, status, isStreaming, isActive }: SessionStatusIndicatorProps & { unread: boolean }) {
  if (!unread && !isStreaming && !isActive) return null;
  return <span className="pointer-events-none flex shrink-0 items-center gap-2">
    <SessionStatusIndicator status={status} isStreaming={isStreaming} isActive={isActive} />
    {unread && <span className="flex size-3.5 shrink-0 items-center justify-center"><UnreadDot unread /></span>}
  </span>;
}

interface SessionStatusIndicatorProps {
  className?: string;
  status?: string;
  isStreaming: boolean;
  isActive: boolean;
}

function SessionStatusIndicator({ className, status, isStreaming, isActive }: SessionStatusIndicatorProps) {
  const activityTitle = isSessionActivityStatus(status) && status !== "idle"
    ? getSessionActivityStatusLabel(status)
    : undefined;
  const title = activityTitle ?? (isStreaming ? t("workspace_list.session_streaming") : t("workspace_list.session_active"));

  if (isStreaming) {
    return (
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center",
          status === "waiting" && "text-sky-9",
          status === "error" && "text-red-9",
          className,
        )}
        title={title}
        aria-label={title}
      >
        <Loader2 className="size-3.5 animate-spin" />
      </span>
    );
  }

  if (isActive) {
    return (
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-foreground/45",
          status === "waiting" && "bg-sky-9",
          status === "error" && "bg-red-9",
          className,
        )}
        title={title}
        aria-label={title}
      />
    );
  }

  return null;
}

function useCanManageSession() {
  // Pin and group actions come from the Zustand store (always available).
  // Rename/delete/archive depend on wired callbacks but the menu should
  // always render so pin/group remain accessible.
  return true;
}

type SessionActionsProps = {
  className: string;
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

type SessionMenuContentProps = {
  variant: "dropdown" | "context";
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

function SessionMenuContent({ variant, sessionId, workspaceId, isPinned, isArchived }: SessionMenuContentProps) {
  const ctx = useSidebarContext();
  const { groups, assignments } = useWorkspaceGroups(workspaceId);
  const store = useSessionManagementStore;
  const assignedGroupId = assignments[sessionId] ?? null;

  if (variant === "dropdown") {
    return (
      <>
        {ctx.onOpenSessionWindow ? (
          <>
            <DropdownMenuItem onClick={() => ctx.onOpenSessionWindow?.(workspaceId, sessionId)}>
              <AppWindowMac className="size-4" />
              {t("sidebar.open_in_new_window")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={() => store.getState().togglePin(sessionId)}>
          {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
        </DropdownMenuItem>
        {ctx.onOpenRenameSession ? (
          <DropdownMenuItem onClick={() => ctx.onOpenRenameSession?.(sessionId)}>
            <Pencil className="size-4" />
            {t("workspace_list.rename_session")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Tag className="size-4" />
            {t("session_management.move_to_group")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            {groups.length === 0 ? (
              <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {t("session_management.no_groups_yet")}
                </span>
                <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground">
                  <Plus className="size-3.5" />
                </span>
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem
                  onClick={() => store.getState().assignGroup(workspaceId, sessionId, null)}
                  disabled={!assignedGroupId}
                >
                  {t("session_management.no_group")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {groups.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    onClick={() => store.getState().assignGroup(workspaceId, sessionId, group.id)}
                    disabled={assignedGroupId === group.id}
                  >
                    {group.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                  <FolderPlus className="size-4" />
                  {t("session_management.new_group")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {ctx.onArchiveSession ? (
          <DropdownMenuItem onClick={() => ctx.onArchiveSession?.(sessionId, !isArchived)}>
            {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            {isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session")}
          </DropdownMenuItem>
        ) : null}
        {ctx.onOpenDeleteSession ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => ctx.onOpenDeleteSession?.(sessionId)}>
              <Trash2 className="size-4" />
              {t("workspace_list.delete_session")}
            </DropdownMenuItem>
          </>
        ) : null}
      </>
    );
  }

  return (
    <>
      {ctx.onOpenSessionWindow ? (
        <>
          <ContextMenuItem onClick={() => ctx.onOpenSessionWindow?.(workspaceId, sessionId)}>
            <AppWindowMac className="size-4" />
            {t("sidebar.open_in_new_window")}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      <ContextMenuItem onClick={() => store.getState().togglePin(sessionId)}>
        {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        {isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
      </ContextMenuItem>
      {ctx.onOpenRenameSession ? (
        <ContextMenuItem onClick={() => ctx.onOpenRenameSession?.(sessionId)}>
          <Pencil className="size-4" />
          {t("workspace_list.rename_session")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Tag className="mr-2 size-4" />
          {t("session_management.move_to_group")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {groups.length === 0 ? (
            <ContextMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {t("session_management.no_groups_yet")}
              </span>
              <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground">
                <Plus className="size-3.5" />
              </span>
            </ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem
                onClick={() => store.getState().assignGroup(workspaceId, sessionId, null)}
                disabled={!assignedGroupId}
              >
                {t("session_management.no_group")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              {groups.map((group) => (
                <ContextMenuItem
                  key={group.id}
                  onClick={() => store.getState().assignGroup(workspaceId, sessionId, group.id)}
                  disabled={assignedGroupId === group.id}
                >
                  {group.label}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                <FolderPlus className="size-4" />
                {t("session_management.new_group")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {ctx.onArchiveSession ? (
        <ContextMenuItem onClick={() => ctx.onArchiveSession?.(sessionId, !isArchived)}>
          {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
          {isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session")}
        </ContextMenuItem>
      ) : null}
      {ctx.onOpenDeleteSession ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => ctx.onOpenDeleteSession?.(sessionId)}>
            <Trash2 className="size-4" />
            {t("workspace_list.delete_session")}
          </ContextMenuItem>
        </>
      ) : null}
    </>
  );
}

function SessionActions({ className, sessionId, workspaceId, isPinned, isArchived }: SessionActionsProps) {
  if (!useCanManageSession()) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="size-6 text-muted-foreground" aria-label={t("sidebar.conversation_actions")}
        render={
          <Button variant="ghost" size="icon-sm" className={cn("size-6", className)}>
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} alignOffset={-4} className="w-56">
        <SessionMenuContent
          variant="dropdown"
          sessionId={sessionId}
          workspaceId={workspaceId}
          isPinned={isPinned}
          isArchived={isArchived}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SessionContextMenuProps = {
  children: React.ReactElement;
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

function SessionContextMenu({ children, sessionId, workspaceId, isPinned, isArchived }: SessionContextMenuProps) {
  const ctx = useSidebarContext();
  const group = ctx.workspaceSessionGroups.find(group => group.workspace.id === workspaceId);
  const session = group?.sessions.find(session => session.id === sessionId);
  if (!useCanManageSession()) return children;

  return (
    <ContextMenu>
      {group && session ? <SessionProjectHover session={session} projectName={workspaceLabel(group.workspace)}><ContextMenuTrigger render={children} /></SessionProjectHover> : <ContextMenuTrigger render={children} />}
      <ContextMenuContent className="w-56">
        <SessionMenuContent
          variant="context"
          sessionId={sessionId}
          workspaceId={workspaceId}
          isPinned={isPinned}
          isArchived={isArchived}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

type WorkspaceActionsMenuProps = {
  workspace: WorkspaceInfo;
  className: string;
};

function WorkspaceActionsMenu({ workspace, className }: WorkspaceActionsMenuProps) {
  const ctx = useSidebarContext();
  const pinned = useProjectFavoritesStore(state => state.favoriteIds.includes(workspace.id));
  const toggleFavorite = useProjectFavoritesStore(state => state.toggleFavorite);
  const openPersonalisation = useProjectPersonalisation();
  const shared = useProjectSyncStore((store) => store.states[workspace.id] !== undefined);
  const share = useProjectSyncStore((store) => store.share);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-6", className)}
            onClick={(e) => {
              e.stopPropagation();
            }}
            aria-label={t("workspace_list.workspace_options")}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-56">
        <DropdownMenuItem onClick={() => toggleFavorite(workspace.id)}>
          {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {t(pinned ? "sidebar.unpin_project" : "sidebar.pin_project")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => ctx.onOpenRenameWorkspace(workspace.id)}>
          <Pencil className="size-4" />
          {t("workspace_list.edit_name")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openPersonalisation(workspace.id)}>
          <WandSparkles className="size-4" />
          {t("personalisation.project_prompt_menu")}
        </DropdownMenuItem>
        {workspace.workspaceType === "local" ? (
          <DropdownMenuItem onClick={() => share({ workspaceId: workspace.id, name: workspaceLabel(workspace) })}>
            {shared ? <Users className="size-4" /> : <UserPlus className="size-4" />}
            {shared ? t("project_sync.manage_sharing") : t("project_sync.share_project")}
          </DropdownMenuItem>
        ) : null}
        {workspace.workspaceType === "local" ? (
          <DropdownMenuItem onClick={() => ctx.onRevealWorkspace(workspace.id)}>
            <FolderOpen className="size-4" />
            {isWindowsPlatform() ? t("workspace_list.reveal_explorer") : t("workspace_list.reveal_finder")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspace.id)}>
          <FolderPlus className="size-4" />
          {t("session_management.new_group")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => ctx.onForgetWorkspace(workspace.id)}
        >
          <Trash2 className="size-4" />
          {t("workspace_list.remove_workspace")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type AppSidebarProps = {
  accountClient: LegalworkServerClient | null;
  onOpenSearch?: () => void;
  onShowChats?: () => void;
  onNewChat?: () => void;
  onShowProjects?: () => void;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  showInitialLoading?: boolean;
  selectedWorkspaceId: string;
  developerMode: boolean;
  selectedSessionId: string | null;
  onOpenProjectFiles: (workspaceId: string) => void;
  projectFilesOpen?: boolean;
  onOpenNavWindow?: (key: ShellNavKey) => void;
  onOpenProjectWindow?: SidebarContextValue["onOpenProjectWindow"];
  showSessionActions?: boolean;
  sessionStatusById?: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newChatDisabled: boolean;
  onSelectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onOpenSessionWindow?: (workspaceId: string, sessionId: string) => void;
  onPrefetchSession?: (workspaceId: string, sessionId: string) => void;
  onCreateChatInWorkspace: (workspaceId: string) => void;
  onOpenRenameSession?: (sessionId: string) => void;
  onOpenDeleteSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  onOpenCreateGroupModal?: (workspaceId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
  onCreateChatInNewWorkspace: () => void;
  onShowEvals?: () => void;
  onShowWorkflows?: () => void;
  onShowExtensions?: () => void;
  onShowRecorder?: () => void;
  /**
   * Tasks is the firm's intake inbox and is entitlement-gated: the route only
   * passes this handler when the firm is connected AND its plan includes
   * `intake`, and the nav row is omitted entirely without it. A lapsed
   * subscription therefore makes the row disappear rather than error.
   */
  onShowTasks?: () => void;
  /** Which main-pane nav tab is currently shown (shades it like hover). */
  activeNav?: "scheduled" | "calendar" | "evals" | "workflows" | "extensions" | "recorder" | "tasks" | null;
  onReorderWorkspaces?: (workspaceIds: string[]) => void;
  onStartResize?: React.PointerEventHandler<HTMLButtonElement>;
};

function useSessionTree(
  sessions: WorkspaceSessionGroup["sessions"],
  sessionStatusById: Record<string, string> | undefined,
) {
  return React.useMemo(
    () => buildSessionTreeState(sessions, sessionStatusById),
    [sessions, sessionStatusById],
  );
}

function isSessionActivityStatus(status: string | undefined): status is SessionActivityStatus {
  return status === "idle" || status === "thinking" || status === "responding" || status === "error" || status === "compacting" || status === "waiting";
}

// Primary nav rows (Workflows / Integrations / Evals): smooth color fade on
// hover/active. The active row uses the default subtle gray fill from
// SidebarMenuButton (data-active:bg-sidebar-accent) — no accent bar.

export function AppSidebar(props: AppSidebarProps) {
  const { config: shellConfig } = useShellConfig();
  const { open, isMobile, setOpen } = useSidebar();
  const collapsed = !isMobile && !open;
  const [customizingNavigation, setCustomizingNavigation] = React.useState(false);
  const customizationButtonRef = React.useRef<HTMLButtonElement>(null);
  const finishCustomizingNavigation = () => {
    setCustomizingNavigation(false);
    requestAnimationFrame(() => customizationButtonRef.current?.focus());
  };
  const location = useLocation();
  const navigate = useNavigate();
  const { workspaceId: routeWorkspaceId } = useParams();
  const openProjectId = routeWorkspaceId || (props.selectedSessionId ? props.selectedWorkspaceId : null);
  const unreadTasks = useUnreadTaskCount();
  const goSettings = React.useCallback(
    (tab: string) => {
      const ws = props.selectedWorkspaceId.trim();
      navigate(ws ? `/workspace/${encodeURIComponent(ws)}/settings/${tab}` : `/settings/${tab}`);
    },
    [navigate, props.selectedWorkspaceId],
  );
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [expandedSessionIds, setExpandedSessionIds] = React.useState<Set<string>>(
    () => new Set(),
  );

  const expandWorkspace = React.useCallback((workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  }, []);

  const toggleWorkspaceExpanded = React.useCallback((workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSessionExpanded = React.useCallback((sessionId: string) => {
    const id = sessionId.trim();
    if (!id) return;
    setExpandedSessionIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  React.useEffect(() => {
    const id = props.selectedWorkspaceId.trim();
    if (!id) return;
    expandWorkspace(id);
  }, [props.selectedWorkspaceId, props.selectedSessionId, expandWorkspace]);

  React.useEffect(() => {
    const workspaceId = props.selectedWorkspaceId.trim();
    if (!workspaceId) return;

    const group = props.workspaceSessionGroups.find(
      (entry) => entry.workspace.id === workspaceId,
    );
    if (!group?.sessions.length) return;

    const selectedId = props.selectedSessionId?.trim() ?? "";
    const selectedIndex = selectedId
      ? group.sessions.findIndex((session) => session.id === selectedId)
      : -1;
    const start = selectedIndex >= 0 ? Math.max(0, selectedIndex - 2) : 0;
    const end = selectedIndex >= 0
      ? Math.min(group.sessions.length, selectedIndex + 3)
      : Math.min(group.sessions.length, 4);

    group.sessions.slice(start, end).forEach((session) => {
      props.onPrefetchSession?.(workspaceId, session.id);
    });
  }, [
    props.onPrefetchSession,
    props.selectedSessionId,
    props.selectedWorkspaceId,
    props.workspaceSessionGroups,
  ]);

  const customSidebarBrandName = shellConfig.sidebarBrandName.trim();
  const customSidebarBrandLogo = shellConfig.sidebarBrandLogoDataUrl.trim();
  const sidebarBrandLogoSrc = customSidebarBrandLogo || legalworkMarkDark;
  const showSidebarBrandName = customSidebarBrandName.length > 0 || !customSidebarBrandLogo;
  const sidebarBrandName = showSidebarBrandName
    ? (customSidebarBrandName || DEFAULT_SHELL_CONFIG.sidebarBrandName)
    : "";
  const sidebarBrandAlt = sidebarBrandName || DEFAULT_SHELL_CONFIG.sidebarBrandName;

  const newChatSection = shellConfig.navNewChat ? <SidebarMenuItem key="navNewChat" className="mb-1 flex items-center gap-1">
            <SidebarMenuButton className="min-w-0 flex-1 gap-3 font-medium text-foreground [&_svg]:size-[18px]" disabled={Boolean(openProjectId) && props.newChatDisabled} onClick={() => {
              if (openProjectId) props.onCreateChatInWorkspace(openProjectId);
              else if (props.onNewChat) props.onNewChat();
              else if (props.onShowChats) props.onShowChats();
              else navigate("/home");
            }}>
              <PenLine className="size-[18px]" strokeWidth={1.5} />
              <span>{t("projects.new_chat")}</span>
            </SidebarMenuButton>
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" className="h-8 w-[10%] min-w-8 shrink-0 text-muted-foreground hover:text-foreground" aria-label={t("content_search.title")} aria-keyshortcuts={isMacPlatform() ? "Meta+k" : "Control+k"} onClick={props.onOpenSearch} />}>
              <Search className="size-[18px]" strokeWidth={1.5} />
            </TooltipTrigger><TooltipContent side="bottom">{t("content_search.title")}<kbd className="rounded bg-background/20 px-1.5 py-0.5 font-sans">{isMacPlatform() ? "⌘ K" : "Ctrl K"}</kbd></TooltipContent></Tooltip>
          </SidebarMenuItem> : null;
  const pinned = usePinnedSessionIds();
  const pinOrder = useSessionManagementStore(state => state.pinnedIds);
  const inbox = useSessionInboxStore();
  const favoriteIds = useProjectFavoritesStore(state => state.favoriteIds);
  const pinnedProjects = props.workspaceSessionGroups.filter(group => favoriteIds.includes(group.workspace.id));
  const allSessions = React.useMemo(() => allProjectSessions(props.workspaceSessionGroups, pinned), [props.workspaceSessionGroups, pinned]);
  const [recentLimit, setRecentLimit] = React.useState(10);
  const [closedSections, setClosedSections] = React.useState<Set<string>>(() => new Set());
  const toggleSection = (key: string) => setClosedSections(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  React.useEffect(() => {
    if (!props.selectedSessionId) return;
    setClosedSections(current => {
      const next = new Set(current);
      next.delete("sectionProjects");
      next.delete("sectionRecent");
      return next;
    });
  }, [props.selectedWorkspaceId, props.selectedSessionId]);
  const projectsPage = location.pathname === "/projects";
  const actions: Record<ShellNavKey, { onClick: () => void; active: boolean; available?: boolean }> = {
    navHome: { onClick: () => { setOpen(true); props.onShowChats?.(); }, active: location.pathname === "/home" },
    navScheduled: { onClick: () => navigate("/scheduled"), active: location.pathname === "/scheduled" },
    navCalendar: { onClick: () => navigate("/calendar"), active: location.pathname === "/calendar" },
    navProjects: { onClick: () => props.onShowProjects?.(), active: projectsPage },
    navTasks: { onClick: () => props.onShowTasks?.(), active: props.activeNav === "tasks", available: !!props.onShowTasks },
    navWorkflows: { onClick: () => props.onShowWorkflows?.(), active: props.activeNav === "workflows" },
    navRecorder: { onClick: () => props.onShowRecorder?.(), active: props.activeNav === "recorder" },
    navEvaluations: { onClick: () => props.onShowEvals?.(), active: props.activeNav === "evals" },
  };
  const sessionSection = (key: "sectionPinned" | "sectionRecent") => {
    const sessions = allSessions.filter(({ session }) => key === "sectionPinned" ? pinned.has(session.id) : !pinned.has(session.id));
    if (key === "sectionPinned") sessions.sort((a, b) => pinOrder.indexOf(a.session.id) - pinOrder.indexOf(b.session.id));
    if (key === "sectionPinned" && !sessions.length) return null;
    const visible = key === "sectionRecent" ? sessions.slice(0, recentLimit) : sessions;
    return <section key={key} className="px-2 pb-3">
      <button className="flex h-9 w-full items-center gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => toggleSection(key)} aria-expanded={!closedSections.has(key)}>
        {t(SIDEBAR_ITEMS[key].label)}<ChevronRight className={cn("size-3 transition-transform", !closedSections.has(key) && "rotate-90")} /><UnreadDot unread={closedSections.has(key) && sessions.some(({ session }) => unreadSession(inbox, session.id))} />
      </button>
      {!closedSections.has(key) && <SidebarMenu className="gap-0.5">
        {visible.map(({ session, workspace }) => <GlobalSessionRow key={session.id} session={session} workspace={workspace} />)}
        {!visible.length && <li className="px-2 py-2 text-xs text-muted-foreground">{t("projects.no_sessions")}</li>}
        {key === "sectionRecent" && sessions.length > recentLimit && <li><Button variant="ghost" className="h-8 justify-start px-2 text-xs text-muted-foreground" onClick={() => setRecentLimit(count => count + 10)}>{t("sidebar.show_more")}</Button></li>}
      </SidebarMenu>}
    </section>;
  };

  const contextValue: SidebarContextValue = {
    workspaceSessionGroups: props.workspaceSessionGroups,
    selectedWorkspaceId: props.selectedWorkspaceId,
    selectedSessionId: props.activeNav || projectsPage || location.pathname.endsWith("/project") || location.pathname.endsWith("/tasks") || location.pathname.endsWith("/reviews") || location.pathname.endsWith("/calendar") || location.pathname === "/home" ? null : props.selectedSessionId,
    activeProjectFeature: props.activeNav || projectsPage || location.pathname === "/home" ? null : location.pathname.endsWith("/calendar") ? "calendar" : location.pathname.endsWith("/reviews") ? "reviews" : location.pathname.endsWith("/tasks") ? "tasks"
      : location.pathname.endsWith("/project") ? "home" : props.selectedSessionId ? "sessions" : null,
    onOpenProjectPage: async (workspaceId, page) => {
      if (await props.onSelectWorkspace(workspaceId) === false) return;
      navigate(page === "calendar" ? workspaceCalendarRoute(workspaceId) : page === "reviews" ? workspaceReviewsRoute(workspaceId) : page === "tasks" ? workspaceTasksRoute(workspaceId) : workspaceProjectRoute(workspaceId));
    },
    onOpenProjectFiles: props.onOpenProjectFiles,
    projectFilesOpen: props.projectFilesOpen,
    onOpenProjectWindow: props.onOpenProjectWindow,
    developerMode: props.developerMode,
    showSessionActions: props.showSessionActions,
    sessionStatusById: props.sessionStatusById,
    newChatDisabled: props.newChatDisabled,
    connectingWorkspaceId: props.connectingWorkspaceId,
    workspaceConnectionStateById: props.workspaceConnectionStateById,
    onSelectWorkspace: props.onSelectWorkspace,
    onOpenSession: props.onOpenSession,
    onOpenSessionWindow: props.onOpenSessionWindow,
    onPrefetchSession: props.onPrefetchSession,
    onCreateChatInWorkspace: props.onCreateChatInWorkspace,
    onOpenRenameSession: props.onOpenRenameSession,
    onOpenDeleteSession: props.onOpenDeleteSession,
    onArchiveSession: props.onArchiveSession,
    onOpenCreateGroupModal: props.onOpenCreateGroupModal,
    onOpenRenameWorkspace: props.onOpenRenameWorkspace,
    onRevealWorkspace: props.onRevealWorkspace,
    onForgetWorkspace: props.onForgetWorkspace,
    expandWorkspace,
    toggleWorkspaceExpanded,
    toggleSessionExpanded,
    expandedWorkspaceIds,
    expandedSessionIds,
  };

  return (
    <SidebarContext.Provider value={contextValue}>
      <Sidebar
        collapsible="icon"
        role="navigation"
        aria-label={t("sidebar.main_navigation")}
        className="group/project-sidebar mac:**:data-[sidebar=sidebar]:bg-transparent"
      >
        <div className="flex min-h-0 flex-1">
        {(!customizingNavigation || collapsed) && <MainActionRail actions={actions} onOpenWindow={props.onOpenNavWindow} unreadTasks={unreadTasks}>
          <EigenweltAccountMenu client={props.accountClient} workspaceId={props.selectedWorkspaceId} />
        </MainActionRail>}
        <div className="lw-chat-sidebar flex min-h-0 min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
        {customizingNavigation ? <SidebarCustomization onDone={finishCustomizingNavigation} /> : <>
        <div className="flex shrink-0 flex-col pb-1 mac:titlebar-no-drag">
        <div className="shrink-0 px-2 pb-1 mac:titlebar-no-drag">
          <div className={cn("lw-sidebar-brand flex gap-2.5 px-3", showSidebarBrandName ? "items-center py-2" : "items-center py-0") }>
            <img
              src={sidebarBrandLogoSrc}
              alt={`${sidebarBrandAlt} logo`}
              className={cn(
                "object-contain",
                showSidebarBrandName
                  ? "h-8 w-8 shrink-0 rounded-md"
                  : "h-16 w-full min-w-0 max-w-full rounded-sm object-left",
              )}
            />
            {showSidebarBrandName ? (
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold leading-tight tracking-[-0.02em]">{sidebarBrandName}</div>
              </div>
            ) : null}
            <Button ref={customizationButtonRef} variant="ghost" size="icon" className="pointer-events-none ml-auto size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/project-sidebar:opacity-100 group-hover/project-sidebar:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto" aria-label={t("projects.customize_nav")} title={t("projects.customize_nav")} aria-expanded={customizingNavigation} onClick={() => setCustomizingNavigation(true)}>
              <Settings className="size-3.5" />
            </Button>
          </div>
        </div>
        <SidebarWorkflowGenerationBadge onOpenSession={(workspaceId, sessionId) => navigate(workspaceSessionRoute(workspaceId, sessionId))} />
        {newChatSection && <SidebarMenu className="px-2.5 pb-3 pt-1">{newChatSection}</SidebarMenu>}
        </div>
        <div data-slot="sidebar-content" data-sidebar="content" className="no-scrollbar min-h-0 flex-1 overflow-y-auto pt-1 mac:titlebar-no-drag">
          {shellConfig.chatSectionOrder.filter(key => key !== "navNewChat").filter(key => shellConfig[key]).map(key => {
            if (key === "sectionPinnedProjects") return pinnedProjects.length ? <section key={key} className="px-2 pb-3">
              <button className="flex h-9 w-full items-center gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => toggleSection(key)} aria-expanded={!closedSections.has(key)}>
                {t("sidebar.pinned_projects")}<ChevronRight className={cn("size-3 transition-transform", !closedSections.has(key) && "rotate-90")} /><UnreadDot unread={closedSections.has(key) && pinnedProjects.some(group => group.sessions.some(session => !isSessionArchived(session) && unreadSession(inbox, session.id)))} />
              </button>
              {!closedSections.has(key) && <SidebarMenu className="gap-0.5">{pinnedProjects.map(({ workspace }) => <PinnedProjectRow key={workspace.id} workspace={workspace} />)}</SidebarMenu>}
            </section> : null;
            if (key !== "sectionProjects") return sessionSection(key);
            return <section key={key} className="pb-3">
              <div className="flex h-9 items-center gap-1 px-4">
                <button className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground" aria-expanded={!closedSections.has(key)} onClick={() => toggleSection(key)}>{t("projects.plural")}<ChevronRight className={cn("size-3 transition-transform", !closedSections.has(key) && "rotate-90")} /><UnreadDot unread={closedSections.has(key) && props.workspaceSessionGroups.some(group => group.sessions.some(session => !isSessionArchived(session) && unreadSession(inbox, session.id)))} /></button>
                <Button variant="ghost" size="icon-xs" aria-label={t("sidebar.all_projects")} title={t("sidebar.all_projects")} onClick={() => props.onShowProjects?.()}><LayoutGrid className="size-3.5" /></Button>
                <Button variant="ghost" size="icon-xs" aria-label={t("projects.create")} onClick={props.onOpenCreateWorkspace}><Plus className="size-3.5" /></Button>
              </div>
              {!closedSections.has(key) && <LazyMotion features={domMax}><Reorder.Group as="div" axis="y" values={props.workspaceSessionGroups.map(group => group.workspace.id)} onReorder={ids => props.onReorderWorkspaces?.(ids)} className="flex flex-col gap-px">
                {props.workspaceSessionGroups.map(group => <WorkspaceReorderItem key={group.workspace.id} group={group} showInitialLoading={props.showInitialLoading} />)}
              </Reorder.Group></LazyMotion>}
            </section>;
          })}
        </div>
        <div className="shrink-0">
          <SidebarUpdateBadge onOpenUpdatesSettings={() => navigate("/settings/updates")} />
        </div>
        </>}
        </div>
        </div>
        {!collapsed && <SidebarRail
          aria-label={props.onStartResize ? t("session.resize_workspace_column") : undefined}
          title={props.onStartResize ? t("session.resize_workspace_column") : undefined}
          onClick={props.onStartResize ? (event) => {
            event.preventDefault();
          } : undefined}
          onPointerDown={props.onStartResize}
        />}
      </Sidebar>
    </SidebarContext.Provider>
  );
}

type WorkspaceReorderItemProps = {
  className?: string;
  group: WorkspaceSessionGroup;
  showInitialLoading?: boolean;
};

function WorkspaceReorderItem({
  className,
  group,
  showInitialLoading,
}: WorkspaceReorderItemProps) {
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      value={group.workspace.id}
      id={group.workspace.id}
      layout="position"
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      transformTemplate={(_latest, generated) =>
        // Keep Motion's translate-based reorder movement, but drop projection scale
        // so expanded workspace contents don't stretch during collapse/expand.
        generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")
      }
      className="relative"
    >
      <WorkspaceSidebarGroup
        className={className}
        group={group}
        showInitialLoading={showInitialLoading}
        onWorkspaceTitlePointerDown={(event) => dragControls.start(event, { distanceThreshold: 10 })}
      />
    </Reorder.Item>
  );
}

type WorkspaceHeaderProps = React.ComponentProps<typeof SidebarMenuButton> & {
  workspace: WorkspaceInfo;
  statusLabel: string;
  isError: boolean;
  isLoading: boolean;
  isRunning: boolean;
  unread: boolean;
  onTitlePointerDown: React.PointerEventHandler<HTMLDivElement>;
};

function WorkspaceHeader({
  workspace,
  statusLabel,
  isError,
  isLoading,
  isRunning,
  unread,
  onTitlePointerDown,
  onClick,
  ...props
}: WorkspaceHeaderProps) {
  const ctx = useSidebarContext();

  return (
    <SidebarMenuButton
      {...props}
      aria-expanded={ctx.expandedWorkspaceIds.has(workspace.id)}
      className={cn(
        "pr-10 [&_.lw-folder-icon]:size-5 group-hover/workspace-header:bg-sidebar-accent group-hover/workspace-header:text-sidebar-accent-foreground mac:group-hover/workspace-header:bg-black/5 dark:mac:group-hover/workspace-header:bg-white/10",
        statusLabel && "h-10",
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx.toggleWorkspaceExpanded(workspace.id);
      }}
      onDoubleClick={() => ctx.onOpenProjectWindow?.(workspace.id, "home")}
    >
      <span className="relative flex size-5 shrink-0">
        <ProjectFolderIcon workspaceId={workspace.id} open={ctx.expandedWorkspaceIds.has(workspace.id)} />
        {isRunning && (
          <SessionStatusIndicator
            className="absolute -right-1 -bottom-1 rounded-full bg-sidebar text-sidebar-foreground ring-2 ring-sidebar [&>svg]:size-3"
            status="running"
            isStreaming
            isActive={false}
          />
        )}
      </span>
      <div
        className="min-w-0 flex-1 cursor-grab touch-none active:cursor-grabbing group-hover/workspace-header:pr-14 group-focus-within/workspace-header:pr-14 group-has-data-popup-open/workspace-header:pr-14 [@media(hover:none)]:pr-14"
        onPointerDown={onTitlePointerDown}
      >
        <span className="block truncate">{workspaceLabel(workspace)}</span>
        {statusLabel ? (
          <span className={cn("block text-xs", isError ? "text-destructive" : "text-muted-foreground")}>
            {statusLabel}
          </span>
        ) : null}
      </div>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {isLoading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <UnreadDot unread={unread} />}
      </span>
    </SidebarMenuButton>
  );
}

const PROJECT_FEATURE_CLASS = "min-h-8 h-auto gap-2 rounded-md px-2.5 ps-2.5 py-1.5 text-[13px] data-active:bg-background data-active:shadow-xs data-active:ring-1 data-active:ring-border/50 [&>span:last-child]:whitespace-normal [&>span:last-child]:text-clip";

type WorkspaceSidebarGroupProps = {
  className?: string;
  group: WorkspaceSessionGroup;
  showInitialLoading?: boolean;
  onWorkspaceTitlePointerDown: React.PointerEventHandler<HTMLDivElement>;
};

function WorkspaceSidebarGroup({
  className,
  group,
  showInitialLoading,
  onWorkspaceTitlePointerDown,
}: WorkspaceSidebarGroupProps) {
  const ctx = useSidebarContext();
  const workspace = group.workspace;
  const unread = useUnreadChats(group.sessions);
  const isConnecting = ctx.connectingWorkspaceId === workspace.id;
  const connectionState: WorkspaceConnectionState = ctx.workspaceConnectionStateById[workspace.id] ?? {
    status: "idle",
    message: null,
  };
  const isConnectionActionBusy = isConnecting || connectionState.status === "connecting";
  const isRemoteWorkspace = isRemoteConnectionWorkspace(workspace);
  const taskLoadError = getWorkspaceTaskLoadErrorDisplay(workspace, group.error);
  const isExpanded = ctx.expandedWorkspaceIds.has(workspace.id);
  const isSelected = ctx.selectedWorkspaceId === workspace.id;
  const [sessionsOpen, setSessionsOpen] = React.useState(false);
  const { config } = useShellConfig();
  React.useEffect(() => {
    if (isSelected && ctx.selectedSessionId) setSessionsOpen(true);
  }, [isSelected, ctx.selectedSessionId]);
  const showSessions = !config.collapseProjectSessions || sessionsOpen;
  const projectNavItems = config.projectNavOrder.filter(key => key === "projectSessions" ? config.collapseProjectSessions : config[key]);


  const statusLabel = (() => {
    if (connectionState.status === "error") return connectionState.message?.trim() || taskLoadError.message;
    if (group.status === "error") return taskLoadError.label;
    if (isConnectionActionBusy) return t("workspace_list.connecting");
    if (isRemoteWorkspace && connectionState.status === "connected") return connectionState.message?.trim() || t("workspace_list.connected");
    if (!ctx.developerMode) return "";
    if (isSelected) return t("workspace.selected");
    return workspaceKindLabel(workspace);
  })();



  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu>
          <Collapsible
            render={<SidebarMenuItem />}
            open={isExpanded}
            onOpenChange={() => ctx.toggleWorkspaceExpanded(workspace.id)}
            className="group/collapsible"
          >
            <div className="group/workspace-header relative">
              <WorkspaceHeader
                workspace={workspace}
                unread={unread}
                isActive={isSelected}
                aria-current={isSelected ? "location" : undefined}
                statusLabel={statusLabel}
                isError={group.status === "error"}
                isLoading={group.status === "loading" || isConnecting}
                isRunning={group.sessions.some((session) => isStreamingSessionStatus(ctx.sessionStatusById?.[session.id]))}
                onTitlePointerDown={onWorkspaceTitlePointerDown}
              />
              <div data-workspace-actions className="group/workspace-actions absolute right-16 top-1/2 flex -translate-y-1/2 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground opacity-0 group-hover/workspace-header:opacity-100 group-focus-within/workspace-header:opacity-100 [@media(hover:none)]:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    ctx.onCreateChatInWorkspace(workspace.id);
                  }}
                  disabled={ctx.newChatDisabled}
                  aria-label={t("session.new_task")}
                  title={t("session.new_task")}
                >
                  <MessageSquare className="size-3.5" strokeWidth={1.5} />
                </Button>
                <WorkspaceActionsMenu
                  workspace={workspace}
                  className="size-6 text-muted-foreground opacity-0 group-hover/workspace-header:opacity-100 group-focus-within/workspace-header:opacity-100 [@media(hover:none)]:opacity-100 data-popup-open:opacity-100"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 size-6 -translate-y-1/2 text-muted-foreground flex items-center justify-center group/expand-collapse-button"
                aria-label={isExpanded ? t("sidebar.collapse") : t("sidebar.expand")}
                aria-expanded={isExpanded}
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.toggleWorkspaceExpanded(workspace.id);
                }}
              >
                <ChevronRight className={cn("size-4 transition-transform duration-200 text-muted-foreground group-hover/expand-collapse-button:text-foreground", isExpanded && "rotate-90")} />
              </Button>
            </div>

            <CollapsibleContent className="pt-1 pb-3">
              <div className="ml-5 mr-1 border-l border-sidebar-border/70 pl-2">
                {projectNavItems.length > 0 && <SidebarMenuSub className="gap-1.5 rounded-xl bg-sidebar-accent/65 p-1">
                  {projectNavItems.map(key => ({
                  projectCalendar: <SidebarMenuSubItem key="projectCalendar"><SidebarMenuSubButton className={PROJECT_FEATURE_CLASS} isActive={isSelected && ctx.activeProjectFeature === "calendar"} onDoubleClick={() => ctx.onOpenProjectWindow?.(workspace.id, "calendar")} onClick={() => { setSessionsOpen(false); void ctx.onOpenProjectPage(workspace.id, "calendar"); }}><SIDEBAR_ITEMS.projectCalendar.icon className="size-4" strokeWidth={1.5} /><span>{t("calendar.title")}</span></SidebarMenuSubButton></SidebarMenuSubItem>,
                  projectHome: <SidebarMenuSubItem key="projectHome">
                    <SidebarMenuSubButton className={PROJECT_FEATURE_CLASS} isActive={isSelected && ctx.activeProjectFeature === "home"} onDoubleClick={() => ctx.onOpenProjectWindow?.(workspace.id, "home")} onClick={() => { setSessionsOpen(false); void ctx.onOpenProjectPage(workspace.id, "home"); }}>
                      <House className="size-4" strokeWidth={1.5} />
                      <span>{t("projects.home")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>,
                  projectReviews: <SidebarMenuSubItem key="projectReviews">
                    <SidebarMenuSubButton className={PROJECT_FEATURE_CLASS} isActive={isSelected && ctx.activeProjectFeature === "reviews"} onDoubleClick={() => ctx.onOpenProjectWindow?.(workspace.id, "reviews")} onClick={() => { setSessionsOpen(false); void ctx.onOpenProjectPage(workspace.id, "reviews"); }}>
                      <Table2 className="size-4" strokeWidth={1.5} />
                      <span>{t("projects.tab_review")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>,
                  projectTasks: <SidebarMenuSubItem key="projectTasks">
                    <SidebarMenuSubButton className={PROJECT_FEATURE_CLASS} isActive={isSelected && ctx.activeProjectFeature === "tasks"} onDoubleClick={() => ctx.onOpenProjectWindow?.(workspace.id, "tasks")} onClick={() => { setSessionsOpen(false); void ctx.onOpenProjectPage(workspace.id, "tasks"); }}>
                      <ListTodo className="size-4" strokeWidth={1.5} />
                      <span>{t("projects.tasks")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>,
                  projectFiles: <SidebarMenuSubItem key="projectFiles">
                    <SidebarMenuSubButton className={PROJECT_FEATURE_CLASS} isActive={isSelected && ctx.projectFilesOpen} aria-pressed={isSelected && Boolean(ctx.projectFilesOpen)} onDoubleClick={() => ctx.onOpenProjectWindow?.(workspace.id, "files")} onClick={() => ctx.onOpenProjectFiles(workspace.id)}>
                      <Files className="size-4" strokeWidth={1.5} />
                      <span>{t("projects.files")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>,
                  projectSessions: <li key="projectSessions">
                    <div className="group/project-sessions-heading relative">
                      <SidebarMenuSubButton className={cn(PROJECT_FEATURE_CLASS, "pe-10")} isActive={isSelected && ctx.activeProjectFeature === "sessions"} aria-expanded={showSessions} onClick={() => {
                        setSessionsOpen(!showSessions);
                      }}>
                        <MessageSquare className="size-4" strokeWidth={1.5} />
                        <span className="min-w-0 flex-1 truncate group-hover/project-sessions-heading:pr-14 group-focus-within/project-sessions-heading:pr-14 [@media(hover:none)]:pr-14">{t("projects.sessions")}</span><span className="flex size-3.5 shrink-0 items-center justify-center"><UnreadDot unread={!showSessions && unread} /></span>
                        <ChevronRight className={cn("absolute right-2.5 size-3.5 text-muted-foreground transition-transform", showSessions && "rotate-90")} />
                      </SidebarMenuSubButton>
                      <Button variant="ghost" size="icon-xs" className="absolute right-23 top-1/2 size-6 -translate-y-1/2 text-muted-foreground opacity-0 group-hover/project-sessions-heading:opacity-100 group-focus-within/project-sessions-heading:opacity-100 [@media(hover:none)]:opacity-100" disabled={ctx.newChatDisabled} aria-label={t("session.new_task")} title={t("session.new_task")} onClick={() => ctx.onCreateChatInWorkspace(workspace.id)}><MessageSquare className="size-3.5" strokeWidth={1.5} /></Button>
                      <Button variant="ghost" size="icon-xs" className="absolute right-16 top-1/2 size-6 -translate-y-1/2 text-muted-foreground opacity-0 group-hover/project-sessions-heading:opacity-100 group-focus-within/project-sessions-heading:opacity-100 [@media(hover:none)]:opacity-100" aria-label={t("session_management.create_group")} title={t("session_management.create_group")} onClick={() => ctx.onOpenCreateGroupModal?.(workspace.id)}><FolderPlus className="size-3.5" /></Button>
                    </div>
                    <Collapsible open={showSessions}><CollapsibleContent>
                      <div className="mb-1 ml-[18px] mt-1.5 border-l border-sidebar-border pl-1">
                        <WorkspaceSessions group={group} loading={showInitialLoading} />
                      </div>
                    </CollapsibleContent></Collapsible>
                  </li>,
                  })[key])}
                </SidebarMenuSub>}
                {!config.collapseProjectSessions && <RecentProjectSessions group={group} loading={showInitialLoading} />}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

const UNGROUPED_GROUP_ID = "__legalwork_ungrouped";

function SessionGroupSeparator({ label, count, expanded, unread = false, onToggle, onRemove, onTitlePointerDown }: {
  label: string;
  unread?: boolean;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onRemove?: () => void;
  onTitlePointerDown?: React.PointerEventHandler<HTMLSpanElement>;
}) {
  return (
    <div className="group/separator flex w-full items-center gap-1 rounded-lg px-2 pt-2 first:pt-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        aria-expanded={expanded}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-90")} />
        <span
          className="min-w-0 flex-1 cursor-grab touch-none truncate text-[11px] font-medium text-muted-foreground active:cursor-grabbing"
          onPointerDown={onTitlePointerDown}
        >
          {label}
        </span>
        <UnreadDot unread={!expanded && unread} /><span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/5 hover:text-destructive group-hover/separator:opacity-100 group-focus-within/separator:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring [@media(hover:none)]:opacity-100"
          aria-label={t("session_management.remove_group")}
        >
          <Trash2 className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/** Drop zone wrapping a group's header + sessions. Dropping a session anywhere in the zone assigns it to this group. */
function GroupDropZone({ groupId, workspaceId, children }: {
  groupId: string | null;
  workspaceId: string;
  children: React.ReactNode;
}) {
  const [dragOver, setDragOver] = React.useState(false);
  const store = useSessionManagementStore;

  return (
    <div
      className={cn(
        "rounded transition-colors",
        dragOver && "bg-accent/40 ring-1 ring-accent/60",
      )}
      onDragOver={(e) => {
        if (acceptsSessionDrag(e.dataTransfer, workspaceId)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving this container, not when entering a child.
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        setDragOver(false);
        const sessionId = readSessionDrag(e.dataTransfer, workspaceId);
        if (sessionId) {
          e.preventDefault();
          e.stopPropagation();
          store.getState().assignGroup(workspaceId, sessionId, groupId);
        }
      }}
    >
      {children}
    </div>
  );
}

/** Renders sessions partitioned by group. Empty groups always show. Ungrouped sessions render at the end. */
function GroupedSessionList({ sessionRows, groups, assignments, pinnedIds, tree, workspaceId, forcedExpandedSessionIds, store, showAll = false }: {
  sessionRows: FlattenedSessionRow[];
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
  pinnedIds: Set<string>;
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
  store: typeof useSessionManagementStore;
  showAll?: boolean;
}) {
  const inbox = useSessionInboxStore();
  const rowUnread = (row: FlattenedSessionRow) => unreadSession(inbox, row.session.id) || [...tree.ancestorIdsBySessionId].some(([id, ancestors]) => ancestors.includes(row.session.id) && unreadSession(inbox, id));
  const [previewCountByGroup, setPreviewCountByGroup] = React.useState<Record<string, number>>({});

  const groupPreviewCount = (groupId: string) =>
    showAll ? Number.MAX_SAFE_INTEGER : previewCountByGroup[groupId] ?? 5;

  const showMoreInGroup = React.useCallback((groupId: string, totalCount: number) => {
    setPreviewCountByGroup((current) => ({
      ...current,
      [groupId]: Math.min(
        (current[groupId] ?? MAX_SESSIONS_PREVIEW) + MAX_SESSIONS_PREVIEW,
        totalCount,
      ),
    }));
  }, []);

  // Partition root rows into per-group buckets + ungrouped.
  const rootRowsByGroup = new Map<string, FlattenedSessionRow[]>();
  const ungroupedRows: FlattenedSessionRow[] = [];
  // Child rows follow their parent regardless of group.
  const childrenByParent = new Map<string, FlattenedSessionRow[]>();
  const rowIndexById = new Map(sessionRows.map((row, index) => [row.session.id, index]));

  for (const row of sessionRows) {
    if (row.depth > 0) {
      const rowIndex = rowIndexById.get(row.session.id);
      if (rowIndex === undefined) continue;
      let parentId: string | null = null;
      for (let j = rowIndex - 1; j >= 0; j--) {
        if (sessionRows[j].depth < row.depth) { parentId = sessionRows[j].session.id; break; }
      }
      if (parentId) {
        const kids = childrenByParent.get(parentId) ?? [];
        kids.push(row);
        childrenByParent.set(parentId, kids);
      }
      continue;
    }
    const groupId = assignments[row.session.id];
    if (groupId && groups.some((g) => g.id === groupId)) {
      const bucket = rootRowsByGroup.get(groupId) ?? [];
      bucket.push(row);
      rootRowsByGroup.set(groupId, bucket);
    } else {
      ungroupedRows.push(row);
    }
  }

  const renderRow = (row: FlattenedSessionRow) => (
    <React.Fragment key={row.session.id}>
      <SessionMenuItem
        session={row.session}
        depth={row.depth}
        tree={tree}
        workspaceId={workspaceId}
        forcedExpandedSessionIds={forcedExpandedSessionIds}
        isPinned={pinnedIds.has(row.session.id)}
      />
      {(childrenByParent.get(row.session.id) ?? []).map(renderRow)}
    </React.Fragment>
  );

  const renderGroup = (group: SessionGroupDefinition) => {
    const rows = rootRowsByGroup.get(group.id) ?? [];
    const expanded = !(store.getState().groupsByWorkspace[workspaceId]?.collapsedGroupIds ?? []).includes(group.id);
    const limit = groupPreviewCount(group.id);

    return (
      <SessionGroupSection
        key={group.id}
        group={group}
        rows={rows}
        unread={rows.some(rowUnread)}
        expanded={expanded}
        workspaceId={workspaceId}
        store={store}
        renderRow={renderRow}
        previewCount={limit}
        onShowMore={() => showMoreInGroup(group.id, rows.length)}
      />
    );
  };

  const ungroupedExpanded = !(store.getState().groupsByWorkspace[workspaceId]?.collapsedGroupIds ?? []).includes(UNGROUPED_GROUP_ID);
  const ungroupedLimit = groupPreviewCount(UNGROUPED_GROUP_ID);
  const visibleUngroupedRows = ungroupedRows.slice(0, ungroupedLimit);
  const ungroupedRemaining = Math.max(0, ungroupedRows.length - ungroupedLimit);
  const visibleUngroupedRootIds = visibleUngroupedRows.map((r) => r.session.id);

  return (
    <>
      <Reorder.Group
        as="div"
        axis="y"
        values={groups.map((group) => group.id)}
        onReorder={(ids) => store.getState().reorderGroups(workspaceId, ids)}
        className="flex flex-col"
      >
        {groups.map(renderGroup)}
      </Reorder.Group>
      {ungroupedRows.length > 0 ? (
        <GroupDropZone groupId={null} workspaceId={workspaceId}>
          <Collapsible
            open={ungroupedExpanded}
            onOpenChange={() => store.getState().toggleGroupExpanded(workspaceId, UNGROUPED_GROUP_ID)}
          >
            <SessionGroupSeparator
              label={t("session_management.ungrouped")}
              count={ungroupedRows.length}
              unread={ungroupedRows.some(rowUnread)}
              expanded={ungroupedExpanded}
              onToggle={() => store.getState().toggleGroupExpanded(workspaceId, UNGROUPED_GROUP_ID)}
            />
            <CollapsibleContent className="ps-5">
              <Reorder.Group
                as="div"
                axis="y"
                values={visibleUngroupedRootIds}
                onReorder={(ids) => {
                  const allRootIds = sessionRows.filter((r) => r.depth === 0).map((r) => r.session.id);
                  const ungroupedSet = new Set(ungroupedRows.map((r) => r.session.id));
                  const visibleSet = new Set(ids);
                  const fullUngrouped = [...ids, ...ungroupedRows.map((r) => r.session.id).filter((id) => !visibleSet.has(id))];
                  let ui = 0;
                  const full = allRootIds.map((id) => ungroupedSet.has(id) ? fullUngrouped[ui++] : id);
                  store.getState().reorderSessions(workspaceId, full);
                }}
                className="flex flex-col"
              >
                {visibleUngroupedRows.map((row) => (
                  <React.Fragment key={row.session.id}>
                    <SessionMenuItem
                      session={row.session}
                      depth={row.depth}
                      tree={tree}
                      workspaceId={workspaceId}
                      forcedExpandedSessionIds={forcedExpandedSessionIds}
                      isPinned={pinnedIds.has(row.session.id)}
                      draggable={row.depth === 0}
                    />
                    {(childrenByParent.get(row.session.id) ?? []).map(renderRow)}
                  </React.Fragment>
                ))}
              </Reorder.Group>
              {ungroupedRemaining > 0 ? (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    className="ps-3 text-muted-foreground text-xs"
                    onClick={() => showMoreInGroup(UNGROUPED_GROUP_ID, ungroupedRows.length)}
                  >
                    <span className="truncate">
                      {t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, ungroupedRemaining) })}
                    </span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        </GroupDropZone>
      ) : null}
    </>
  );
}

function SessionGroupSection({ group, rows, expanded, unread, workspaceId, store, renderRow, previewCount, onShowMore }: {
  group: SessionGroupDefinition;
  unread: boolean;
  rows: FlattenedSessionRow[];
  expanded: boolean;
  workspaceId: string;
  store: typeof useSessionManagementStore;
  renderRow: (row: FlattenedSessionRow) => React.ReactNode;
  previewCount: number;
  onShowMore: () => void;
}) {
  const dragControls = useDragControls();
  const visibleRows = rows.slice(0, previewCount);
  const remaining = Math.max(0, rows.length - previewCount);

  return (
    <Reorder.Item
      as="div"
      value={group.id}
      id={group.id}
      layout="position"
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      transformTemplate={(_latest, generated) => generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")}
    >
      <GroupDropZone groupId={group.id} workspaceId={workspaceId}>
        <Collapsible
          open={expanded}
          onOpenChange={() => store.getState().toggleGroupExpanded(workspaceId, group.id)}
          className="group/session-group"
        >
          <SessionGroupSeparator
            label={group.label}
            count={rows.length}
            unread={unread}
            expanded={expanded}
            onToggle={() => store.getState().toggleGroupExpanded(workspaceId, group.id)}
            onRemove={() => store.getState().removeGroup(workspaceId, group.id)}
            onTitlePointerDown={(event) => dragControls.start(event, { distanceThreshold: 10 })}
          />
          <CollapsibleContent className="ps-5">
            {visibleRows.length > 0
              ? (
                <>
                  {visibleRows.map(renderRow)}
                  {remaining > 0 ? (
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        className="ps-3 text-muted-foreground text-xs"
                        onClick={onShowMore}
                      >
                        <span className="truncate">
                          {t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, remaining) })}
                        </span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ) : null}
                </>
              )
              : (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton aria-disabled className="text-muted-foreground text-xs italic">
                    <span className="truncate">{t("session_management.empty_group")}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )}
          </CollapsibleContent>
        </Collapsible>
      </GroupDropZone>
    </Reorder.Item>
  );
}

function PinnedIndicator({ isPinned }: { isPinned: boolean }) {
  if (!isPinned) return null;
  return (
    <Pin
      className="size-3 shrink-0 text-muted-foreground/70"
      aria-label={t("session_management.pinned")}
    />
  );
}

type SessionMenuItemProps = {
  session: SessionListItem;
  depth: number;
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
  isPinned?: boolean;
  draggable?: boolean;
  compact?: boolean;
};

function SessionMenuItem({
  session,
  tree,
  workspaceId,
  forcedExpandedSessionIds,
  depth,
  isPinned = false,
  draggable = false,
  compact = false,
}: SessionMenuItemProps) {
  const ctx = useSidebarContext();
  const isSelected = ctx.selectedSessionId === session.id;
  const displayTitle = getDisplaySessionTitle(session.title);
  const hasChildren = !compact && (tree.descendantCountBySessionId.get(session.id) ?? 0) > 0;
  const isExpanded = ctx.expandedSessionIds.has(session.id) || forcedExpandedSessionIds.has(session.id);
  const sessionActivityStatus = ctx.sessionStatusById?.[session.id];
  const isSessionActive = tree.activeIds.has(session.id);
  const isSessionStreaming = tree.streamingIds.has(session.id) || isStreamingSessionStatus(sessionActivityStatus);
  const unread = useSessionInboxStore(state => unreadSession(state, session.id) || (!isExpanded && [...tree.ancestorIdsBySessionId].some(([id, ancestors]) => ancestors.includes(session.id) && unreadSession(state, id))));
  const isArchived = isSessionArchived(session);

  const openSession = () => {
    ctx.onOpenSession(workspaceId, session.id);
  };

  const openSessionWindow = (event: React.MouseEvent) => {
    if (!ctx.onOpenSessionWindow) return;
    event.preventDefault();
    event.stopPropagation();
    ctx.onOpenSessionWindow(workspaceId, session.id);
  };

  const prefetchSession = () => {
    if (workspaceId !== ctx.selectedWorkspaceId) {
      return;
    }

    ctx.onPrefetchSession?.(workspaceId, session.id);
  };

  const dragProps = depth === 0 && !compact ? {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      startSessionDrag(e.dataTransfer, workspaceId, session.id);
    },
  } : {};

  const item = hasChildren ? (
    <Collapsible
      open={isExpanded}
      onOpenChange={() => ctx.toggleSessionExpanded(session.id)}
      className="group/session-collapsible"
    >
      <SidebarMenuSubItem {...dragProps}>
        <SessionContextMenu sessionId={session.id} workspaceId={workspaceId} isPinned={isPinned} isArchived={isArchived}>
          <CollapsibleTrigger
            render={
              <SidebarMenuSubButton
                className={cn("relative h-7 gap-1.5 rounded-md ps-2 pe-16 text-xs data-[size=md]:text-xs data-active:bg-background", depth > 0 && "ps-5")}
                isActive={isSelected}
                aria-current={isSelected ? "page" : undefined}
                onClick={openSession}
                onDoubleClick={openSessionWindow}
                onPointerEnter={prefetchSession}
                onFocus={prefetchSession}
              >
                <PinnedIndicator isPinned={isPinned} />
                <ScheduledSessionIcon sessionId={session.id} />
                <span
                  className="min-w-0 flex-1 truncate"
                  title={displayTitle}
                >
                  {displayTitle}
                </span>
                <SessionInboxIndicators unread={unread} status={sessionActivityStatus} isStreaming={isSessionStreaming} isActive={isSessionActive} />
                <span className="flex items-center justify-center size-6 absolute right-2 top-1/2 -translate-y-1/2">
                  <ChevronRight className="size-4 text-muted-foreground transition-transform duration-200 group-data-open/session-collapsible:rotate-90 hover:text-foreground" />
                </span>
              </SidebarMenuSubButton>
            }
          />
        </SessionContextMenu>
        <SessionActions
          sessionId={session.id}
          workspaceId={workspaceId}
          isPinned={isPinned}
          isArchived={isArchived}
          className="absolute right-9 top-1/2 -translate-y-1/2 opacity-0 group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:opacity-100 data-popup-open:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </SidebarMenuSubItem>
    </Collapsible>
  ) : (
    <SidebarMenuSubItem {...dragProps}>
      <SessionContextMenu sessionId={session.id} workspaceId={workspaceId} isPinned={isPinned} isArchived={isArchived}>
        <SidebarMenuSubButton
          isActive={isSelected}
          aria-current={isSelected ? "page" : undefined}
          onClick={openSession}
          onDoubleClick={openSessionWindow}
          onPointerEnter={prefetchSession}
          onFocus={prefetchSession}
          className={cn(
            "h-7 gap-1.5 rounded-md ps-2 pe-10 text-xs data-[size=md]:text-xs data-active:bg-background",
            compact && "text-xs",
            depth > 0 && "ps-5",
          )}
        >
          <PinnedIndicator isPinned={isPinned} />
          <ScheduledSessionIcon sessionId={session.id} />
          <span className="min-w-0 flex-1 truncate" title={displayTitle}>{displayTitle}</span>
          <SessionInboxIndicators unread={unread} status={sessionActivityStatus} isStreaming={isSessionStreaming} isActive={isSessionActive} />
        </SidebarMenuSubButton>
      </SessionContextMenu>
      <SessionActions
        sessionId={session.id}
        workspaceId={workspaceId}
        isPinned={isPinned}
        isArchived={isArchived}
        className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:opacity-100 data-popup-open:opacity-100 [@media(hover:none)]:opacity-100"
      />
    </SidebarMenuSubItem>
  );

  if (!draggable) return item;

  return (
    <Reorder.Item
      as="div"
      value={session.id}
      id={session.id}
      layout="position"
      dragElastic={0}
      transformTemplate={(_latest, generated) => generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")}
    >
      {item}
    </Reorder.Item>
  );
}

type ArchivedSessionsSectionProps = {
  sessions: SessionListItem[];
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
  expanded: boolean;
  onToggle: () => void;
};

function ArchivedSessionsSection({
  sessions,
  tree,
  workspaceId,
  forcedExpandedSessionIds,
  expanded,
  onToggle,
}: ArchivedSessionsSectionProps) {
  const pinned = usePinnedSessionIds();
  return (
    <Collapsible open={expanded} onOpenChange={onToggle} className="group/archived">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="group/separator flex w-full cursor-pointer items-center gap-1.5 px-2 pb-1 pt-2.5 rounded transition-colors hover:bg-sidebar-accent/50"
          >
            <Archive className="size-3 shrink-0 text-muted-foreground" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("session_management.archived_label")}
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground/70">{sessions.length}</span>
            <ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform duration-200 group-data-open/archived:rotate-90" />
          </button>
        }
      />
      <CollapsibleContent>
        {sessions.map((session) => (
          <SessionMenuItem
            key={session.id}
            session={session}
            depth={0}
            tree={tree}
            workspaceId={workspaceId}
            forcedExpandedSessionIds={forcedExpandedSessionIds}
            isPinned={pinned.has(session.id)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}


/** Shared session rows, grouping, drag actions and archive controls. */
function WorkspaceSessions({ group, loading = false, showAll = false }: {
  group: WorkspaceSessionGroup; loading?: boolean; showAll?: boolean;
}) {
  const ctx = useSidebarContext();
  const workspaceId = group.workspace.id;
  const tree = useSessionTree(group.sessions, ctx.sessionStatusById);
  const pinnedIds = usePinnedSessionIds();
  const orderIds = useSessionOrder(workspaceId);
  const { groups, assignments } = useWorkspaceGroups(workspaceId);
  const [limit, setLimit] = React.useState(5);
  const [archivedOpen, setArchivedOpen] = React.useState(false);
  const forcedExpandedSessionIds = new Set(ctx.selectedSessionId ? tree.ancestorIdsBySessionId.get(ctx.selectedSessionId) ?? [] : []);
  const { active, archived } = partitionArchivedSessions(group.sessions);
  const rows = flattenSessionRows(group.sessions, showAll || groups.length ? Number.MAX_SAFE_INTEGER : limit, tree, ctx.expandedSessionIds, forcedExpandedSessionIds, pinnedIds, orderIds);
  const remaining = Math.max(0, getRootSessions(active).length - limit);
  const visibleRootIds = rows.filter((row) => row.depth === 0).map((row) => row.session.id);
  return (
    <SidebarMenuSub aria-label={t("projects.sessions")}>
      {loading || (group.status === "loading" && !group.sessions.length) ? <li className="px-3 py-2 text-xs text-muted-foreground">{t("workspace.loading_tasks")}</li> : groups.length ? (
        <GroupedSessionList sessionRows={rows} groups={groups} assignments={assignments} pinnedIds={pinnedIds} tree={tree} workspaceId={workspaceId} forcedExpandedSessionIds={forcedExpandedSessionIds} store={useSessionManagementStore} showAll={showAll} />
      ) : (
        <Reorder.Group as="div" axis="y" values={visibleRootIds} onReorder={(ids) => {
          const visible = new Set(ids);
          useSessionManagementStore.getState().reorderSessions(workspaceId, [...ids, ...getRootSessions(active).map((session) => session.id).filter((id) => !visible.has(id))]);
        }}>
          {rows.map((row) => <SessionMenuItem key={row.session.id} session={row.session} depth={row.depth} tree={tree} workspaceId={workspaceId} forcedExpandedSessionIds={forcedExpandedSessionIds} isPinned={pinnedIds.has(row.session.id)} draggable={row.depth === 0} />)}
          {!rows.length ? <li className="px-3 py-2 text-xs text-muted-foreground">{group.status === "error" ? getWorkspaceTaskLoadErrorDisplay(group.workspace, group.error).message : t("projects.no_sessions")}</li> : null}
        </Reorder.Group>
      )}
      {!showAll && !groups.length && remaining > 0 ? <li className="px-3 pt-1 pb-2">
        <button type="button" className="text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring" onClick={() => setLimit((value) => value + MAX_SESSIONS_PREVIEW)}>{t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, remaining) })}</button>
      </li> : null}
      {archived.length ? <ArchivedSessionsSection sessions={archived} tree={tree} workspaceId={workspaceId} forcedExpandedSessionIds={forcedExpandedSessionIds} expanded={archivedOpen} onToggle={() => setArchivedOpen((value) => !value)} /> : null}
    </SidebarMenuSub>
  );
}

function PinnedProjectRow({ workspace }: { workspace: WorkspaceInfo }) {
  const ctx = useSidebarContext();
  const location = useLocation();
  const toggleFavorite = useProjectFavoritesStore(state => state.toggleFavorite);
  const active = location.pathname === workspaceProjectRoute(workspace.id);
  const unread = useUnreadChats(ctx.workspaceSessionGroups.find(group => group.workspace.id === workspace.id)?.sessions ?? []);
  return <SidebarMenuItem className="group/project-row">
    <ContextMenu>
      <ContextMenuTrigger render={<SidebarMenuButton className="h-8 gap-2 pr-10 text-[13px]" isActive={active} aria-current={active ? "page" : undefined} onClick={() => void ctx.onOpenProjectPage(workspace.id, "home")} onDoubleClick={() => ctx.onOpenProjectWindow?.(workspace.id, "home")}><span className="min-w-0 flex-1 truncate">{workspaceLabel(workspace)}</span><span className="flex size-3.5 shrink-0 items-center justify-center"><UnreadDot unread={unread} /></span></SidebarMenuButton>} />
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={() => void ctx.onOpenProjectPage(workspace.id, "home")}><FolderOpen className="size-4" />{t("projects.open_project")}</ContextMenuItem>
        {ctx.onOpenProjectWindow && <ContextMenuItem onClick={() => ctx.onOpenProjectWindow?.(workspace.id, "home")}><AppWindowMac className="size-4" />{t("sidebar.open_in_new_window")}</ContextMenuItem>}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => toggleFavorite(workspace.id)}><PinOff className="size-4" />{t("sidebar.unpin_project")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <WorkspaceActionsMenu workspace={workspace} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 data-popup-open:opacity-100 [@media(hover:none)]:opacity-100" />
  </SidebarMenuItem>;
}

function GlobalSessionRow({ session, workspace }: { session: SessionListItem; workspace: WorkspaceInfo }) {
  const ctx = useSidebarContext();
  const pinned = usePinnedSessionIds();
  const status = ctx.sessionStatusById?.[session.id];
  const unread = useSessionInboxStore(state => unreadSession(state, session.id));
  return <SidebarMenuItem className="group/session-row">
    <SessionContextMenu sessionId={session.id} workspaceId={workspace.id} isPinned={pinned.has(session.id)} isArchived={false}>
        <SidebarMenuButton className="h-8 gap-1.5 pr-10 text-[13px]" aria-current={ctx.selectedSessionId === session.id && ctx.selectedWorkspaceId === workspace.id ? "page" : undefined} isActive={ctx.selectedSessionId === session.id && ctx.selectedWorkspaceId === workspace.id} onClick={() => ctx.onOpenSession(workspace.id, session.id)} onDoubleClick={event => {
          if (!ctx.onOpenSessionWindow) return;
          event.preventDefault();
          event.stopPropagation();
          ctx.onOpenSessionWindow(workspace.id, session.id);
        }} onPointerEnter={() => ctx.onPrefetchSession?.(workspace.id, session.id)}>
          <ScheduledSessionIcon sessionId={session.id} />
          <span className="min-w-0 flex-1 truncate" title={getDisplaySessionTitle(session.title)}>{getDisplaySessionTitle(session.title)}</span>
          <SessionInboxIndicators unread={unread} status={isSessionActivityStatus(status) ? status : undefined} isStreaming={isStreamingSessionStatus(status)} isActive={isSessionActivityStatus(status) && status !== "idle"} />
        </SidebarMenuButton>
    </SessionContextMenu>
    <SessionActions sessionId={session.id} workspaceId={workspace.id} isPinned={pinned.has(session.id)} isArchived={false} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100 data-popup-open:opacity-100" />
  </SidebarMenuItem>;
}

function RecentProjectSessions({ group, loading }: { group: WorkspaceSessionGroup; loading?: boolean }) {
  const [limit, setLimit] = React.useState(5);
  const sessions = allProjectSessions([group]);
  return <SidebarMenu className="gap-0.5 py-1 pl-2">
    {sessions.slice(0, limit).map(({ session, workspace }) => <GlobalSessionRow key={session.id} session={session} workspace={workspace} />)}
    {!sessions.length && <li className="px-2 py-2 text-xs text-muted-foreground">{loading || group.status === "loading" ? t("workspace.loading_tasks") : group.status === "error" ? getWorkspaceTaskLoadErrorDisplay(group.workspace, group.error).message : t("projects.no_sessions")}</li>}
    {sessions.length > limit && <li><Button variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setLimit(value => value + 5)}>{t("sidebar.show_more")}</Button></li>}
  </SidebarMenu>;
}
