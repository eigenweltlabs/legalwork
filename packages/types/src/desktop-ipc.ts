/**
 * Shared contract for the Electron desktop IPC bridge.
 *
 * Producer: apps/desktop/electron/main.mjs — `desktopCommandHandlers`, typed
 * via JSDoc against `DesktopCommandHandlers` so missing/extra/renamed
 * commands fail `typecheck:electron`.
 * Consumer: apps/app/src/app/lib/desktop.ts — the `desktopBridge` Proxy and
 * its named exports derive per-command signatures from `DesktopCommandMap`.
 *
 * Every command sent over the `legalwork:desktop` channel has exactly one
 * entry here: `args` is the tuple the renderer passes, `result` what the
 * main process resolves. Results marked `unknown` are not yet modeled —
 * tighten them instead of widening call sites.
 */
import type { WorkspaceWire } from "./workspace.js";

// ---------------------------------------------------------------------------
// Payload shapes (moved from apps/app/src/app/lib/desktop-types.ts, which
// re-exports them — keep that file as the app-side import path).
// ---------------------------------------------------------------------------

export type OpencodeExecutionEnvEntry = {
  name: string;
  value: string;
  redacted: boolean;
};

export type OpencodeExecutionSnapshot = {
  command: string;
  args: string[];
  cwd: string;
  env: OpencodeExecutionEnvEntry[];
};

export type EngineInfo = {
  running: boolean;
  runtime: "direct";
  baseUrl: string | null;
  projectDir: string | null;
  hostname: string | null;
  port: number | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
  opencodeBinPath: string | null;
  opencodeBinSource: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
  execution: OpencodeExecutionSnapshot | null;
};

export type LegalworkServerInfo = {
  running: boolean;
  remoteAccessEnabled: boolean;
  host: string | null;
  port: number | null;
  baseUrl: string | null;
  connectUrl: string | null;
  mdnsUrl: string | null;
  lanUrl: string | null;
  clientToken: string | null;
  ownerToken: string | null;
  hostToken: string | null;
  managedOpencodeBinPath: string | null;
  managedOpencodeBinSource: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
};

export type EngineDoctorResult = {
  found: boolean;
  inPath: boolean;
  resolvedPath: string | null;
  resolvedSource: string | null;
  version: string | null;
  supportsServe: boolean;
  notes: string[];
  serveHelpStatus: number | null;
  serveHelpStdout: string | null;
  serveHelpStderr: string | null;
};

export type WorkspaceList = {
  selectedId?: string;
  watchedId?: string | null;
  activeId?: string | null;
  workspaces: WorkspaceWire[];
};

export type WorkspaceExportSummary = {
  outputPath: string;
  included: number;
  excluded: string[];
};

export type OpencodeCommandDraft = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
};

export type WorkspaceLegalworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

export type AppBuildInfo = {
  version: string;
  gitSha?: string | null;
  buildEpoch?: string | null;
  legalworkDevMode?: boolean;
  os?: string | null;
  arch?: string | null;
};

export type DesktopBootstrapConfig = {
  baseUrl: string;
  apiBaseUrl?: string | null;
  requireSignin: boolean;
};

export type OrchestratorDetachedHost = {
  legalworkUrl: string;
  token: string;
  ownerToken?: string | null;
  hostToken: string;
  port: number;
  /** "none" | "docker" | "microsandbox" today; kept open like WorkspaceWire. */
  sandboxBackend?: string | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
};

export type SandboxDoctorResult = {
  installed: boolean;
  daemonRunning: boolean;
  permissionOk: boolean;
  ready: boolean;
  clientVersion?: string | null;
  serverVersion?: string | null;
  error?: string | null;
  debug?: {
    candidates: string[];
    selectedBin?: string | null;
    versionCommand?: {
      status: number;
      stdout: string;
      stderr: string;
    } | null;
    infoCommand?: {
      status: number;
      stdout: string;
      stderr: string;
    } | null;
  } | null;
};

export type LegalworkDockerCleanupResult = {
  candidates: string[];
  removed: string[];
  errors: string[];
};

export type SandboxDebugProbeResult = {
  startedAt: number;
  finishedAt: number;
  runId: string;
  workspacePath: string;
  ready: boolean;
  doctor: SandboxDoctorResult;
  detachedHost?: OrchestratorDetachedHost | null;
  dockerInspect?: {
    status: number;
    stdout: string;
    stderr: string;
  } | null;
  dockerLogs?: {
    status: number;
    stdout: string;
    stderr: string;
  } | null;
  cleanup: {
    containerName?: string | null;
    containerRemoved: boolean;
    removeResult?: {
      status: number;
      stdout: string;
      stderr: string;
    } | null;
    workspaceRemoved: boolean;
    errors: string[];
  };
  error?: string | null;
};

export type ExecResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
};

export type LocalSkillCard = {
  name: string;
  path: string;
  description?: string;
  trigger?: string;
};

export type LocalSkillContent = {
  path: string;
  content: string;
};

export type OpencodeConfigFile = {
  path: string;
  exists: boolean;
  content: string | null;
};

export type UpdaterEnvironment = {
  supported: boolean;
  reason: string | null;
  executablePath: string | null;
  appBundlePath: string | null;
};

export type CacheResetResult = {
  removed: string[];
  missing: string[];
  errors: string[];
};

export type DesktopFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type DesktopFetchResult = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
};

export type WorkspaceCreateInput = {
  folderPath: string;
  name?: string | null;
  preset?: string | null;
};

export type WorkspaceCreateRemoteInput = {
  baseUrl: string;
  remoteType?: "legalwork" | "opencode" | null;
  directory?: string | null;
  displayName?: string | null;
  legalworkHostUrl?: string | null;
  legalworkToken?: string | null;
  legalworkClientToken?: string | null;
  legalworkHostToken?: string | null;
  legalworkWorkspaceId?: string | null;
  legalworkWorkspaceName?: string | null;
  sandboxBackend?: string | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
};

export type WorkspaceUpdateRemoteInput = WorkspaceCreateRemoteInput & {
  workspaceId: string;
};

export type UiControlBridgeInfo = {
  baseUrl?: string;
  token?: string;
};

export type ComputerUsePermissions = {
  ok: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  error?: string;
};

export type RunningAppsResult = {
  ok: boolean;
  apps: string[];
};

export type OfficeAddinAppId = "word" | "excel" | "powerpoint";

export type OfficeAddinAppStatus = {
  id: OfficeAddinAppId;
  label: string;
  /** The Office app is installed on this machine. */
  installed: boolean;
  /** The user has installed the LegalWork add-in for this app. */
  enabled: boolean;
  /** The LegalWork manifest is present in this app's sideload folder. */
  manifestInstalled: boolean;
};

export type OfficeAddinStatus = {
  /** The current platform supports installing the add-in (macOS today). */
  supported: boolean;
  platform: string;
  /** OpenSSL (needed to generate the certificate) is available. */
  toolAvailable: boolean;
  /** The add-in is installed and the HTTPS listener is enabled. */
  enabled: boolean;
  port: number;
  installedAt: number | null;
  certPresent: boolean;
  /** The localhost CA is trusted by the OS. */
  certTrusted: boolean;
  caFingerprint: string | null;
  /** The built task pane bundle is available to serve. */
  paneBundlePresent: boolean;
  apps: OfficeAddinAppStatus[];
};

export type OfficeAddinActionResult = {
  ok: boolean;
  error?: string;
  steps?: Array<{ step: string; ok: boolean; skipped?: boolean; error?: string; apps?: unknown }>;
  status: OfficeAddinStatus;
};

// ---------------------------------------------------------------------------
// The command map
// ---------------------------------------------------------------------------

export type DesktopCommandMap = {
  // Workspace state
  workspaceBootstrap: { args: []; result: WorkspaceList };
  workspaceSetSelected: { args: [workspaceId: string]; result: WorkspaceList };
  workspaceSetRuntimeActive: { args: [workspaceId: string | null]; result: WorkspaceList };
  workspaceCreate: { args: [input: WorkspaceCreateInput]; result: WorkspaceList };
  workspaceCreateRemote: { args: [input: WorkspaceCreateRemoteInput]; result: WorkspaceList };
  workspaceUpdateRemote: { args: [input: WorkspaceUpdateRemoteInput]; result: WorkspaceList };
  workspaceUpdateDisplayName: {
    args: [input: { workspaceId: string; displayName?: string | null }];
    result: WorkspaceList;
  };
  workspaceForget: { args: [workspaceId: string]; result: WorkspaceList };
  workspaceAddAuthorizedRoot: {
    args: [input: { workspacePath: string; folderPath?: string; authorizedRoot?: string }];
    result: unknown;
  };
  workspaceLegalworkRead: {
    args: [input: { workspacePath: string }];
    result: WorkspaceLegalworkConfig;
  };
  workspaceLegalworkWrite: {
    args: [input: { workspacePath: string; config: WorkspaceLegalworkConfig }];
    result: unknown;
  };
  workspaceExportConfig: {
    args: [input: { workspaceId: string; outputPath: string }];
    result: WorkspaceExportSummary;
  };
  workspaceImportConfig: {
    args: [input: { archivePath: string; targetDir: string; name?: string | null }];
    result: unknown;
  };

  // Opencode custom commands
  opencodeCommandList: {
    args: [input: { scope: string; projectDir?: string }];
    result: string[];
  };
  opencodeCommandWrite: {
    args: [input: { scope: string; projectDir?: string; command: OpencodeCommandDraft }];
    result: unknown;
  };
  opencodeCommandDelete: {
    args: [input: { scope: string; projectDir?: string; name: string }];
    result: unknown;
  };

  // Engine / runtime lifecycle
  engineStart: { args: [projectDir: string, options?: Record<string, unknown>]; result: EngineInfo };
  prepareFreshRuntime: { args: []; result: unknown };
  runtimeBootstrap: { args: []; result: unknown };
  runtimeStatus: { args: []; result: unknown };
  engineStop: { args: []; result: EngineInfo };
  engineRestart: { args: [options?: Record<string, unknown>]; result: EngineInfo };
  engineInfo: { args: []; result: EngineInfo };
  engineDoctor: { args: [projectDir?: string]; result: EngineDoctorResult };
  engineInstall: { args: []; result: unknown };
  orchestratorStatus: { args: []; result: unknown };
  orchestratorWorkspaceActivate: { args: [input?: Record<string, unknown>]; result: unknown };
  orchestratorInstanceDispose: { args: [instanceId: string]; result: unknown };
  orchestratorStartDetached: {
    args: [input?: Record<string, unknown>];
    result: OrchestratorDetachedHost;
  };

  // App / bridge info
  appBuildInfo: { args: []; result: AppBuildInfo };
  getUiControlBridgeInfo: { args: []; result: UiControlBridgeInfo | null };
  getLegalworkUiMcpCommand: { args: []; result: string[] };
  getComputerUseMcpCommand: { args: []; result: string[] };
  getLegalworkUiMcpEnvironment: { args: []; result: Record<string, string> };

  // Computer use
  checkComputerUsePermissions: { args: []; result: ComputerUsePermissions };
  listRunningApps: { args: []; result: RunningAppsResult };
  openComputerUsePermissionSetup: { args: []; result: ComputerUsePermissions };
  openComputerUsePermissionSettings: { args: []; result: unknown };

  // Bootstrap config
  getDesktopBootstrapConfig: { args: []; result: DesktopBootstrapConfig };
  debugDesktopBootstrapConfig: { args: []; result: unknown };
  setDesktopBootstrapConfig: {
    args: [config: Partial<DesktopBootstrapConfig>];
    result: DesktopBootstrapConfig;
  };
  nukeLegalworkAndOpencodeConfigAndExit: { args: []; result: unknown };

  // Sandbox
  sandboxDoctor: { args: []; result: SandboxDoctorResult };
  sandboxStop: { args: [runId: string]; result: unknown };
  sandboxCleanupLegalworkContainers: { args: []; result: LegalworkDockerCleanupResult };
  sandboxDebugProbe: { args: []; result: SandboxDebugProbeResult };

  // Legalwork server sidecar
  legalworkServerInfo: { args: []; result: LegalworkServerInfo };
  legalworkServerRestart: {
    args: [options?: Record<string, unknown>];
    result: LegalworkServerInfo;
  };

  // Office add-ins (Word/Excel/PowerPoint task pane)
  officeAddinStatus: { args: []; result: OfficeAddinStatus };
  officeAddinInstall: { args: [app: OfficeAddinAppId]; result: OfficeAddinActionResult };
  officeAddinUninstall: { args: [app: OfficeAddinAppId]; result: OfficeAddinActionResult };

  // Dialogs
  pickDirectory: {
    args: [options?: { title?: string; defaultPath?: string; multiple?: boolean }];
    result: string | string[] | null;
  };
  pickFile: {
    args: [
      options?: {
        title?: string;
        defaultPath?: string;
        multiple?: boolean;
        filters?: { name: string; extensions: string[] }[];
      },
    ];
    result: string | string[] | null;
  };
  saveFile: {
    args: [options?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }];
    result: string | null;
  };

  // Skills
  importSkill: {
    args: [projectDir: string, sourceDir: string, options?: { overwrite?: boolean; targetName?: string }];
    result: ExecResult;
  };
  installSkillTemplate: {
    args: [projectDir: string, name: string, content: string, options?: { overwrite?: boolean }];
    result: ExecResult;
  };
  // Write a whole skill folder (SKILL.md + supporting files) at once. Files carry
  // base64 content + an exec bit. Empty projectDir → global skills dir.
  installSkillFiles: {
    args: [
      projectDir: string,
      name: string,
      files: Array<{ path: string; contentBase64: string; executable?: boolean }>,
      options?: { overwrite?: boolean },
    ];
    result: ExecResult;
  };
  listLocalSkills: { args: [projectDir: string]; result: LocalSkillCard[] };
  readLocalSkill: { args: [projectDir: string, skillName: string]; result: LocalSkillContent };
  writeLocalSkill: {
    args: [projectDir: string, skillName: string, content: string];
    result: ExecResult;
  };
  uninstallSkill: { args: [projectDir: string, skillName: string]; result: ExecResult };
  // Zip a skill/workflow folder (SKILL.md + resources/ + supporting files) to
  // outputPath — the self-contained shareable form. Empty projectDir → global
  // skills dir, same resolution as readLocalSkill.
  exportSkillZip: {
    args: [projectDir: string, skillName: string, outputPath: string];
    result: ExecResult;
  };
  // Install a skill from a zip (the shape exportSkillZip produces, or any zip
  // with SKILL.md at the root or under one top-level folder). asWorkflow adds
  // the workflow- name prefix the Workflows view detects.
  importSkillZip: {
    args: [projectDir: string, archivePath: string, options?: { overwrite?: boolean; asWorkflow?: boolean }];
    result: ExecResult;
  };
  // One-time lift of per-workspace skills + MCP into the global config. No args →
  // self-enumerates all local workspaces.
  migrateExtensionsToGlobal: {
    args: [projectDirs?: string[]];
    result: { skillsCopied: number; mcpMerged: number; errors: string[] };
  };

  // Updater / config / resets
  updaterEnvironment: { args: []; result: UpdaterEnvironment };
  readOpencodeConfig: { args: [scope: string, projectDir?: string]; result: OpencodeConfigFile };
  writeOpencodeConfig: {
    args: [scope: string, projectDir: string, content: string];
    result: ExecResult;
  };
  /**
   * The renderer passes its reset-modal mode, but the main process currently
   * IGNORES it and always removes workspace state + bootstrap config; only
   * the renderer's localStorage cleanup is mode-scoped. Follow-up: decide
   * whether "onboarding" should preserve desktop workspace state.
   */
  resetLegalworkState: { args: [mode?: "onboarding" | "all"]; result: unknown };
  resetOpencodeCache: { args: []; result: CacheResetResult };
  opencodeMcpAuth: { args: [action: string, name: string]; result: ExecResult };
  setWindowDecorations: { args: [decorated: boolean]; result: unknown };

  // Window / OS utilities (dunder commands)
  __openPath: { args: [target: string]; result: unknown };
  __revealItemInDir: { args: [target: string]; result: unknown };
  __getFileIcon: { args: [target: string, size?: "small" | "normal" | "large"]; result: string | null };
  __getApplicationsForFile: { args: [target: string]; result: { name: string; appPath: string; icon: string | null }[] };
  __openWithApp: { args: [target: string, appPath: string]; result: unknown };
  __fetch: { args: [url: string, init?: DesktopFetchInit]; result: DesktopFetchResult };
  __homeDir: { args: []; result: string };
  __joinPath: { args: [...segments: string[]]; result: string };
  __setZoomFactor: { args: [factor: number]; result: boolean };
  __setNativeTheme: { args: [theme: string]; result: unknown };
  __setApplicationMenuVisible: { args: [visible: boolean]; result: unknown };
};

export type DesktopCommandName = keyof DesktopCommandMap;

export type DesktopCommandArgs<C extends DesktopCommandName> = DesktopCommandMap[C]["args"];

export type DesktopCommandResult<C extends DesktopCommandName> = DesktopCommandMap[C]["result"];

/**
 * Main-process handler registry shape. `Event` is electron's
 * IpcMainInvokeEvent (kept generic so this package does not depend on
 * electron types).
 *
 * Args are deliberately loose (`any[]`) on this side: IPC input crosses a
 * trust boundary, so handlers validate/normalize whatever arrives with
 * defensive dynamic access (`String(args[0] ?? "")`, `input.foo ?? null`)
 * rather than assuming the renderer's tuple. `unknown[]` would force ~50
 * narrowing rewrites in the plain-JS main process for no runtime gain.
 * Key parity and result types are still enforced.
 */
export type DesktopCommandHandlers<Event = unknown> = {
  [C in DesktopCommandName]: (
    event: Event,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) => Promise<DesktopCommandResult<C>>;
};

/** Renderer-side bridge: one async function per command. */
export type DesktopCommandInvokers = {
  [C in DesktopCommandName]: (...args: DesktopCommandArgs<C>) => Promise<DesktopCommandResult<C>>;
};
