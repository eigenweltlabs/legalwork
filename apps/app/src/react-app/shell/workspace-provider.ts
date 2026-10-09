import * as React from "react";

import type { Client } from "@/app/types";
import type { RouteWorkspace } from "./route-workspaces";

type WorkspaceContextValue = {
  client: Client | null;
  opencodeBaseUrl: string;
  selectedWorkspaceRoot: string;
  workspaces: RouteWorkspace[];
  baseUrl: string;
  token: string;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
};

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

type WorkspaceProviderProps = WorkspaceContextValue & {
  children: React.ReactNode;
};

export function WorkspaceProvider({
  client,
  opencodeBaseUrl = "",
  selectedWorkspaceRoot,
  workspaces,
  baseUrl,
  token,
  onOpenSession,
  children,
}: WorkspaceProviderProps) {
  const value = React.useMemo(
    () => ({ client, opencodeBaseUrl, selectedWorkspaceRoot, workspaces, baseUrl, token, onOpenSession }),
    [client, opencodeBaseUrl, selectedWorkspaceRoot, workspaces, baseUrl, token, onOpenSession],
  );

  return React.createElement(WorkspaceContext.Provider, { value }, children);
}

export function useWorkspace() {
  const context = React.use(WorkspaceContext);

  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }

  return context;
}
