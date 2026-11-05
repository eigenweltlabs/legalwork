import type { HostApprovalRequest } from "@legalwork/types/desktop-ipc";
import type { AudioRecordingDetail, AudioRecordingMeta } from "@legalwork/types/audio";
import type { WorkspaceWire } from "@legalwork/types/workspace";

/** Host callbacks are never loaded from saved configuration or exposed over HTTP. */
export type ServerRuntimeOptions = {
  modelDownloadFetch?: import("./ocr/models.js").ModelDownloadFetch;
  documentLayout?: import("./document-preparation/structure.js").DocumentLayout;
  rawHttpNodeExecutable?: () => string;
  toolImageRasterRuntime?: () => import("./tool-image-raster.js").ToolImageRasterRuntime;
  onListening?: (port: number) => Promise<void>;
};

export type ApprovalMode = "manual" | "auto";

export type TokenScope = "owner" | "collaborator" | "viewer";

export type SandboxBackend = "none" | "docker" | "container";

export type ProviderPlacement = "in-sandbox" | "host-machine" | "client-machine" | "external";

export type LogFormat = "pretty" | "json";

export interface WorkspaceConfig {
  id?: string;
  path: string;
  name?: string;
  preset?: string;
  /** Legacy remote records are read only to preserve their original configuration. */
  workspaceType?: "local" | "remote";
  baseUrl?: string;
  directory?: string;
  displayName?: string;
  sandboxBackend?: string;
  sandboxRunId?: string;
  sandboxContainerName?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  preset: string;
  workspaceType: "local";
  baseUrl?: string;
  directory?: string;
  displayName?: string;
  sandboxBackend?: string;
  sandboxRunId?: string;
  sandboxContainerName?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
    password?: string;
  };
}

/** Public workspace metadata excludes the engine's private connection secrets. */
export type WorkspaceMetadata = Omit<WorkspaceInfo, "opencodeUsername" | "opencodePassword" | "opencode"> & {
  opencode?: Pick<NonNullable<WorkspaceInfo["opencode"]>, "baseUrl" | "directory">;
};

// Compile-time contract tripwires against the shared wire shape consumed by
// apps/app (packages/types/src/workspace.ts). The first check rejects fields
// whose values no longer fit the wire contract; the second rejects fields the
// contract does not know about. Both are erased at build time.
type Extends<A extends B, B> = A;
type _WorkspaceInfoFitsWire = Extends<WorkspaceMetadata, WorkspaceWire>;
type _WorkspaceInfoKeysKnown = Extends<keyof WorkspaceMetadata, keyof WorkspaceWire>;

export interface OpencodeConfigFile {
  path: string;
  exists: boolean;
  content: string | null;
}

export interface ApprovalConfig {
  mode: ApprovalMode;
  timeoutMs: number;
}

export interface WordAddinConfig {
  /** Serve the Word task pane bundle and start the HTTPS add-in listener. */
  enabled: boolean;
  /** Fixed port for the HTTPS listener referenced by the add-in manifest. */
  port: number;
  /** PEM certificate path. Defaults to ~/.office-addin-dev-certs/localhost.crt. */
  certPath?: string;
  /** PEM private key path. Defaults to ~/.office-addin-dev-certs/localhost.key. */
  keyPath?: string;
  /** Directory containing the built task pane bundle (apps/app dist-word-addin). */
  distPath?: string;
}

export interface RecorderLiveTranscriptStatus {
  available: boolean;
  recordingActive: boolean;
  liveTranscriptActive: boolean;
  fileName: string | null;
  error: string | null;
}

export interface RecorderBridge {
  library?: {
    list: () => Promise<AudioRecordingMeta[]>;
    read: (id: string) => Promise<AudioRecordingDetail | null>;
    rename: (id: string, title: string) => Promise<void>;
    link: (id: string, projectId: string, linked: boolean) => Promise<void>;
    trash: (id: string) => Promise<void>;
    control: (input: { action: "status" | "start" | "stop"; title?: string; projectId?: string; recordingId?: string; sources?: ("microphone" | "system")[] }) => Promise<unknown>;
  };
  /** The local profile's retained recordings. Library routes require owner access. */
  listRecordings?: () => Promise<AudioRecordingMeta[]>;
  readRecording?: (id: string) => Promise<AudioRecordingDetail | null>;
  listProjectRecordings?: (projectId: string) => Promise<Pick<AudioRecordingMeta, "id" | "title" | "durationMs" | "status" | "segmentCount">[]>;
  readProjectRecording?: (projectId: string, id: string) => Promise<Pick<AudioRecordingDetail, "segments"> | null>;
  /** Copy a finished recording linked to the project into its `recordings/` folder, for project sync; false when not written. */
  exportProjectRecording?: (projectId: string, id: string, projectRoot: string) => Promise<boolean>;
  status: (workspacePath: string) => RecorderLiveTranscriptStatus | Promise<RecorderLiveTranscriptStatus>;
  setLiveTranscript: (
    enabled: boolean,
    workspacePath: string,
  ) => RecorderLiveTranscriptStatus | Promise<RecorderLiveTranscriptStatus>;
}

export interface ServerConfig {
  /** Read-only migration from the previous desktop safeStorage connector store. */
  decryptLegacyConnectorSecrets?: (value: string) => string | Promise<string>;
  /** In-process cloud replica hooks; never accepted from a client/config JSON. */
  cloudSync?: {
    role?: "executor" | "files" | "companion";
    canExecute: () => boolean;
    prepareWorkspace: (id: string) => Promise<unknown>;
    shouldSyncFiles: (id: string) => boolean;
    maintainsProject?: (id: string) => boolean;
    deviceName: string;
    checkpoint?: () => Promise<unknown>;
    beginCheckpoint?: () => Promise<() => void>;
    runEngineRequest?: (execute: () => Promise<Response>) => Promise<Response>;
    resume?: () => Promise<{ role: "files" | "executor" | "companion"; canExecute: boolean; nextRunAt: string | null }>;
    ready?: () => Promise<{ role: "files" | "executor" | "companion"; canExecute: boolean; nextRunAt: string | null }>;
    status?: () => Promise<unknown>;
    onLeaseLost?: () => void;
  };
  host: string;
  port: number;
  token: string;
  hostToken: string;
  configPath?: string;
  wordAddin?: WordAddinConfig;
  /** Native host default for new project folders; existing workspace paths stay authoritative. */
  projectsDirectory?: string;
  /**
   * Host-app hook that opens a native "choose folder" dialog. Set by the
   * desktop app (which owns OS dialogs); null when the server runs
   * standalone. Lets webview clients like the Office task pane pick folders.
   * returnFocusTo names the Office app ("word" | "excel" | "powerpoint")
   * to re-activate after the dialog closes, since showing the dialog steals
   * focus from it.
   */
  pickDirectory?: ((options: { title?: string; defaultPath?: string; returnFocusTo?: string }) => Promise<string | null>) | null;
  /** Desktop-owned recorder controls used by browser-hosted Office add-ins. */
  recorder?: RecorderBridge | null;
  /** In-process host confirmation. Never set from client input or persisted config. */
  requestHostApproval?: HostApprovalHandler;
  /** Host-owned managed execution capability, not the user’s sandbox preference. Routes both native and protected commands; never accepted from API config patches. */
  agentSandboxEnabled?: boolean;
  /** Host-owned admission boundary for native project automation discovery. */
  engineProjectTrustRequired?: boolean;
  /** Host-owned source policy. Managed engines ignore project/ancestor native discovery. */
  engineConfigurationMode?: "managed" | "native-project";
  managedEngineStorageDirectory?: string;
  /** Host-owned history identity and current owned connection; never client configuration. */
  managedImageAffinity?: (workspace: WorkspaceInfo) => import("./managed-image-affinity.js").ManagedImageAffinity | undefined;
  /** Explicit host-generated integrations; never read from authored/API config. */
  managedEnginePluginDirectories?: string[];
  managedEngineStarting?: boolean;
  waitForManagedEngineEndpoint?: () => Promise<void>;
  /** Host-only coordinator state; never accepted from project/client config. */
  managedEngineRecoveryState?: () => { mode: "service" | "recovery" | "promoting"; heldSessions: Array<{ id: string; directory: string }>; error?: { code: string; message: string } };
  retryManagedEngineRecovery?: () => Promise<void>;
  withManagedEngineAdmission?: (sessionID: string, action: () => Promise<Response>) => Promise<Response>;
  observeManagedEngineResponse?: (request: { method: string; path: string; directory: string }, response: Response) => Promise<void>;
  opencodeBaseUrl?: string;
  opencodeDirectory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  approval: ApprovalConfig;
  corsOrigins: string[];
  workspaces: WorkspaceInfo[];
  workspaceWarnings?: string[];
  authorizedRoots: string[];
  readOnly: boolean;
  /** Background setup of the layout model and the small OCR model when selected; enabled by resolved host config. */
  autoDownloadOcr?: boolean;
  startedAt: number;
  tokenSource: "cli" | "env" | "file" | "generated";
  hostTokenSource: "cli" | "env" | "file" | "generated";
  logFormat: LogFormat;
  logRequests: boolean;
}

export interface Capabilities {
  schemaVersion: number;
  serverVersion: string;
  opencodeVersion: string;
  skills: { read: boolean; write: boolean; source: "legalwork" | "opencode" };
  skillResources: { read: boolean; write: boolean };
  hub: {
    skills: {
      read: boolean;
      install: boolean;
      repo?: { owner: string; name: string; ref: string };
    };
  };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };

  approvals: { mode: ApprovalMode; timeoutMs: number };
  sandbox: { enabled: boolean; backend: SandboxBackend };
  ui: { toy: boolean };
  tokens: { scoped: boolean; scopes: TokenScope[] };
  proxy: {
    opencode: boolean;
  };
  toolProviders: {
    browser: {
      enabled: boolean;
      placement: ProviderPlacement;
      mode: "none" | "headless" | "interactive";
    };
    files: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
}

export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type ReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export interface ReloadEvent {
  id: string;
  seq: number;
  workspaceId: string;
  reason: ReloadReason;
  trigger?: ReloadTrigger;
  timestamp: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface PluginItem {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
}

export interface McpItem {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
}

export interface SkillItem {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
  kind?: "workflow";
  workflowType?: "tabular" | "assistant";
  /** From the firm's hub (firm-hub.ts): installed for everyone, or added by the member. Members cannot change it. */
  firm?: "automatic" | "optional";
}

export interface HubSkillItem {
  name: string;
  description: string;
  trigger?: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  };
}

export interface CommandItem {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
}

export interface Actor {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
  scope?: TokenScope;
}

export interface ApprovalRequest extends HostApprovalRequest {
  actor: Actor;
}

export type HostApprovalHandler = (
  request: ApprovalRequest,
  signal: AbortSignal,
) => Promise<"allow" | "deny">;

export interface AuditEntry {
  id: string;
  workspaceId: string;
  actor: Actor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
}
