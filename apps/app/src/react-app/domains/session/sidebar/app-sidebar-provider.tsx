import type { ProjectView } from "../panel/project-view";
/** @jsxImportSource react */
import * as React from "react";
import type { WorkspaceConnectionState, WorkspaceSessionGroup } from "../../../../app/types";

export type SidebarContextValue = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  activeProjectFeature: "workspace" | ProjectView | null;
  onOpenWorkspace: (workspaceId: string) => Promise<void>;
  onOpenProjectPage: (workspaceId: string, page: ProjectView) => Promise<void>;
  onOpenProjectFiles: (workspaceId: string) => void;
  projectFilesOpen?: boolean;
  onOpenProjectWindow?: (workspaceId: string, page: "home" | "calendar" | "reviews" | "tasks" | "files") => void;
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
