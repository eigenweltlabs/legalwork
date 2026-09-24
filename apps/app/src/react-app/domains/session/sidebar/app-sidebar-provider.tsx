/** @jsxImportSource react */
import * as React from "react";
import type { WorkspaceConnectionState } from "../../../../app/types";

export type SidebarContextValue = {
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  activeProjectFeature: "home" | "tasks" | "files" | null;
  onOpenProjectTab: (workspaceId: string, tab: "home" | "tasks") => Promise<void>;
  onOpenProjectFiles: (workspaceId: string) => void;
  developerMode: boolean;
  showSessionActions?: boolean;
  sessionStatusById?: Record<string, string>;
  newChatDisabled: boolean;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
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
  expandWorkspace: (workspaceId: string) => void;
  toggleWorkspaceExpanded: (workspaceId: string) => void;
  toggleSessionExpanded: (sessionId: string) => void;
  expandedWorkspaceIds: Set<string>;
  expandedSessionIds: Set<string>;
};

export const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebarContext() {
  const context = React.use(SidebarContext);
  if (!context) throw new Error("useSidebarContext must be used within SidebarProvider");
  return context;
}

export type SessionListContextValue = Pick<SidebarContextValue,
  "selectedWorkspaceId" | "selectedSessionId" | "sessionStatusById" |
  "onOpenSession" | "onOpenSessionWindow" | "onPrefetchSession" |
  "onOpenRenameSession" | "onOpenDeleteSession" | "onArchiveSession" |
  "onOpenCreateGroupModal" | "expandedSessionIds" | "toggleSessionExpanded"
>;
export const SessionListContext = React.createContext<SessionListContextValue | null>(null);
export function useSessionListContext() {
  const override = React.use(SessionListContext);
  const sidebar = React.use(SidebarContext);
  const context = override ?? sidebar;
  if (!context) throw new Error("Session list needs a context");
  return context;
}
