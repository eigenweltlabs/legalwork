// Type definitions for the desktop bridge.
// The payload shapes and the per-command contract live in
// packages/types/src/desktop-ipc.ts (shared with the Electron main process);
// this module re-exports them as the app-side import path.

import type { WorkspaceWire } from "@legalwork/types/workspace";

export type {
  AppBuildInfo,
  CacheResetResult,
  DesktopBootstrapConfig,
  DesktopCommandArgs,
  DesktopCommandInvokers,
  DesktopCommandMap,
  DesktopCommandName,
  DesktopCommandResult,
  DesktopFetchInit,
  DesktopFetchResult,
  EngineDoctorResult,
  EngineInfo,
  ExecResult,
  LocalSkillCard,
  LocalSkillContent,
  OpencodeCommandDraft,
  OpencodeConfigFile,
  OpencodeExecutionEnvEntry,
  OpencodeExecutionSnapshot,
  LegalworkDockerCleanupResult,
  LegalworkServerInfo,
  OrchestratorDetachedHost,
  SandboxDebugProbeResult,
  SandboxDoctorResult,
  UpdaterEnvironment,
  WorkspaceCreateInput,
  WorkspaceExportSummary,
  WorkspaceList,
  WorkspaceLegalworkConfig,
} from "@legalwork/types/desktop-ipc";

// Canonical wire shape shared with legalwork-server and the desktop bridge.
// Single source of truth: packages/types/src/workspace.ts.
export type WorkspaceInfo = WorkspaceWire;

// Browser tab state mirrored across the desktop IPC bridge. Owned here (the
// framework-agnostic layer); the session panel store re-exports it.
export type BrowserPanelTab = {
  // Agent-owned tabs stay in their chat's background stack until the user opens them.
  background?: boolean;
  taskSessionId?: string;
  workspaceId?: string;
  dismissed?: boolean;
  id: string;
  type: "browser";
  label: string;
  url: string;
  favicon: string | null;
  status: "loading" | "ready";
  canGoBack: boolean;
  canGoForward: boolean;
};
