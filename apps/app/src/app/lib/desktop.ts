import { openOfficeBrowserWindow } from "@/word-addin/office";
import { nativeDeepLinkEvent } from "./deep-link-bridge";
import { fetchDesktopText } from "./desktop-text-fetch";
import { fetchDesktopStream } from "./desktop-stream-fetch";

export type * from "./desktop-types";
export type {
  EngineInfo,
  LegalworkServerInfo,
  EngineDoctorResult,
  WorkspaceInfo,
  WorkspaceList,
  WorkspaceExportSummary,
  OpencodeCommandDraft,
  WorkspaceLegalworkConfig,
  AppBuildInfo,
  DesktopBootstrapConfig,
  OrchestratorDetachedHost,
  SandboxDoctorResult,
  LegalworkDockerCleanupResult,
  SandboxDebugProbeResult,
  ExecResult,
  LocalSkillCard,
  LocalSkillContent,
  OpencodeConfigFile,
  UpdaterEnvironment,
  CacheResetResult,
} from "./desktop-types";

import type {
  DesktopCommandArgs,
  DesktopCommandInvokers,
  DesktopCommandName,
  DesktopCommandResult,
  WorkspaceList,
} from "./desktop-types";
import type { BrowserPanelTab } from "./desktop-types";

export type BrowserStatePayload = {
  focusedTabId?: string;
  activeTabId?: string | null;
  tabs?: BrowserPanelTab[];
};

export type BrowserProxyState = {
  proxy: { rules: string; authenticated: boolean } | null;
};

// ---------------------------------------------------------------------------
// Electron bridge surface
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __LEGALWORK_ELECTRON__?: {
      invokeDesktop?: <C extends DesktopCommandName>(
        command: C,
        ...args: DesktopCommandArgs<C>
      ) => Promise<DesktopCommandResult<C>>;
      files?: {
        copyIntoProject?: (workspaceId: string, files: File[], folder?: string) => Promise<import("@legalwork/types/desktop-ipc").WorkspaceCopyFilesResult>;
      };
      shell?: {
        openExternal?: (url: string) => Promise<void>;
        relaunch?: () => Promise<void>;
      };
      system?: {
        getArchitectureInfo?: () => Promise<{
          appArch: string;
          appArchLabel: string;
          systemArch: string;
          systemArchLabel: string;
          mismatch: boolean;
          platform: "darwin" | "linux" | "windows";
          version: string;
          downloadUrl: string | null;
          releaseUrl: string;
        }>;
        getArchitectureDownload?: () => Promise<{
          status: "available" | "unavailable" | "error";
          downloadUrl: string | null;
        }>;
        getMicrophoneStatus?: () => Promise<{
          platform: string;
          status: string;
        }>;
        askMicrophoneAccess?: () => Promise<{
          platform: string;
          before?: string;
          after?: string;
          status?: string;
          granted: boolean;
        }>;
      };
      migration?: {
        readSnapshot?: () => Promise<unknown>;
        ackSnapshot?: () => Promise<{ ok: boolean; moved: boolean }>;
      };
      updater?: {
        getPreferences?: (legacy?: { autoCheck?: boolean; autoDownload?: boolean }) => Promise<{ autoCheck: boolean; autoDownload: boolean }>;
        setPreferences?: (patch: { autoCheck?: boolean; autoDownload?: boolean }) => Promise<{ autoCheck: boolean; autoDownload: boolean }>;
        getChannel?: () => Promise<{
          channel: "stable" | "prerelease" | "alpha";
          feedUrl: string;
          currentVersion: string;
        }>;
        setChannel?: (channel: "stable" | "prerelease" | "alpha") => Promise<{
          channel: "stable" | "prerelease" | "alpha";
          feedUrl: string;
          currentVersion: string;
        }>;
        check?: (channel?: "stable" | "prerelease" | "alpha") => Promise<{
          available: boolean;
          currentVersion?: string;
          latestVersion?: string | null;
          releaseDate?: string | null;
          releaseNotes?: unknown;
          channel?: "stable" | "prerelease" | "alpha";
          feedUrl?: string;
          reason?: string;
        }>;
        download?: () => Promise<{ ok: boolean; reason?: string }>;
        installAndRestart?: () => Promise<{ ok: boolean; reason?: string }>;
      };
      browser?: {
        registerConnection?: (connection: { baseUrl: string; token: string }) => Promise<{ connectionId: string }>;
        attachSession?: (context: { workspaceId: string; sessionId: string; directory?: string; connectionId?: string; takeControl?: boolean }) => Promise<{ attached: boolean }>;
        connection?: (tabId: string, context: { workspaceId: string; sessionId: string; directory?: string; connectionId?: string }) => Promise<unknown>;
        show?: (bounds: { x: number; y: number; width: number; height: number }, tabId?: string) => Promise<void>;
        hide?: (tabId?: string) => Promise<void>;
        openUrl?: (url: string, provider?: "auto" | "builtin" | "external", context?: { directory?: string; workspaceId?: string; sessionId?: string; connectionId?: string }) => Promise<{
          provider: "builtin";
          browser_url: string;
          target_id: string;
          tab_id: string;
          url: string;
          download_directory: string | null;
          downloads: unknown[];
          snapshot: unknown;
        }>;
        navigate?: (url: string, tabId?: string) => Promise<void>;
        back?: (tabId?: string) => Promise<void>;
        forward?: (tabId?: string) => Promise<void>;
        reload?: (tabId?: string) => Promise<void>;
        setBounds?: (bounds: { x: number; y: number; width: number; height: number }, tabId?: string) => Promise<void>;
        getState?: () => Promise<BrowserStatePayload | null>;
        createTab?: (url?: string) => Promise<{ tabId: string }>;
        closeTab?: (tabId: string) => Promise<string | null>;
        dismissTab?: (tabId: string) => Promise<void>;
        releaseSession?: (sessionId: string) => Promise<void>;
        previewTab?: (tabId: string) => Promise<string | null>;
        closeAllTabs?: () => Promise<string[]>;
        selectTab?: (tabId: string) => Promise<string>;
        reorderTabs?: (tabIds: string[]) => Promise<BrowserPanelTab[]>;
        listTabs?: () => Promise<BrowserPanelTab[]>;
        setProxy?: (proxy?: string | null, context?: { workspaceId?: string; sessionId?: string }) => Promise<BrowserProxyState>;
        getProxy?: () => Promise<BrowserProxyState>;
        showTabContextMenu?: (tabId: string, point?: { x: number; y: number }) => Promise<void>;
        destroy?: () => Promise<void>;
        onStateChange?: (callback: (state: BrowserStatePayload) => void) => () => void;
        onPanelOpened?: (callback: () => void) => () => void;
        onPanelClosed?: (callback: () => void) => () => void;
      };
      audio?: {
        sendPcm?: (streamId: string, buffer: ArrayBuffer, source?: import("@legalwork/types/audio").AudioCaptureSourceKind) => void;
        sendDictationLevel?: (level: number) => void;
        sendMeetingLevel?: (recordingId: string, level: number) => void;
        sendMediaChunk?: (recordingId: string, chunk: ArrayBuffer, source?: import("@legalwork/types/audio").AudioCaptureSourceKind) => void;
        sendAskAnswer?: (askId: string, text: string, done: boolean, error?: string | null) => void;
        onEvent?: (callback: (event: import("@legalwork/types/audio").AudioRecorderEvent) => void) => () => void;
        onAppPcm?: (callback: (payload: { sampleRate: number; buffer: ArrayBuffer }) => void) => () => void;
      };
      terminal?: {
        create?: (options: { cwd: string; cols: number; rows: number }) => Promise<{ terminalId: string }>;
        write?: (terminalId: string, data: string) => Promise<void>;
        resize?: (terminalId: string, cols: number, rows: number) => Promise<void>;
        kill?: (terminalId: string) => Promise<void>;
        onData?: (callback: (payload: { terminalId: string; data: string }) => void) => () => void;
        onExit?: (callback: (payload: { terminalId: string; exitCode: number | null; signal?: number }) => void) => () => void;
      };
      meta?: {
        initialDeepLinks?: string[];
        platform?: "darwin" | "linux" | "windows";
        version?: string;
      };
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function invokeElectronHelper<C extends DesktopCommandName>(
  command: C,
  ...args: DesktopCommandArgs<C>
): Promise<DesktopCommandResult<C>> {
  const invokeDesktop = window.__LEGALWORK_ELECTRON__?.invokeDesktop;
  if (!invokeDesktop) {
    throw new Error(`Electron desktop helper is unavailable: ${command}`);
  }
  return (await invokeDesktop(command, ...args)) as DesktopCommandResult<C>;
}

// Pure utility — resolves the selected workspace ID from a workspace list
// payload, handling legacy fields.
export function resolveWorkspaceListSelectedId(
  list: Pick<WorkspaceList, "selectedId" | "activeId"> | null | undefined,
): string {
  return list?.selectedId?.trim() || list?.activeId?.trim() || "";
}

// ---------------------------------------------------------------------------
// Desktop bridge (Electron IPC proxy)
// ---------------------------------------------------------------------------

// All bridge methods are implemented via invokeDesktop IPC. The Proxy
// automatically maps property access to `invokeDesktop(propertyName, ...args)`.
// Per-command signatures come from the shared DesktopCommandMap contract
// (packages/types/src/desktop-ipc.ts), so every destructured export below is
// precisely typed against what the Electron main process implements.

type DesktopBridge = DesktopCommandInvokers & {
  resolveWorkspaceListSelectedId: typeof resolveWorkspaceListSelectedId;
};

type DesktopBridgeFn = (...args: unknown[]) => Promise<unknown>;

const electronBridge: Record<string, DesktopBridgeFn> = {};

// The cast is inherent to the Proxy pattern: the target is an empty cache and
// members are fabricated on access. The contract typing above is what keeps
// it honest (command names + signatures are checked on both sides).
export const desktopBridge = new Proxy(electronBridge, {
  get(target, prop) {
    if (typeof prop !== "string") return undefined;

    // resolveWorkspaceListSelectedId is a pure function, not an IPC call
    if (prop === "resolveWorkspaceListSelectedId") {
      return resolveWorkspaceListSelectedId;
    }

    const cached = target[prop];
    if (cached) return cached;

    const fn = async (...args: unknown[]) => {
      const invokeDesktop = window.__LEGALWORK_ELECTRON__?.invokeDesktop;
      if (!invokeDesktop) {
        throw new Error(`Electron desktop helper is unavailable: ${prop}`);
      }
      // The Proxy is the one dynamic point in the bridge: `prop` is whatever
      // property was accessed, already constrained by the DesktopBridge
      // surface this Proxy is exported as.
      return invokeDesktop(
        prop as DesktopCommandName,
        ...(args as DesktopCommandArgs<DesktopCommandName>),
      );
    };
    target[prop] = fn;
    return fn;
  },
}) as unknown as DesktopBridge;

// ---------------------------------------------------------------------------
// desktopFetch — proxies non-loopback requests through Electron main process
// ---------------------------------------------------------------------------

function isLoopbackUrl(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  try {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

export const desktopFetch: typeof globalThis.fetch = async (input, init) => {
  if (isLoopbackUrl(input)) {
    return globalThis.fetch(input, init);
  }

  return fetchDesktopText(desktopBridge, input, init);
};

// Finite JSON reads expose body progress to their inactivity deadline. The
// SDK's transport keeps its existing buffered semantics for long model turns.
export const desktopReadFetch: typeof globalThis.fetch = (input, init) => {
  if (isLoopbackUrl(input) || !window.__LEGALWORK_ELECTRON__?.invokeDesktop) return globalThis.fetch(input, init);
  return fetchDesktopStream(desktopBridge, input, init);
};

export const desktopStreamFetch: typeof globalThis.fetch = (input, init) => {
  if (!window.__LEGALWORK_ELECTRON__?.invokeDesktop) return globalThis.fetch(input, init);
  return fetchDesktopStream(desktopBridge, input, init);
};

export async function desktopFetchViaMain(input: RequestInfo | URL, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  return fetchDesktopText(desktopBridge, input, init, timeoutMs);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export async function openDesktopUrl(url: string): Promise<void> {
  const openExternal = window.__LEGALWORK_ELECTRON__?.shell?.openExternal;
  if (openExternal) {
    await openExternal(url);
    return;
  }
  // The Office task pane: its webview blocks window.open.
  if (openOfficeBrowserWindow(url)) return;
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export async function openDesktopPath(target: string): Promise<void> {
  const result = await invokeElectronHelper("__openPath", target);
  if (typeof result === "string" && result.trim()) {
    throw new Error(result);
  }
}

export async function composeAppleMailDraft(draft: import("@legalwork/types/desktop-ipc").NativeMailDraftInput): Promise<void> {
  await invokeElectronHelper("composeAppleMailDraft", draft);
}

export async function composeOutlookDraft(draft: import("@legalwork/types/desktop-ipc").NativeMailDraftInput): Promise<void> {
  await invokeElectronHelper("composeOutlookDraft", draft);
}

export async function revealDesktopItemInDir(target: string): Promise<void> {
  await invokeElectronHelper("__revealItemInDir", target);
}

export async function getDesktopFileIcon(target: string, size?: "small" | "normal" | "large"): Promise<string | null> {
  return invokeElectronHelper("__getFileIcon", target, size);
}

export type DesktopApplication = {
  name: string;
  appPath: string;
  icon: string | null;
};

export async function getDesktopApplicationsForFile(target: string): Promise<DesktopApplication[]> {
  return invokeElectronHelper("__getApplicationsForFile", target);
}

export async function openDesktopWithApp(target: string, appPath: string): Promise<void> {
  const result = await invokeElectronHelper("__openWithApp", target, appPath);
  if (typeof result === "string" && result.trim()) {
    throw new Error(result);
  }
}

export async function relaunchDesktopApp(): Promise<void> {
  await window.__LEGALWORK_ELECTRON__?.shell?.relaunch?.();
}

export async function getDesktopHomeDir(): Promise<string> {
  return invokeElectronHelper("__homeDir");
}

export async function joinDesktopPath(...parts: string[]): Promise<string> {
  return invokeElectronHelper("__joinPath", ...parts);
}

export async function setDesktopZoomFactor(value: number): Promise<boolean> {
  return invokeElectronHelper("__setZoomFactor", value);
}

export async function subscribeDesktopDeepLinks(
  handler: (urls: string[]) => void,
): Promise<() => void> {
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<string[]>;
    if (Array.isArray(customEvent.detail)) {
      handler(customEvent.detail);
    }
  };
  window.addEventListener(nativeDeepLinkEvent, listener as EventListener);
  const initialUrls = window.__LEGALWORK_ELECTRON__?.meta?.initialDeepLinks;
  if (Array.isArray(initialUrls) && initialUrls.length > 0) {
    handler(initialUrls);
  }
  return () => {
    window.removeEventListener(nativeDeepLinkEvent, listener as EventListener);
  };
}

// ---------------------------------------------------------------------------
// Re-export bridge methods as named functions (preserves existing import API)
// ---------------------------------------------------------------------------

const {
  engineStart,
  workspaceBootstrap,
  workspaceSetSelected,
  workspaceSetRuntimeActive,
  workspaceCreate,
  workspaceUpdateDisplayName,
  workspaceForget,
  workspaceAddAuthorizedRoot,
  workspaceExportConfig,
  workspaceImportConfig,
  workspaceLegalworkRead,
  workspaceLegalworkWrite,
  opencodeCommandList,
  opencodeCommandWrite,
  opencodeCommandDelete,
  engineStop,
  engineRestart,
  appBuildInfo,
  getDesktopBootstrapConfig,
  setDesktopBootstrapConfig,
  nukeLegalworkAndOpencodeConfigAndExit,
  orchestratorStartDetached,
  sandboxDoctor,
  sandboxStop,
  sandboxCleanupLegalworkContainers,
  sandboxDebugProbe,
  legalworkServerInfo,
  legalworkServerRestart,
  runtimeBootstrap,
  supportBundleCollect,
  technicalSupportBundleCollect,
  engineInfo,
  engineDoctor,
  pickDirectory,
  pickFile,
  saveFile,
  engineInstall,
  importSkill,
  installSkillTemplate,
  installSkillFiles,
  listLocalSkills,
  importSkillsFromFolder,
  readLocalSkill,
  writeLocalSkill,
  uninstallSkill,
  exportSkillZip,
  importSkillZip,
  migrateExtensionsToGlobal,
  updaterEnvironment,
  readOpencodeConfig,
  writeOpencodeConfig,
  resetLegalworkState,
  resetOpencodeCache,
  opencodeMcpAuth,
  mcpOAuthListen,
  mcpOAuthWait,
  mcpOAuthCancel,
  setWindowDecorations,
  windowSetStealth,
  audioRecorderBootstrap,
  audioCapturePermissions,
  audioCapturePermissionsRequest,
  audioCaptureOpenSettings,
  audioModelsScanExisting,
  audioModelImport,
  audioTapListApps,
  audioTapStart,
  audioTapStop,
  audioModelDownload,
  audioModelDownloadCancel,
  audioModelDelete,
  audioDiarizationDownload,
  audioDiarizationStatus,
  audioTranscriberStart,
  audioTranscriberStop,
  audioRecordingStart,
  audioRecordingStop,
  audioRecordingCancel,
  audioRecordingsList,
  audioRecordingGet,
  audioRecordingEditTranscript,
  audioRecordingSummarize,
  audioRecordingDelete,
  audioRecordingRename,
  audioRecordingSetProject,
  audioRecordingRetain,
  audioRecordingSaveToWorkspace,
  audioLiveTranscriptStart,
  audioLiveTranscriptStop,
  audioImportStart,
  audioImportSource,
  audioImportFinish,
  audioLoopbackEnable,
  audioLoopbackDisable,
  audioOverlaySetVisible,
  audioOverlayGetVisible,
  audioSystemDictationGet,
  audioMiniBarSetEnabled,
  audioMeetingGet,
  audioMeetingDetectionSet,
  audioMeetingSetState,
  audioMeetingOpen,
  audioSystemDictationSetAppearance,
  audioSystemDictationSetEnabled,
  audioSystemDictationSetShortcut,
  audioSystemDictationSetShortcutCapture,
  audioSystemDictationOpenSettings,
  audioSystemDictationSetState,
  audioSystemDictationPaste,
  audioSystemDictationReadiness,
  audioSystemDictationMicrophonesGet,
  audioSystemDictationMicrophonesUpdate,
  audioSystemDictationMicrophoneSelect,
  audioSystemDictationMicrophoneActive,
  audioSystemDictationRequestPermission,
  audioSystemDictationRepairPermission,
  desktopLoginItemGet,
  desktopLoginItemSet,
  desktopNotificationShow,
  desktopBadgeSet,
} = desktopBridge;

export {
  engineStart,
  workspaceBootstrap,
  workspaceSetSelected,
  workspaceSetRuntimeActive,
  workspaceCreate,
  workspaceUpdateDisplayName,
  workspaceForget,
  workspaceAddAuthorizedRoot,
  workspaceExportConfig,
  workspaceImportConfig,
  workspaceLegalworkRead,
  workspaceLegalworkWrite,
  opencodeCommandList,
  opencodeCommandWrite,
  opencodeCommandDelete,
  engineStop,
  engineRestart,
  appBuildInfo,
  getDesktopBootstrapConfig,
  setDesktopBootstrapConfig,
  nukeLegalworkAndOpencodeConfigAndExit,
  orchestratorStartDetached,
  sandboxDoctor,
  sandboxStop,
  sandboxCleanupLegalworkContainers,
  sandboxDebugProbe,
  legalworkServerInfo,
  legalworkServerRestart,
  runtimeBootstrap,
  supportBundleCollect,
  technicalSupportBundleCollect,
  engineInfo,
  engineDoctor,
  pickDirectory,
  pickFile,
  saveFile,
  engineInstall,
  importSkill,
  installSkillTemplate,
  installSkillFiles,
  listLocalSkills,
  importSkillsFromFolder,
  readLocalSkill,
  writeLocalSkill,
  uninstallSkill,
  exportSkillZip,
  importSkillZip,
  migrateExtensionsToGlobal,
  updaterEnvironment,
  readOpencodeConfig,
  writeOpencodeConfig,
  resetLegalworkState,
  resetOpencodeCache,
  opencodeMcpAuth,
  mcpOAuthListen,
  mcpOAuthWait,
  mcpOAuthCancel,
  setWindowDecorations,
  windowSetStealth,
  audioRecorderBootstrap,
  audioCapturePermissions,
  audioCapturePermissionsRequest,
  audioCaptureOpenSettings,
  audioModelsScanExisting,
  audioModelImport,
  audioTapListApps,
  audioTapStart,
  audioTapStop,
  audioModelDownload,
  audioModelDownloadCancel,
  audioModelDelete,
  audioDiarizationDownload,
  audioDiarizationStatus,
  audioTranscriberStart,
  audioTranscriberStop,
  audioRecordingStart,
  audioRecordingStop,
  audioRecordingCancel,
  audioRecordingsList,
  audioRecordingGet,
  audioRecordingEditTranscript,
  audioRecordingSummarize,
  audioRecordingDelete,
  audioRecordingRename,
  audioRecordingSetProject,
  audioRecordingRetain,
  audioRecordingSaveToWorkspace,
  audioLiveTranscriptStart,
  audioLiveTranscriptStop,
  audioImportStart,
  audioImportSource,
  audioImportFinish,
  audioLoopbackEnable,
  audioLoopbackDisable,
  audioOverlaySetVisible,
  audioOverlayGetVisible,
  audioSystemDictationGet,
  audioMiniBarSetEnabled,
  audioMeetingGet,
  audioMeetingDetectionSet,
  audioMeetingSetState,
  audioMeetingOpen,
  audioSystemDictationSetAppearance,
  audioSystemDictationSetEnabled,
  audioSystemDictationSetShortcut,
  audioSystemDictationSetShortcutCapture,
  audioSystemDictationOpenSettings,
  audioSystemDictationSetState,
  audioSystemDictationPaste,
  audioSystemDictationReadiness,
  audioSystemDictationMicrophonesGet,
  audioSystemDictationMicrophonesUpdate,
  audioSystemDictationMicrophoneSelect,
  audioSystemDictationMicrophoneActive,
  audioSystemDictationRequestPermission,
  audioSystemDictationRepairPermission,
  desktopLoginItemGet,
  desktopLoginItemSet,
  desktopNotificationShow,
  desktopBadgeSet,
};
