import { createContext, useContext } from "react";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient, LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";
import type { DraftCoordinator } from "./draft-coordinator";

/** What every launcher surface shares: one client, one draft coordinator, one way to reach the main window. */
export type LauncherShellValue = {
  client: LegalworkServerClient;
  assistant: { workspaceId: string; profile: AssistantProfile } | null;
  workspaces: LegalworkWorkspaceInfo[];
  drafts: DraftCoordinator;
  owner: string;
  surface: "panel" | "embedded";
  /** The conversation this surface belongs to; null means the server's current one. */
  conversationId: string | null;
  desktop: boolean;
  openInApp: (route: string) => void;
  dismiss: () => void;
  refresh: () => Promise<void>;
  bootstrapError?: string | null;
  workspacesPending?: boolean;
};
export const LauncherShellContext = createContext<LauncherShellValue | null>(null);
export function useLauncherShell() {
  const value = useContext(LauncherShellContext);
  if (!value) throw new Error("Launcher shell is not mounted.");
  return value;
}
