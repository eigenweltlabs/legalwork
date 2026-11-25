import { createContext, type ReactNode } from "react";
import type { LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";
import type { SessionSurfaceProps } from "../surface/session-surface";

import type { PageCatalog } from "../panel/side-panel";

export const EmbeddedWorkspaceChat = createContext<{
  workspaceId: string;
  selectWorkspace: (workspace: LegalworkWorkspaceInfo | null) => void;
  renderPanel: (pages: PageCatalog, visible: boolean, daySessionId: string) => ReactNode;
  render: (sessionId: string, active: boolean, options: NonNullable<SessionSurfaceProps["timekeeping"]>) => ReactNode;
} | null>(null);
