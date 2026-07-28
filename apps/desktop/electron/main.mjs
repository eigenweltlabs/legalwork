import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, powerMonitor, powerSaveBlocker, protocol, session, shell, systemPreferences } from "electron";
import { configureFakeMediaForTests, installMediaPermissionHandlers } from "./media-permissions.mjs";
import { appendLoopbackFeatureFlags, disableLoopbackAudio, enableLoopbackAudio, isLoopbackCaptureArmed } from "./audio/loopback.mjs";
import { captureAuthStatus, openCapturePermissionSettings, requestCapturePermission } from "./audio/capture-permissions.mjs";
import { DictationPermissions } from "./audio/dictation-permissions.mjs";
import { AppAudioTap } from "./audio/app-audio.mjs";
import { CallOverlay } from "./audio/call-overlay.mjs";
import { DictationHud } from "./audio/dictation-hud.mjs";
import { RecorderService } from "./audio/recorder-service.mjs";
import { SystemDictationService } from "./audio/system-dictation.mjs";
import { SystemKeyMonitor } from "./audio/system-key-monitor.mjs";
import { PowerLifecycle, PowerSessions } from "./power-lifecycle.mjs";
import { AppTray } from "./tray.mjs";
import { pinWindowsProcessQoS } from "./windows-qos.mjs";
import { registerMigrationIpc } from "./migration.mjs";
import { createRuntimeManager, resolveLegalworkServerConfigPath } from "./runtime.mjs";
import { buildSupportBundleText, defaultSupportBundleFileName } from "./support-bundle.mjs";
import {
  ELECTRON_UPDATER_FALLBACK_FEEDS,
  ELECTRON_UPDATER_FEEDS,
  registerUpdaterIpc,
} from "./updater.mjs";
import {
  checkComputerUsePermissions,
  getComputerUseMcpCommand,
  listRunningApps,
  openComputerUseSetupApp,
} from "./computer-use.mjs";
import { createUiControlServer } from "./ui-control-server.mjs";
import { createApplicationMenu } from "./app-menu.mjs";
import { createBrowserPanel } from "./browser-panel.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";
import { exportSkillFolder, readSkillArchive } from "./workspace-archive.mjs";

// Privileged scheme for in-app recording playback. Must be registered before
// app "ready"; the handler is attached in whenReady. `stream` enables Range
// requests so <audio> can seek without loading the whole file into memory.
const RECORDING_AUDIO_SCHEME = "lw-recording";
protocol.registerSchemesAsPrivileged([
  {
    scheme: RECORDING_AUDIO_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

// Live recordings are always webm, but imported files keep their original
// container (mp3, m4a, wav, …). Serve each with a matching Content-Type so the
// <audio> element can decode it — a webm type on an mp3 makes playback fail.
const RECORDING_AUDIO_MIME_BY_EXT = {
  ".webm": "audio/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".caf": "audio/x-caf",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".mov": "video/quicktime",
  ".wma": "audio/x-ms-wma",
  ".3gp": "audio/3gpp",
};
function recordingAudioContentType(filePath) {
  return RECORDING_AUDIO_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pty = require(["node", "pty"].join("-"));
const NATIVE_DEEP_LINK_EVENT = "legalwork:deep-link-native";
const APP_BUNDLE_IDENTIFIER = "com.eigenweltlabs.legalwork";
const DEV_APP_IDENTIFIER = "com.eigenweltlabs.legalwork.dev";
const DESKTOP_PROTOCOL_SCHEME = "legalwork";
const isDevMode = process.env.LEGALWORK_DEV_MODE === "1";
const APP_NAME =
  process.env.LEGALWORK_ELECTRON_APP_NAME?.trim() ||
  (isDevMode ? "LegalWork - Dev" : "LegalWork");
const APP_IDENTIFIER =
  process.env.LEGALWORK_ELECTRON_APP_IDENTIFIER?.trim() ||
  (isDevMode ? DEV_APP_IDENTIFIER : APP_BUNDLE_IDENTIFIER);
// Our update feed mirrors GitHub's releases/latest/download file layout and
// redirects to the GitHub assets (see eigenwelt-website
// app/legalwork/update/[file]/route.ts). If it misbehaves, resolution falls
// back to GitHub directly so the arch-mismatch download flow never depends on
// our site being up. The URLs are defined once, in updater.mjs, so this flow
// and the self-updater can never point at different feeds.
const RELEASE_DOWNLOAD_BASE_URL = ELECTRON_UPDATER_FEEDS.stable;
const RELEASE_DOWNLOAD_FALLBACK_BASE_URL = ELECTRON_UPDATER_FALLBACK_FEEDS.stable;
const RELEASE_PAGE_URL = "https://github.com/eigenweltlabs/legalwork/releases/latest";

const WINDOWS_PASTE_SCRIPT = `
$source = @'
using System;
using System.Runtime.InteropServices;

public static class LegalWorkPaste {
  [StructLayout(LayoutKind.Sequential)]
  private struct INPUT {
    public uint type;
    public InputUnion data;
  }

  // MOUSEINPUT is the widest member of the real Win32 union and is what gives
  // INPUT its size (40 bytes on x64, 28 on x86). Declaring only KEYBDINPUT
  // marshals INPUT to 32 bytes, and SendInput rejects a cbSize that doesn't
  // match its own sizeof(INPUT) with ERROR_INVALID_PARAMETER — returning 0
  // events sent, so the paste silently fails on every 64-bit Windows machine.
  // It is never written to; it exists purely to size the union correctly.
  [StructLayout(LayoutKind.Explicit)]
  private struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct KEYBDINPUT {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint count, INPUT[] inputs, int size);

  private static INPUT Key(ushort virtualKey, uint flags) {
    return new INPUT {
      type = 1,
      data = new InputUnion {
        keyboard = new KEYBDINPUT { virtualKey = virtualKey, flags = flags }
      }
    };
  }

  public static bool Paste() {
    INPUT[] inputs = {
      Key(0x11, 0),
      Key(0x56, 0),
      Key(0x56, 2),
      Key(0x11, 2)
    };
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
  }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
if (-not [LegalWorkPaste]::Paste()) { exit 2 }
`;

function runChildProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Paste command timed out."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(undefined);
      else reject(new Error(`Paste command exited with code ${code ?? "unknown"}.`));
    });
  });
}

function runSystemPasteCommand(platform) {
  if (platform === "darwin") {
    return runChildProcess("/usr/bin/osascript", [
      "-e",
      "tell application \"System Events\" to key code 9 using command down",
    ]);
  }
  if (platform === "windows") {
    return runChildProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_PASTE_SCRIPT,
    ]);
  }
  return Promise.reject(new Error("Automatic paste is not available on this platform."));
}

async function showSupportLogsProgressWindow(parent) {
  const dark = nativeTheme.shouldUseDarkColors;
  const background = dark ? "#0b0b0f" : "#ffffff";
  const foreground = dark ? "#f4f4f5" : "#18181b";
  const muted = dark ? "#a1a1aa" : "#71717a";
  const spinnerTrack = dark ? "rgba(244,244,245,.25)" : "rgba(24,24,27,.18)";
  const progressWindow = new BrowserWindow({
    width: 360,
    height: 180,
    title: "Collect Support Logs",
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    modal: Boolean(parent),
    ...(parent ? { parent } : {}),
    backgroundColor: background,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  progressWindow.setMenu(null);
  await progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; margin: 0; background: ${background}; color: ${foreground}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { display: grid; gap: 10px; justify-items: center; padding: 24px; text-align: center; }
      .spinner { width: 24px; height: 24px; border: 2px solid ${spinnerTrack}; border-top-color: ${foreground}; border-radius: 50%; animation: spin .9s linear infinite; }
      .title { font-size: 15px; font-weight: 600; }
      .body { font-size: 13px; color: ${muted}; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner" aria-hidden="true"></div>
      <div class="title">Collecting support logs</div>
      <div class="body">This can take a few seconds.</div>
    </main>
  </body>
</html>`)}`);
  progressWindow.show();
  return progressWindow;
}

// Collect the support-log bundle: ask the user where to save it (defaulting
// to the Desktop), write it there, and reveal it in the file manager so it
// can be attached to an email. Shared by the Help menu and the
// `supportBundleCollect` IPC command (boot error screen). Returns the saved
// path, or null when the user cancels the dialog. `runtimeManager` is created
// later at module scope; the click/IPC always happens after startup, so the
// late binding via closure is safe.
async function collectSupportLogsAndReveal() {
  let defaultDir;
  try {
    defaultDir = app.getPath("desktop");
  } catch {
    defaultDir = os.homedir();
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options = {
    title: "Save Support Logs",
    defaultPath: path.join(defaultDir, defaultSupportBundleFileName()),
    filters: [{ name: "Text", extensions: ["txt"] }],
  };
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return null;

  const progressWindow = await showSupportLogsProgressWindow(parent);
  try {
    // Give the progress window one paint before the synchronous diagnostics
    // snapshot starts probing binaries and reading log tails.
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Build after the dialog so the diagnostics snapshot is as fresh as possible.
    writeFileSync(filePath, buildSupportBundleText({ app, runtimeManager }), "utf8");
  } finally {
    if (!progressWindow.isDestroyed()) progressWindow.close();
  }

  shell.showItemInFolder(filePath);
  return filePath;
}

const applicationMenu = createApplicationMenu({
  appName: APP_NAME,
  getWindow: () => createMainWindow(),
  collectSupportLogs: () => {
    void collectSupportLogsAndReveal().catch((error) => {
      dialog.showErrorBox(
        "Collect Support Logs",
        `Could not write the support bundle: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  },
});

const uiControlServer = createUiControlServer({
  appName: APP_NAME,
  appIdentifier: APP_IDENTIFIER,
  getWindow: () => createMainWindow(),
});

const terminalProcesses = new Map();
let nextTerminalId = 1;

function defaultTerminalShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

async function resolveTerminalCwd(cwd) {
  const fallback = os.homedir();
  if (typeof cwd !== "string" || !cwd.trim()) return fallback;
  const candidate = path.resolve(cwd);
  const info = await stat(candidate).catch(() => null);
  return info?.isDirectory() ? candidate : fallback;
}

function terminalForSender(event, terminalId) {
  const terminal = terminalProcesses.get(String(terminalId ?? ""));
  if (!terminal || terminal.webContentsId !== event.sender.id) return null;
  return terminal;
}

function killTerminal(terminalId) {
  const terminal = terminalProcesses.get(terminalId);
  if (!terminal) return;
  terminalProcesses.delete(terminalId);
  try { terminal.process.kill(); } catch { /* already gone */ }
}

function killTerminalsForWebContents(webContentsId) {
  for (const [terminalId, terminal] of terminalProcesses.entries()) {
    if (terminal.webContentsId === webContentsId) killTerminal(terminalId);
  }
}

// Production Electron shares the same on-disk state folder as the Tauri shell
// so in-place migration is a no-op for almost every file. Dev mode uses the
// separate dev identifier so it can run beside the production app.
//
// Override via LEGALWORK_ELECTRON_USERDATA so dogfooders can isolate their
// Electron install from the real Tauri app.
app.setName(APP_NAME);
app.setAppUserModelId(APP_IDENTIFIER);
if (process.platform === "darwin") {
  app.setActivationPolicy("regular");
}
if (app.isPackaged) {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
}
const userDataOverride = process.env.LEGALWORK_ELECTRON_USERDATA?.trim();
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
} else {
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), APP_IDENTIFIER),
  );
}

// Resolve and cache the app icon (reused for BrowserWindow + mac dock).
// Packaged builds ship icons via electron-builder config, but for `dev:electron`
// the Electron default icon is shown without this.
function resolveAppIconPath() {
  const candidates = [
    // Dev: match Tauri's separate dev icon so the dev app is visibly distinct.
    ...(isDevMode
      ? [
          path.resolve(__dirname, "../resources/icons/dev/icon.png"),
          path.resolve(__dirname, "../resources/icons/dev/128x128@2x.png"),
          path.resolve(__dirname, "../resources/icons/dev/icon-dev.icns"),
        ]
      : []),
    // Repo-relative path to the Electron resource icon set.
    path.resolve(__dirname, "../resources/icons/icon.png"),
    // Packaged: electron-builder copies extraResources but we fall back to this
    // if custom packaging ever exposes the icon here.
    path.join(process.resourcesPath ?? "", "icons", "icon.png"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeRuntimeArch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["arm64", "aarch64", "arm64e"].includes(normalized)) return "arm64";
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "x64";
  return normalized || "unknown";
}

function isMacRunningUnderRosetta() {
  if (process.platform !== "darwin" || process.arch !== "x64") return false;
  try {
    return execFileSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "1";
  } catch {
    return false;
  }
}

function resolveSystemArch() {
  if (process.platform === "darwin" && isMacRunningUnderRosetta()) return "arm64";
  if (process.platform === "win32") {
    return normalizeRuntimeArch(
      process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || os.arch(),
    );
  }
  if (typeof os.machine === "function") return normalizeRuntimeArch(os.machine());
  return normalizeRuntimeArch(os.arch());
}

function platformDownloadSlug() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function downloadAssetArch(arch) {
  if (process.platform === "linux" && arch === "x64") return "x86_64";
  return arch;
}

function downloadAssetExtension() {
  if (process.platform === "darwin") return "dmg";
  if (process.platform === "win32") return "exe";
  return "AppImage";
}

function updaterManifestName(arch) {
  if (process.platform === "darwin") return "latest-mac.yml";
  if (process.platform === "win32") return "latest.yml";
  return arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

function archLabel(arch) {
  if (arch === "arm64") return "ARM";
  if (arch === "x64") return "Intel";
  return arch;
}

function parseUpdaterManifestFiles(raw) {
  const files = [];
  let current = null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const start = line.match(/^\s*-\s+url:\s*(.+?)\s*$/);
    if (start) {
      current = { url: start[1].trim().replace(/^['"]|['"]$/g, "") };
      files.push(current);
      continue;
    }
    const prop = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (prop && current) {
      current[prop[1]] = prop[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return files.filter((file) => file.url);
}

function selectDownloadFile(files, arch) {
  const assetArch = downloadAssetArch(arch);
  const expected = `-${assetArch}-`;
  const extension = downloadAssetExtension();
  const matchingArch = files.filter((file) => file.url.includes(expected));
  return (
    matchingArch.find((file) => file.url.endsWith(`.${extension}`)) ||
    matchingArch.find((file) => file.url.endsWith(".zip")) ||
    matchingArch[0] ||
    null
  );
}

async function resolveCorrectArchitectureDownloadUrl(arch) {
  for (const baseUrl of [RELEASE_DOWNLOAD_BASE_URL, RELEASE_DOWNLOAD_FALLBACK_BASE_URL]) {
    try {
      const response = await fetch(`${baseUrl}/${updaterManifestName(arch)}`, {
        headers: { Accept: "text/yaml, text/plain, */*" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const selected = selectDownloadFile(parseUpdaterManifestFiles(await response.text()), arch);
      // No match is treated like an unreachable feed: a 200 with a
      // non-manifest body (maintenance page, bot challenge) parses to nothing
      // and must not short-circuit past the GitHub fallback.
      if (!selected?.url) {
        console.warn(`[architecture] no matching download in manifest via ${baseUrl}`);
        continue;
      }
      return /^https?:\/\//i.test(selected.url)
        ? selected.url
        : new URL(selected.url, `${baseUrl}/`).toString();
    } catch (error) {
      console.warn(`[architecture] failed to resolve download URL via ${baseUrl}`, error);
    }
  }
  return null;
}

async function resolveArchitectureInfo() {
  const appArch = normalizeRuntimeArch(process.arch);
  const systemArch = resolveSystemArch();
  const version = app.getVersion();
  const targetArch = systemArch === "arm64" || systemArch === "x64" ? systemArch : appArch;
  const assetName = `legalwork-${platformDownloadSlug()}-${downloadAssetArch(targetArch)}-${version}.${downloadAssetExtension()}`;
  const latestDownloadUrl = await resolveCorrectArchitectureDownloadUrl(targetArch);
  const hasCorrectArchitectureDownload = Boolean(latestDownloadUrl);
  return {
    appArch,
    appArchLabel: archLabel(appArch),
    systemArch,
    systemArchLabel: archLabel(systemArch),
    mismatch: appArch !== systemArch && hasCorrectArchitectureDownload,
    platform: process.platform === "win32" ? "windows" : process.platform,
    version,
    // Static fallback uses GitHub directly: if we reach this branch the
    // tracked route did not answer, so handing out its URL would be dead too.
    downloadUrl: latestDownloadUrl || `${RELEASE_DOWNLOAD_FALLBACK_BASE_URL}/${assetName}`,
    releaseUrl: RELEASE_PAGE_URL,
  };
}

const APP_ICON_PATH = resolveAppIconPath();
const APP_ICON_IMAGE = APP_ICON_PATH ? nativeImage.createFromPath(APP_ICON_PATH) : null;

// Expose Chrome DevTools Protocol so the opencode-chrome-devtools plugin can
// drive the built-in browser panel.  Use LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT to
// pin a specific port; otherwise probe for a free one starting at 9223.
// Must resolve before app.commandLine.appendSwitch (before `ready`).
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1" }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findFreeCdpPort(candidates) {
  for (const port of candidates) {
    if (await probePort(port)) return port;
  }
  return 0;
}

const explicitCdpPort = Number.parseInt(
  process.env.LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "",
  10,
);
const remoteDebugPort = Number.isFinite(explicitCdpPort) && explicitCdpPort > 0
  ? explicitCdpPort
  : await findFreeCdpPort([9223, 9224, 9225, 9226, 9227]);
if (remoteDebugPort > 0) {
  app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebugPort));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
// Make the resolved port available to the embedded server so it flows into
// agent instructions via ensureLegalworkAgent → resolveAgentTemplate.
process.env.LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT = String(remoteDebugPort);

// Apply extra Chromium flags from ELECTRON_EXTRA_LAUNCH_ARGS.
// Used in headless environments to pass e.g. --disable-gpu.
const extraLaunchArgs = (process.env.ELECTRON_EXTRA_LAUNCH_ARGS ?? "").trim();
if (extraLaunchArgs) {
  for (const arg of extraLaunchArgs.split(/\s+/)) {
    const cleaned = arg.replace(/^--/, "");
    if (!cleaned) continue;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx > 0) {
      app.commandLine.appendSwitch(cleaned.slice(0, eqIdx), cleaned.slice(eqIdx + 1));
    } else {
      app.commandLine.appendSwitch(cleaned);
    }
  }
}
configureFakeMediaForTests(app, envFlagEnabled("LEGALWORK_ELECTRON_FAKE_MEDIA"));
// System-audio loopback (Recorder tab) needs Chromium feature flags on
// macOS/Linux before app-ready; Windows WASAPI loopback works out of the box.
appendLoopbackFeatureFlags(app);
// Hosted cloud removed: the desktop shell seeds an empty Den base URL so the
// bootstrap config never points at a remote control plane. Set a self-hosted
// Den URL here (and VITE_DEN_BASE_URL at build time) to opt cloud back in.
const DEFAULT_DEN_BASE_URL = "";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:4096";
const FORCE_DESKTOP_REQUIRE_SIGNIN = envFlagEnabled("LEGALWORK_FORCE_SIGNIN");
const DEFAULT_DESKTOP_REQUIRE_SIGNIN = FORCE_DESKTOP_REQUIRE_SIGNIN;

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const IDLE_ENGINE_INFO = Object.freeze({
  running: false,
  runtime: "direct",
  baseUrl: null,
  projectDir: null,
  hostname: null,
  port: null,
  opencodeUsername: null,
  opencodePassword: null,
  opencodeBinPath: null,
  opencodeBinSource: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_LEGALWORK_SERVER_INFO = Object.freeze({
  running: false,
  remoteAccessEnabled: false,
  host: null,
  port: null,
  baseUrl: null,
  connectUrl: null,
  mdnsUrl: null,
  lanUrl: null,
  clientToken: null,
  ownerToken: null,
  hostToken: null,
  managedOpencodeBinPath: null,
  managedOpencodeBinSource: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_ROUTER_INFO = Object.freeze({
  running: false,
  version: null,
  workspacePath: null,
  opencodeUrl: null,
  healthPort: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

let mainWindow = null;
const pendingDeepLinks = [];

// Relay a content-free error signal to the renderer, which turns it into an
// `app_error` analytics event (only when the user has analytics enabled).
function relayAppError(source, error, service, exitCode = null) {
  try {
    const name =
      error instanceof Error
        ? error.name || "Error"
        : error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "Error";
    if (mainWindow?.webContents && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("legalwork:app-error", {
        source,
        error_name: name,
        service,
        exit_code: typeof exitCode === "number" ? exitCode : null,
      });
    }
  } catch {
    // Never let error reporting throw.
  }
}
// `uncaughtExceptionMonitor` reports without suppressing Electron's default
// crash behavior (unlike `uncaughtException`).
process.on("uncaughtExceptionMonitor", (error) => relayAppError("main_uncaught", error, "server"));
process.on("unhandledRejection", (reason) => relayAppError("main_unhandledrejection", reason, "server"));

const browserPanel = createBrowserPanel({
  remoteDebugPort,
  getWindow: () => mainWindow,
});

const workspaceStore = createWorkspaceStore({
  app,
  defaultDenBaseUrl: DEFAULT_DEN_BASE_URL,
  defaultRequireSignin: DEFAULT_DESKTOP_REQUIRE_SIGNIN,
  forceRequireSignin: FORCE_DESKTOP_REQUIRE_SIGNIN,
});

// ── Local audio recording + transcription (Recorder tab) ──────────────────
const appAudioTap = new AppAudioTap({
  app,
  getTargetWebContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
});

// Refcounted 'prevent-app-suspension' blocker, held only while real work is
// in flight (recording, import, dictation transcribe+paste) — never while
// merely armed for the hotkey.
const powerSessions = new PowerSessions({ powerSaveBlocker });

/** @type {RecorderService | null} */
let recorderServiceInstance = null;
function recorderService() {
  if (!recorderServiceInstance) {
    recorderServiceInstance = new RecorderService({
      userDataDir: app.getPath("userData"),
      appAudioAvailable: () => appAudioTap.isAvailable(),
      powerSessions,
      pinProcessQoS: pinWindowsProcessQoS,
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      recorderServiceInstance.subscribe(mainWindow.webContents);
    }
  }
  return recorderServiceInstance;
}

const callOverlay = new CallOverlay({
  getMainWindow: () => mainWindow,
  onCreated: (window) => recorderService().subscribe(window.webContents),
  onVisibilityChange: (visible) => recorderService().broadcast({ type: "overlay-visibility", visible }),
});

const dictationHud = new DictationHud();
const systemKeyMonitor = new SystemKeyMonitor({ app, platform: process.platform });
const dictationPermissions = new DictationPermissions({
  app,
  systemPreferences,
  shell,
  captureAuthStatus,
  platform: process.platform,
});

/**
 * A monitor started under a stale/denied Input Monitoring grant keeps its
 * dead tap until respawned. Restart it the moment the grant becomes usable
 * (or when dictation is on but the monitor never came up), so hold-to-talk
 * and shortcut capture heal without an app restart.
 */
async function healDictationMonitor(readiness) {
  const becameUsable = dictationPermissions.inputMonitoringBecameUsable(readiness);
  const status = systemDictation.status();
  // With dictation enabled, supportsHold reflects whether the monitor is live.
  if (
    status.enabled
    && readiness.inputMonitoring === "granted"
    && (becameUsable || !status.supportsHold)
  ) {
    await systemDictation.refreshAfterResume();
  }
  return readiness;
}
const systemDictation = new SystemDictationService({
  userDataDir: app.getPath("userData"),
  platform: process.platform,
  globalShortcut,
  clipboard,
  systemPreferences,
  shell,
  runPasteCommand: runSystemPasteCommand,
  keyMonitor: systemKeyMonitor,
  onToggle: () => recorderService().broadcast({ type: "system-dictation-toggle" }),
  onPress: () => recorderService().broadcast({ type: "system-dictation-press" }),
  onRelease: () => recorderService().broadcast({ type: "system-dictation-release" }),
  onCancel: () => recorderService().broadcast({ type: "system-dictation-cancel" }),
  onStatus: (status) => {
    recorderService().broadcast({ type: "system-dictation-status", status });
    syncBackgroundPresence();
  },
  onState: (state, message) => {
    void dictationHud.setState(state, message);
  },
});

// ── Background presence (tray + close-to-hide) ────────────────────────────
//
// Dictation users keep the app closed/hidden ~100% of the time, but the
// hotkey pipeline lives in the main window's renderer: capture (getUserMedia
// + AudioWorklet) runs there. So while "Dictate anywhere" is on (or a
// recording is still running), closing the window hides it instead of
// destroying it, and a tray icon keeps the app reachable.

let appIsQuitting = false;
let windowsCloseHintShown = false;
// --hidden comes from the login-item registration (Windows args); macOS
// login-item launches are detected via wasOpenedAtLogin in whenReady.
let startHiddenPending = process.argv.includes("--hidden");

const appTray = new AppTray({
  appName: APP_NAME,
  icon: APP_ICON_IMAGE,
  onOpen: () => {
    void createMainWindow().then((win) => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  },
  onQuit: () => {
    app.quit();
  },
});

function trayShortcutLabel(status) {
  if (!status.registered) return null;
  const parts = String(status.accelerator ?? "").split("+").filter(Boolean);
  if (parts.length === 0) return null;
  const labels = status.platform === "darwin"
    ? { CommandOrControl: "Cmd", Command: "Cmd", Super: "Cmd", Control: "Ctrl", Alt: "Option", Shift: "Shift", Fn: "Fn" }
    : { CommandOrControl: "Ctrl", Command: "Ctrl", Control: "Ctrl", Super: "Win", Alt: "Alt", Shift: "Shift", Fn: "Fn" };
  return parts.map((part) => labels[part] ?? part).join("+");
}

function keepAliveOnClose() {
  if (systemDictation.status().enabled) return true;
  // A call recording behind a closed window must finalize, not vanish.
  return (recorderServiceInstance?.activeRecordings.size ?? 0) > 0;
}

function syncBackgroundPresence() {
  if (!app.isReady() || appIsQuitting) return;
  const status = systemDictation.status();
  // A minimized window also reports !isVisible() on Windows, but that is not
  // background presence — only an explicit close-to-hide (hidden AND not
  // minimized) warrants a keepalive tray.
  const windowHidden = mainWindow !== null
    && !mainWindow.isDestroyed()
    && !mainWindow.isVisible()
    && !mainWindow.isMinimized();
  if (status.enabled || windowHidden) {
    // While the window is hidden the tray must exist even if dictation was
    // just disabled — on Windows it is the only way back into the app.
    appTray.ensure({
      dictationEnabled: status.enabled,
      shortcutLabel: trayShortcutLabel(status),
    });
  } else {
    appTray.destroy();
  }
}

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function forwardedDeepLinks(argv) {
  return argv
    .slice(1)
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.startsWith("legalwork://") ||
        entry.startsWith("legalwork-dev://") ||
        entry.startsWith("https://") ||
        entry.startsWith("http://"),
    );
}

function queueDeepLinks(urls) {
  const nextUrls = urls.filter(Boolean);
  if (nextUrls.length === 0) return;
  pendingDeepLinks.push(...nextUrls);
  if (mainWindow?.webContents) {
    mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, nextUrls);
  }
}

function flushPendingDeepLinks() {
  if (!mainWindow?.webContents || pendingDeepLinks.length === 0) return;
  const urls = pendingDeepLinks.splice(0, pendingDeepLinks.length);
  mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, urls);
}

function configHomePath() {
  if (process.env.XDG_CONFIG_HOME?.trim()) {
    return process.env.XDG_CONFIG_HOME.trim();
  }
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    return process.env.APPDATA.trim();
  }
  return path.join(os.homedir(), ".config");
}

function globalOpencodeRoot() {
  return path.join(configHomePath(), "opencode");
}

function execResult(ok, stdout = "", stderr = "", status = ok ? 0 : 1) {
  return { ok, status, stdout, stderr };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeCommandName(raw) {
  const trimmed = String(raw ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) return null;
  const safe = Array.from(trimmed)
    .filter((char) => /[A-Za-z0-9_-]/.test(char))
    .join("");
  return safe || null;
}

function escapeYamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function serializeCommandFrontmatter(command) {
  const template = String(command?.template ?? "").trim();
  if (!template) {
    throw new Error("command.template is required");
  }

  let output = "---\n";
  if (typeof command?.description === "string" && command.description.trim()) {
    output += `description: ${escapeYamlScalar(command.description.trim())}\n`;
  }
  if (typeof command?.agent === "string" && command.agent.trim()) {
    output += `agent: ${escapeYamlScalar(command.agent.trim())}\n`;
  }
  if (typeof command?.model === "string" && command.model.trim()) {
    output += `model: ${escapeYamlScalar(command.model.trim())}\n`;
  }
  if (command?.subtask === true) {
    output += "subtask: true\n";
  }
  output += `---\n\n${template}\n`;
  return output;
}

function validateSkillName(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error("skill name must be kebab-case");
  }
  return trimmed;
}

// The 64-char cap is not ours to relax: a skill is exposed to the model as a
// tool, and the LLM providers reject tool names longer than 64 chars
// (Anthropic: `^[a-zA-Z0-9_-]{1,64}$`). Rather than fail an over-long import,
// coerce the name into a valid, <=64-char kebab-case slug by dropping whole
// trailing words — so a too-long workflow still lands (and stays meaningful)
// instead of being rejected. Returns null only when nothing valid remains.
const MAX_SKILL_NAME_LENGTH = 64;
function fitSkillName(raw) {
  const cleaned = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return null;
  if (cleaned.length <= MAX_SKILL_NAME_LENGTH) return cleaned;
  const words = cleaned.split("-");
  let candidate = words[0].slice(0, MAX_SKILL_NAME_LENGTH);
  for (let i = 1; i < words.length; i += 1) {
    const next = `${candidate}-${words[i]}`;
    if (next.length > MAX_SKILL_NAME_LENGTH) break;
    candidate = next;
  }
  return candidate.replace(/-+$/g, "") || null;
}

// When we shorten a folder name to fit, keep the SKILL.md frontmatter `name` in
// sync so the engine loads the skill under the same (valid) name it now lives
// in. Only the leading frontmatter block is touched, never a `name:` in the
// body. Best-effort: a copied folder that imported is not un-imported on error.
async function syncSkillFrontmatterName(skillMdPath, name) {
  try {
    const raw = await readFile(skillMdPath, "utf8");
    if (!raw.startsWith("---")) return;
    const end = raw.indexOf("\n---", 3);
    if (end === -1) return;
    const header = raw.slice(0, end).replace(/^name:[ \t]*.*$/m, `name: ${name}`);
    const patched = header + raw.slice(end);
    if (patched !== raw) await writeFile(skillMdPath, patched, "utf8");
  } catch {
    // Non-fatal — the folder still imported.
  }
}

const runtimeManager = createRuntimeManager({
  app,
  desktopRoot: path.resolve(__dirname, ".."),
  listLocalWorkspacePaths: () => workspaceStore.listLocalWorkspacePaths(),
  recorder: {
    status: (workspacePath) => recorderService().liveTranscriptStatus(workspacePath),
    setLiveTranscript: (enabled, workspacePath) => recorderService().setLiveTranscript(enabled, workspacePath),
  },
  // The agent runtime (orchestrator / opencode) runs as a child process; relay
  // an unexpected exit as a content-free `sidecar_exit` app_error. Intentional
  // stops/restarts are filtered out inside the runtime manager.
  onSidecarExit: (detail) => relayAppError("sidecar_exit", { name: "Error" }, "sidecar", detail?.exitCode ?? null),
});

let runtimeDisposedForQuit = false;
let runtimeDisposeInProgress = false;
let runtimeBootstrapPromise = null;

function showShutdownScreen() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.show();
    win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; margin: 0; background: #0b0b0f; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { display: grid; gap: 10px; justify-items: center; }
      .spinner { width: 22px; height: 22px; border: 2px solid rgba(244,244,245,.25); border-top-color: #f4f4f5; border-radius: 50%; animation: spin .9s linear infinite; }
      .title { font-size: 15px; font-weight: 600; }
      .body { font-size: 13px; color: #a1a1aa; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner" aria-hidden="true"></div>
      <div class="title">Stopping LegalWork services</div>
      <div class="body">Closing local workers and background services...</div>
    </main>
  </body>
</html>`)}`);
  } catch {
    // Ignore renderer teardown races during quit.
  }
}

async function disposeRuntimeBeforeQuit() {
  if (runtimeDisposedForQuit || runtimeDisposeInProgress) return;
  runtimeDisposeInProgress = true;
  try {
    await runtimeManager.dispose().catch(() => undefined);
    runtimeDisposedForQuit = true;
  } finally {
    runtimeDisposeInProgress = false;
  }
}

function assertLegalworkServerReady(info) {
  if (!info?.running) {
    throw new Error("LegalWork server did not stay running after startup.");
  }
  if (!info.baseUrl) {
    throw new Error("LegalWork server did not report a base URL after startup.");
  }
  if (!info.ownerToken && !info.clientToken) {
    throw new Error("LegalWork server did not report an access token after startup.");
  }
  return info;
}

// Turn a runtime boot failure into a rich, token-free result the renderer can
// log and (partly) display. We also drop the same payload into a log file so a
// failing machine can be diagnosed by sending one file — the on-screen message
// alone is a generic catch-all that hides the real cause.
function describeRuntimeBootFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  let diagnostics = null;
  try {
    diagnostics = runtimeManager.collectRuntimeDiagnostics();
  } catch {
    /* diagnostics are best-effort */
  }

  console.error(
    "[runtime] boot failed:",
    error instanceof Error ? error.stack || message : message,
  );
  if (diagnostics) {
    console.error("[runtime] diagnostics:", JSON.stringify(diagnostics, null, 2));
  }

  let logPath = null;
  try {
    const logsDir = app.getPath("logs");
    mkdirSync(logsDir, { recursive: true });
    logPath = path.join(logsDir, "runtime-boot-failure.log");
    const dump = [
      `LegalWork runtime boot failure`,
      `error: ${message}`,
      error instanceof Error && error.stack ? `stack:\n${error.stack}` : null,
      `diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`,
      "",
    ]
      .filter(Boolean)
      .join("\n");
    writeFileSync(logPath, dump, "utf8");
  } catch {
    logPath = null;
  }

  return { ok: false, error: message, diagnostics, logPath };
}

async function bootRuntimeForSelectedWorkspace() {
  const list = await workspaceStore.readWorkspaceState();
  const selectedId = list.selectedId || list.activeId || list.workspaces[0]?.id || "";
  const workspace = selectedId
    ? list.workspaces.find((entry) => entry?.id === selectedId)
    : list.workspaces[0];
  const workspaceRoot = String(workspace?.path ?? "").trim();
  if (!workspaceRoot || workspace?.workspaceType === "remote") {
    return { ok: true, skipped: true, reason: "no-local-workspace" };
  }

  const workspacePaths = [];
  for (const entry of list.workspaces) {
    if (entry?.workspaceType === "remote") continue;
    const workspacePath = String(entry?.path ?? "").trim();
    if (workspacePath && !workspacePaths.includes(workspacePath)) workspacePaths.push(workspacePath);
  }
  if (!workspacePaths.includes(workspaceRoot)) workspacePaths.unshift(workspaceRoot);

  let bootWorkspace = workspace;
  let bootWorkspaceRoot = workspaceRoot;
  let engine;
  try {
    engine = await runtimeManager.engineStart(workspaceRoot, {
      runtime: "direct",
      workspacePaths,
    });
  } catch (error) {
    const fallback = list.workspaces.find((entry) => {
      const candidatePath = String(entry?.path ?? "").trim();
      return entry?.workspaceType !== "remote" && candidatePath && candidatePath !== workspaceRoot;
    });
    const fallbackRoot = String(fallback?.path ?? "").trim();
    if (!fallback || !fallbackRoot) throw error;
    console.warn("[runtime] selected workspace failed during boot; trying fallback workspace", {
      selectedWorkspaceId: workspace?.id ?? null,
      fallbackWorkspaceId: fallback.id ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    const fallbackWorkspacePaths = [
      fallbackRoot,
      ...workspacePaths.filter((entry) => entry !== fallbackRoot && entry !== workspaceRoot),
    ];
    engine = await runtimeManager.engineStart(fallbackRoot, {
      runtime: "direct",
      workspacePaths: fallbackWorkspacePaths,
    });
    bootWorkspace = fallback;
    bootWorkspaceRoot = fallbackRoot;
    await workspaceStore.writeWorkspaceState({
      ...list,
      selectedId: String(fallback.id ?? ""),
      watchedId: String(fallback.id ?? ""),
    }).catch(() => undefined);
  }
  await runtimeManager.orchestratorWorkspaceActivate({
    workspacePath: bootWorkspaceRoot,
    name: bootWorkspace.name ?? bootWorkspace.displayName ?? null,
  }).catch(() => undefined);
  const legalworkServer = assertLegalworkServerReady(await runtimeManager.legalworkServerInfo());
  return { ok: true, skipped: false, engine, legalworkServer, workspaceId: bootWorkspace.id ?? null };
}

function ensureRuntimeBootstrap() {
  if (!runtimeBootstrapPromise) {
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch(describeRuntimeBootFailure);
  }
  return runtimeBootstrapPromise;
}

// Ordered config file candidates for a scope; the first existing one is used.
// New project configs default to the hidden .opencode/ location (the engine
// reads both) so the workspace folder stays free of app-created files — must
// agree with opencodeConfigPath in apps/server/src/workspace-files.ts.
function opencodeConfigCandidates(scope, projectDir) {
  if (scope === "project") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    return {
      candidates: [
        path.join(projectDir, "opencode.jsonc"),
        path.join(projectDir, "opencode.json"),
        path.join(projectDir, ".opencode", "opencode.jsonc"),
        path.join(projectDir, ".opencode", "opencode.json"),
      ],
      fallback: path.join(projectDir, ".opencode", "opencode.jsonc"),
    };
  }
  if (scope === "global") {
    const root = globalOpencodeRoot();
    const jsoncPath = path.join(root, "opencode.jsonc");
    return { candidates: [jsoncPath, path.join(root, "opencode.json")], fallback: jsoncPath };
  }
  throw new Error("scope must be 'project' or 'global'");
}

async function chooseOpencodeConfigPath(scope, projectDir) {
  const { candidates, fallback } = opencodeConfigCandidates(scope, projectDir);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return fallback;
}

async function readOpencodeConfig(scope, projectDir) {
  const chosenPath = await chooseOpencodeConfigPath(scope, projectDir);
  const exists = await pathExists(chosenPath);
  return {
    path: chosenPath,
    exists,
    content: exists ? await readFile(chosenPath, "utf8") : null,
  };
}

async function writeOpencodeConfig(scope, projectDir, content) {
  const targetPath = await chooseOpencodeConfigPath(scope, projectDir);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return execResult(true, `Wrote ${targetPath}`);
}

function resolveCommandsDir(scope, projectDir) {
  if (scope === "workspace") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    return path.join(projectDir, ".opencode", "commands");
  }
  if (scope === "global") {
    return path.join(globalOpencodeRoot(), "commands");
  }
  throw new Error("scope must be 'workspace' or 'global'");
}

async function listCommandNames(scope, projectDir) {
  const commandsDir = resolveCommandsDir(scope, projectDir);
  if (!(await isDirectory(commandsDir))) {
    return [];
  }
  const entries = await readdir(commandsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();
}

async function writeCommandFile(scope, projectDir, command) {
  const safeName = sanitizeCommandName(command?.name);
  if (!safeName) {
    throw new Error("command.name is required");
  }
  const commandsDir = resolveCommandsDir(scope, projectDir);
  await mkdir(commandsDir, { recursive: true });
  const filePath = path.join(commandsDir, `${safeName}.md`);
  await writeFile(filePath, serializeCommandFrontmatter({ ...command, name: safeName }), "utf8");
  return execResult(true, `Wrote ${filePath}`);
}

async function deleteCommandFile(scope, projectDir, name) {
  const safeName = sanitizeCommandName(name);
  if (!safeName) {
    throw new Error("name is required");
  }
  const commandsDir = resolveCommandsDir(scope, projectDir);
  const filePath = path.join(commandsDir, `${safeName}.md`);
  if (await pathExists(filePath)) {
    await rm(filePath, { force: true });
  }
  return execResult(true, `Deleted ${filePath}`);
}

async function collectProjectSkillRoots(projectDir) {
  const roots = [];
  if (!String(projectDir ?? "").trim()) return roots;
  let current = path.resolve(projectDir);

  while (true) {
    const opencodeSkills = path.join(current, ".opencode", "skills");
    const legacySkills = path.join(current, ".opencode", "skill");
    const claudeSkills = path.join(current, ".claude", "skills");

    if (await isDirectory(opencodeSkills)) roots.push(opencodeSkills);
    if (await isDirectory(legacySkills)) roots.push(legacySkills);
    if (await isDirectory(claudeSkills)) roots.push(claudeSkills);

    if (await pathExists(path.join(current, ".git"))) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

async function collectGlobalSkillRoots() {
  const roots = [];
  const candidates = [
    path.join(globalOpencodeRoot(), "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      roots.push(candidate);
    }
  }

  return roots;
}

async function collectSkillRoots(projectDir) {
  const roots = [...(await collectProjectSkillRoots(projectDir)), ...(await collectGlobalSkillRoots())];
  return roots.filter((value, index) => roots.indexOf(value) === index);
}

async function findSkillDirsInRoot(root) {
  const found = [];
  if (!(await isDirectory(root))) return found;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const direct = path.join(root, entry.name);
    if (await pathExists(path.join(direct, "SKILL.md"))) {
      found.push(direct);
      continue;
    }

    const nestedEntries = await readdir(direct, { withFileTypes: true }).catch(() => []);
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      const nestedDir = path.join(direct, nested.name);
      if (await pathExists(path.join(nestedDir, "SKILL.md"))) {
        found.push(nestedDir);
      }
    }
  }

  return found;
}

function extractFrontmatterValue(raw, keys) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!keys.includes(key)) continue;
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value) return value;
  }
  return null;
}

function extractTrigger(raw) {
  return extractFrontmatterValue(raw, ["trigger", "when"]);
}

function extractDescription(raw) {
  let inFrontmatter = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter || trimmed.startsWith("#")) continue;
    const cleaned = trimmed.replace(/`/g, "");
    return cleaned.length > 180 ? `${cleaned.slice(0, 180)}...` : cleaned;
  }
  return null;
}

async function listLocalSkills(projectDir) {
  // Empty projectDir → global skills only (workspace-independent). With a projectDir,
  // includes both project and global roots (collectSkillRoots handles the empty case).
  const seen = new Set();
  const out = [];
  for (const root of await collectSkillRoots(projectDir)) {
    for (const skillDir of await findSkillDirsInRoot(root)) {
      const name = path.basename(skillDir);
      if (seen.has(name)) continue;
      seen.add(name);
      let raw = "";
      try {
        raw = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
      } catch {
        raw = "";
      }
      out.push({
        name,
        path: skillDir,
        description: extractDescription(raw) ?? undefined,
        trigger: extractTrigger(raw) ?? undefined,
        kind: extractFrontmatterValue(raw, ["kind"]) ?? undefined,
        workflowType: extractFrontmatterValue(raw, ["workflow_type", "workflow-type", "workflowtype"]) ?? undefined,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function findSkillFile(projectDir, name) {
  const safeName = validateSkillName(name);
  for (const root of await collectSkillRoots(projectDir)) {
    const direct = path.join(root, safeName, "SKILL.md");
    if (await pathExists(direct)) return direct;

    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(root, entry.name, safeName, "SKILL.md");
      if (await pathExists(nested)) return nested;
    }
  }
  return null;
}

async function ensureProjectSkillRoot(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }
  const opencodeRoot = path.join(projectDir, ".opencode");
  const legacy = path.join(opencodeRoot, "skill");
  const modern = path.join(opencodeRoot, "skills");
  if ((await isDirectory(legacy)) && !(await pathExists(modern))) {
    await rename(legacy, modern);
  }
  await mkdir(modern, { recursive: true });
  return modern;
}

// Global skills live in the shared opencode config dir, so they load for every
// workspace automatically (opencode reads its global config for all projects).
async function ensureGlobalSkillRoot() {
  const modern = path.join(globalOpencodeRoot(), "skills");
  await mkdir(modern, { recursive: true });
  return modern;
}

function engineDoctor(options = {}) {
  return runtimeManager.engineDoctor(options);
}

function activeWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
}

function macosVibrancyForCurrentTheme() {
  return nativeTheme.shouldUseDarkColors ? "under-window" : "sidebar";
}

function applyNativeTheme(mode) {
  nativeTheme.themeSource = mode;

  if (process.platform !== "darwin") {
    return true;
  }

  mainWindow?.setVibrancy(macosVibrancyForCurrentTheme());
  mainWindow?.setBackgroundColor("#00000001");

  return true;
}

// Desktop IPC command registry. Every command invokable from the renderer's
// desktopBridge Proxy (apps/app/src/app/lib/desktop.ts) has exactly one
// entry here; handlers receive the ipcMain event followed by the renderer
// arguments. The @type below asserts this registry against the shared
// DesktopCommandMap contract (packages/types/src/desktop-ipc.ts): a missing,
// extra, or renamed command fails `pnpm --filter @legalwork/desktop
// typecheck:electron`.
/** @type {import("@legalwork/types/desktop-ipc").DesktopCommandHandlers<import("electron").IpcMainInvokeEvent>} */
const desktopCommandHandlers = {
  "workspaceBootstrap": async (event, ...args) => {
      return workspaceStore.readWorkspaceState();
  },
  "workspaceSetSelected": async (event, ...args) => {
      return workspaceStore.setSelectedWorkspace(typeof args[0] === "string" ? args[0] : "");
  },
  "workspaceSetRuntimeActive": async (event, ...args) => {
      return workspaceStore.setRuntimeActiveWorkspace(typeof args[0] === "string" && args[0].trim() ? args[0] : null);
  },
  "workspaceCreate": async (event, ...args) => {
      return workspaceStore.createWorkspace(args[0] ?? {});
  },
  "workspaceCreateRemote": async (event, ...args) => {
      return workspaceStore.createRemoteWorkspace(args[0] ?? {});
  },
  "workspaceUpdateRemote": async (event, ...args) => {
      return workspaceStore.updateRemoteWorkspace(args[0] ?? {});
  },
  "workspaceUpdateDisplayName": async (event, ...args) => {
      return workspaceStore.updateWorkspaceDisplayName(args[0] ?? {});
  },
  "workspaceForget": async (event, ...args) => {
      return workspaceStore.forgetWorkspace(String(args[0] ?? "").trim());
  },
  "workspaceAddAuthorizedRoot": async (event, ...args) => {
      return workspaceStore.addAuthorizedRoot(args[0] ?? {});
  },
  "workspaceLegalworkRead": async (event, ...args) => {
      return workspaceStore.readWorkspaceLegalworkConfig(String(args[0]?.workspacePath ?? "").trim());
  },
  "workspaceLegalworkWrite": async (event, ...args) => {
      return workspaceStore.writeWorkspaceLegalworkConfig(
        String(args[0]?.workspacePath ?? "").trim(),
        args[0]?.config ?? workspaceStore.defaultWorkspaceLegalworkConfig(""),
      );
  },
  "workspaceExportConfig": async (event, ...args) => {
      return workspaceStore.exportConfig(args[0] ?? {});
  },
  "workspaceImportConfig": async (event, ...args) => {
      return workspaceStore.importConfig(args[0] ?? {});
  },
  "opencodeCommandList": async (event, ...args) => {
      return listCommandNames(String(args[0]?.scope ?? "").trim(), String(args[0]?.projectDir ?? "").trim());
  },
  "opencodeCommandWrite": async (event, ...args) => {
      return writeCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        args[0]?.command ?? {},
      );
  },
  "opencodeCommandDelete": async (event, ...args) => {
      return deleteCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        String(args[0]?.name ?? "").trim(),
      );
  },
  "engineStart": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const options = args[1] ?? {};
      return runtimeManager.engineStart(projectDir, options);
  },
  "prepareFreshRuntime": async (event, ...args) => {
      return runtimeManager.prepareFreshRuntime();
  },
  "runtimeBootstrap": async (event, ...args) => {
      return ensureRuntimeBootstrap();
  },
  "supportBundleCollect": async (event, ...args) => {
      const bundlePath = await collectSupportLogsAndReveal();
      return { path: bundlePath };
  },
  "runtimeStatus": async (event, ...args) => {
      return runtimeManager.runtimeStatus();
  },
  "engineStop": async (event, ...args) => {
      return runtimeManager.engineStop();
  },
  "engineRestart": async (event, ...args) => {
      return runtimeManager.engineRestart(args[0] ?? {});
  },
  "engineInfo": async (event, ...args) => {
      return runtimeManager.engineInfo();
  },
  "engineDoctor": async (event, ...args) => {
      return engineDoctor(args[0]);
  },
  "engineInstall": async (event, ...args) => {
      return runtimeManager.engineInstall();
  },
  "orchestratorStatus": async (event, ...args) => {
      return runtimeManager.orchestratorStatus();
  },
  "orchestratorWorkspaceActivate": async (event, ...args) => {
      return runtimeManager.orchestratorWorkspaceActivate(args[0] ?? {});
  },
  "orchestratorInstanceDispose": async (event, ...args) => {
      return runtimeManager.orchestratorInstanceDispose(String(args[0] ?? "").trim());
  },
  "appBuildInfo": async (event, ...args) => {
      return {
        version: app.getVersion(),
        gitSha: process.env.LEGALWORK_GIT_SHA ?? null,
        buildEpoch: process.env.LEGALWORK_BUILD_EPOCH ?? null,
        legalworkDevMode: process.env.LEGALWORK_DEV_MODE === "1",
      };
  },
  "getUiControlBridgeInfo": async (event, ...args) => {
      try {
        const raw = await readFile(path.join(app.getPath("userData"), "legalwork-ui-control.json"), "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
  },
  "getLegalworkUiMcpCommand": async (event, ...args) => {
      if (process.env.LEGALWORK_DEV_MODE === "1") {
        return ["node", path.resolve(__dirname, "../../..", "packages/legalwork-ui-mcp/index.mjs")];
      }
      return ["npx", "-y", "legalwork-ui-mcp"];
  },
  "getComputerUseMcpCommand": async (event, ...args) => {
      return getComputerUseMcpCommand();
  },
  "checkComputerUsePermissions": async (event, ...args) => {
      // Spawn --check → fresh TCC read → always accurate.
      return checkComputerUsePermissions();
  },
  "listRunningApps": async (event, ...args) => {
      // Running regular macOS apps for composer @App mentions.
      return listRunningApps();
  },
  "openComputerUsePermissionSetup": async (event, ...args) => {
      // Open the GUI app. Returns immediately — React shows "verify" CTA.
      await openComputerUseSetupApp();
      // Return a fresh check so the UI shows the current state.
      return checkComputerUsePermissions();
  },
  "openComputerUsePermissionSettings": async (event, ...args) => {
      // Legacy: open the setup app (same as above).
      await openComputerUseSetupApp();
      return checkComputerUsePermissions();
  },
  "getLegalworkUiMcpEnvironment": async (event, ...args) => {
      return {
        LEGALWORK_UI_CONTROL_DISCOVERY: path.join(app.getPath("userData"), "legalwork-ui-control.json"),
      };
  },
  "getDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.getDesktopBootstrapConfig();
  },
  "debugDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.debugDesktopBootstrapConfig();
  },
  "setDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.setDesktopBootstrapConfig(args[0] ?? {});
  },
  "nukeLegalworkAndOpencodeConfigAndExit": async (event, ...args) => {
      await rm(app.getPath("userData"), { recursive: true, force: true });
      app.exit(0);
      return undefined;
  },
  "orchestratorStartDetached": async (event, ...args) => {
      return runtimeManager.orchestratorStartDetached(args[0] ?? {});
  },
  "sandboxDoctor": async (event, ...args) => {
      return runtimeManager.sandboxDoctor();
  },
  "sandboxStop": async (event, ...args) => {
      return runtimeManager.sandboxStop(String(args[0] ?? "").trim());
  },
  "sandboxCleanupLegalworkContainers": async (event, ...args) => {
      return runtimeManager.sandboxCleanupLegalworkContainers();
  },
  "sandboxDebugProbe": async (event, ...args) => {
      return runtimeManager.sandboxDebugProbe();
  },
  "legalworkServerInfo": async (event, ...args) => {
      return runtimeManager.legalworkServerInfo();
  },
  "legalworkServerRestart": async (event, ...args) => {
      return runtimeManager.legalworkServerRestart(args[0] ?? {});
  },
  "officeAddinStatus": async () => {
      return runtimeManager.officeAddinStatus();
  },
  "officeAddinInstall": async (event, ...args) => {
      return runtimeManager.officeAddinInstall(args[0]);
  },
  "officeAddinUninstall": async (event, ...args) => {
      return runtimeManager.officeAddinUninstall(args[0]);
  },
  "officeAddinOpenApp": async (event, ...args) => {
      return runtimeManager.officeAddinOpenApp(args[0]);
  },
  "pickDirectory": async (event, ...args) => {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple
        ? ["openDirectory", "createDirectory", "multiSelections"]
        : ["openDirectory", "createDirectory"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  },
  "pickFile": async (event, ...args) => {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple ? ["openFile", "multiSelections"] : ["openFile"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  },
  "saveFile": async (event, ...args) => {
      const options = args[0] ?? {};
      const result = await dialog.showSaveDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      return result.canceled ? null : (result.filePath ?? null);
  },
  "importSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const sourceDir = String(args[1] ?? "").trim();
      const overwrite = args[2]?.overwrite === true;
      const targetName = String(args[2]?.targetName ?? "").trim();
      if (!sourceDir) {
        throw new Error("sourceDir is required");
      }
      // Empty projectDir → global skills dir (skills are global on desktop), same
      // convention as installSkillTemplate so the import shows in the list. A whole
      // folder is copied recursively (cp below), so sibling/supporting files come too.
      const skillRoot = projectDir ? await ensureProjectSkillRoot(projectDir) : await ensureGlobalSkillRoot();
      const name = validateSkillName(targetName || path.basename(sourceDir));
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await cp(sourceDir, destination, { recursive: true });
      return execResult(true, `Imported skill to ${destination}`);
  },
  "installSkillTemplate": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const name = validateSkillName(args[1]);
      const content = String(args[2] ?? "");
      const overwrite = args[3]?.overwrite === true;
      const skillRoot = projectDir ? await ensureProjectSkillRoot(projectDir) : await ensureGlobalSkillRoot();
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "SKILL.md"), content, "utf8");
      return execResult(true, `Installed skill to ${destination}`);
  },
  // Write a multi-file skill folder (SKILL.md + supporting files) in one shot.
  // Files carry base64 content + an exec bit, so binary and executable assets
  // survive. Empty projectDir → global skills dir.
  "installSkillFiles": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const name = validateSkillName(args[1]);
      const files = Array.isArray(args[2]) ? args[2] : [];
      const overwrite = args[3]?.overwrite === true;
      const skillRoot = projectDir ? await ensureProjectSkillRoot(projectDir) : await ensureGlobalSkillRoot();
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await mkdir(destination, { recursive: true });
      const destRoot = path.resolve(destination);
      let written = 0;
      for (const file of files) {
        const rel = String(file?.path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
        if (!rel || rel.split("/").includes("..")) continue; // never escape the skill dir
        const dest = path.join(destination, rel);
        if (!path.resolve(dest).startsWith(destRoot + path.sep)) continue;
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, Buffer.from(String(file?.contentBase64 ?? ""), "base64"));
        if (file?.executable) {
          try { await chmod(dest, 0o755); } catch { /* best-effort exec bit */ }
        }
        written += 1;
      }
      return execResult(true, `Installed skill ${name} (${written} file${written === 1 ? "" : "s"})`);
  },
  "listLocalSkills": async (event, ...args) => {
      return listLocalSkills(String(args[0] ?? "").trim());
  },
  "importSkillsFromFolder": async (event, ...args) => {
      const sourceDir = String(args[0] ?? "").trim();
      const imported = [];
      const skipped = [];
      const failed = [];
      if (!sourceDir || !(await isDirectory(sourceDir))) {
        return { imported, skipped, failed };
      }
      const root = await ensureGlobalSkillRoot();
      const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        const from = path.join(sourceDir, name);
        if (!(await pathExists(path.join(from, "SKILL.md")))) continue;
        try {
          // Coerce (don't reject) an over-long or lightly-malformed name into a
          // valid <=64-char slug; keep the SKILL.md name in sync if we changed it.
          const targetName = fitSkillName(name);
          if (!targetName) throw new Error("skill name is empty or has no usable characters");
          const destination = path.join(root, targetName);
          if (await pathExists(destination)) {
            skipped.push(targetName);
            continue;
          }
          await cp(from, destination, { recursive: true });
          if (targetName !== name) {
            await syncSkillFrontmatterName(path.join(destination, "SKILL.md"), targetName);
          }
          imported.push(targetName);
        } catch (error) {
          failed.push({ name, error: error?.message ?? String(error) });
        }
      }
      // Staging is disposable once everything landed; keep it around for
      // inspection when any folder failed to import.
      if (failed.length === 0) {
        await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
      }
      return { imported, skipped, failed };
  },
  "importSkillZip": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const archivePath = String(args[1] ?? "").trim();
      const overwrite = args[2]?.overwrite === true;
      const asWorkflow = args[2]?.asWorkflow === true;
      if (!archivePath) {
        throw new Error("archivePath is required");
      }
      const archive = await readSkillArchive(archivePath);
      // Folder name inside the zip wins; a root-level SKILL.md falls back to the
      // zip's own file name. Slugified so hand-named zips still validate.
      const rawName = archive.folderName ?? path.basename(archivePath).replace(/\.zip$/i, "");
      const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      let name = validateSkillName(slug);
      if (asWorkflow && !name.startsWith("workflow-")) {
        name = validateSkillName(`workflow-assistant-${name}`);
      }
      const skillRoot = projectDir ? await ensureProjectSkillRoot(projectDir) : await ensureGlobalSkillRoot();
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await mkdir(destination, { recursive: true });
      const destRoot = path.resolve(destination);
      let written = 0;
      for (const file of archive.files) {
        const rel = file.rel.replace(/\\/g, "/").replace(/^\/+/, "");
        if (!rel || rel.split("/").includes("..")) continue; // never escape the skill dir
        const dest = path.join(destination, rel);
        if (!path.resolve(dest).startsWith(destRoot + path.sep)) continue;
        await mkdir(path.dirname(dest), { recursive: true });
        let data = file.data;
        // Installed under a different name (slugified/workflow-prefixed) — keep
        // the SKILL.md frontmatter name in sync so the engine loads it.
        if (rel === "SKILL.md" && name !== rawName) {
          const content = data.toString("utf8");
          const tagged = /(^|\n)name:\s*.*$/m.test(content)
            ? content.replace(/(^|\n)name:\s*.*$/m, `$1name: ${name}`)
            : content;
          data = Buffer.from(tagged, "utf8");
        }
        await writeFile(dest, data);
        written += 1;
      }
      return execResult(true, `Imported ${name} (${written} file${written === 1 ? "" : "s"})`);
  },
  "exportSkillZip": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const name = validateSkillName(args[1]);
      const outputPath = String(args[2] ?? "").trim();
      if (!outputPath) {
        throw new Error("outputPath is required");
      }
      // Resolve via the same lookup the skill list/editor uses, so anything
      // visible in the UI (global or project, flat or nested) is exportable.
      const skillPath = await findSkillFile(projectDir, name);
      if (!skillPath) {
        return execResult(false, "", `Skill not found: ${name}`);
      }
      const result = await exportSkillFolder({
        skillDir: path.dirname(skillPath),
        skillName: name,
        outputPath,
      });
      return execResult(
        true,
        `Exported ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} to ${result.outputPath}`,
      );
  },
  "readLocalSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        throw new Error("Skill not found");
      }
      return { path: skillPath, content: await readFile(skillPath, "utf8") };
  },
  "writeLocalSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found");
      }
      const content = String(args[2] ?? "");
      const next = content.endsWith("\n") ? content : `${content}\n`;
      await writeFile(skillPath, next, "utf8");
      return execResult(true, `Saved skill ${path.basename(path.dirname(skillPath))}`);
  },
  "uninstallSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found in .opencode/skills or .claude/skills");
      }
      await rm(path.dirname(skillPath), { recursive: true, force: true });
      return execResult(true, `Removed skill ${args[1]}`);
  },
  // One-time lift of per-workspace skills + MCP servers into the global config, so
  // existing integrations become available in every workspace. Idempotent: never
  // clobbers a global entry that already exists.
  "migrateExtensionsToGlobal": async (event, ...args) => {
      const projectDirs = Array.isArray(args[0]) && args[0].length
        ? [...new Set(args[0].map((dir) => String(dir ?? "").trim()).filter(Boolean))]
        : [...new Set((await workspaceStore.listLocalWorkspacePaths()).map((dir) => String(dir ?? "").trim()).filter(Boolean))];
      const result = { skillsCopied: 0, mcpMerged: 0, errors: [] };

      // Skills: copy each workspace's project skill dirs into the global skills dir.
      const globalSkillRoot = await ensureGlobalSkillRoot();
      for (const projectDir of projectDirs) {
        try {
          for (const root of await collectProjectSkillRoots(projectDir)) {
            for (const skillDir of await findSkillDirsInRoot(root)) {
              const name = path.basename(skillDir);
              const dest = path.join(globalSkillRoot, name);
              if (await pathExists(path.join(dest, "SKILL.md"))) continue;
              await cp(skillDir, dest, { recursive: true });
              result.skillsCopied += 1;
            }
          }
        } catch (error) {
          result.errors.push(`skills:${projectDir}: ${error?.message ?? error}`);
        }
      }

      // MCP: merge each workspace's project `opencode.json` mcp into the global config.
      let globalObj = /** @type {Record<string, any>} */ ({});
      let globalParsed = true;
      try {
        const globalFile = await readOpencodeConfig("global", "");
        if (globalFile.exists && globalFile.content?.trim()) {
          globalObj = JSON.parse(globalFile.content);
        }
      } catch (error) {
        globalParsed = false;
        result.errors.push(`global-config-unparseable (skipped MCP merge): ${error?.message ?? error}`);
      }
      if (globalParsed) {
        if (!globalObj || typeof globalObj !== "object") globalObj = {};
        if (!globalObj.mcp || typeof globalObj.mcp !== "object") globalObj.mcp = {};
        for (const projectDir of projectDirs) {
          try {
            const projectFile = await readOpencodeConfig("project", projectDir);
            if (!projectFile.exists || !projectFile.content?.trim()) continue;
            const projectObj = JSON.parse(projectFile.content);
            if (projectObj?.mcp && typeof projectObj.mcp === "object") {
              for (const [key, value] of Object.entries(projectObj.mcp)) {
                if (!(key in globalObj.mcp)) {
                  globalObj.mcp[key] = value;
                  result.mcpMerged += 1;
                }
              }
            }
          } catch (error) {
            result.errors.push(`mcp:${projectDir}: ${error?.message ?? error}`);
          }
        }
        if (result.mcpMerged > 0) {
          globalObj["$schema"] = globalObj["$schema"] || "https://opencode.ai/config.json";
          await writeOpencodeConfig("global", "", `${JSON.stringify(globalObj, null, 2)}\n`);
        }
      }
      return result;
  },
  "updaterEnvironment": async (event, ...args) => {
      const executablePath = app.isPackaged ? app.getPath("exe") : process.execPath;
      return {
        supported: true,
        reason: null,
        executablePath,
        appBundlePath:
          process.platform === "darwin"
            ? path.resolve(executablePath, "../../..")
            : path.dirname(executablePath),
      };
  },
  "readOpencodeConfig": async (event, ...args) => {
      return readOpencodeConfig(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
  },
  "writeOpencodeConfig": async (event, ...args) => {
      return writeOpencodeConfig(
        String(args[0] ?? "").trim(),
        String(args[1] ?? "").trim(),
        String(args[2] ?? ""),
      );
  },
  "resetLegalworkState": async (event, ...args) => {
      return workspaceStore.resetLegalworkState();
  },
  "resetOpencodeCache": async (event, ...args) => {
      return { removed: [], missing: [], errors: [] };
  },
  "opencodeMcpAuth": async (event, ...args) => {
      return runtimeManager.opencodeMcpAuth(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
  },
  "setWindowDecorations": async (event, ...args) => {
      return undefined;
  },
  "audioRecorderBootstrap": async (event, ...args) => {
      return recorderService().bootstrap();
  },
  "audioCapturePermissions": async (event, ...args) => {
      return captureAuthStatus(app);
  },
  "audioCapturePermissionsRequest": async (event, ...args) => {
      const kind = args[0] === "systemAudio" ? "systemAudio" : "microphone";
      return requestCapturePermission(app, kind);
  },
  "audioCaptureOpenSettings": async (event, ...args) => {
      const kind = args[0] === "systemAudio" ? "systemAudio" : "microphone";
      return openCapturePermissionSettings(kind);
  },
  "audioModelsScanExisting": async (event, ...args) => {
      return recorderService().modelManager.scanExistingModels();
  },
  "audioModelImport": async (event, ...args) => {
      return recorderService().modelManager.importFromFolder(
        String(args[0] ?? ""),
        typeof args[1] === "string" && args[1] ? args[1] : null,
      );
  },
  "audioTapListApps": async (event, ...args) => {
      // Icons are rendered by the native helper; app.getFileIcon crashes
      // the main process on macOS 15.6 / Electron 35.
      return appAudioTap.listApps();
  },
  "audioTapStart": async (event, ...args) => {
      const pids = Array.isArray(args[0]) ? args[0].map((pid) => Number(pid)).filter(Number.isFinite) : [];
      return appAudioTap.start(pids);
  },
  "audioTapStop": async (event, ...args) => {
      appAudioTap.stop();
      return undefined;
  },
  "audioModelDownload": async (event, ...args) => {
      return recorderService().downloadModel(String(args[0] ?? ""));
  },
  "audioModelDownloadCancel": async (event, ...args) => {
      return recorderService().cancelModelDownload(String(args[0] ?? ""));
  },
  "audioModelDelete": async (event, ...args) => {
      return recorderService().deleteModel(String(args[0] ?? ""));
  },
  "audioDiarizationDownload": async (event, ...args) => {
      return recorderService().downloadDiarization();
  },
  "audioDiarizationStatus": async (event, ...args) => {
      return recorderService().diarizationState();
  },
  "audioTranscriberStart": async (event, ...args) => {
      const input = args[0] ?? {};
      return recorderService().startTranscriber({
        modelId: String(input.modelId ?? ""),
        language: typeof input.language === "string" ? input.language : "auto",
      });
  },
  "audioTranscriberStop": async (event, ...args) => {
      return recorderService().stopTranscriber();
  },
  "audioRecordingStart": async (event, ...args) => {
      return recorderService().startRecording(args[0] ?? {});
  },
  "audioRecordingStop": async (event, ...args) => {
      try {
        return await recorderService().stopRecording(String(args[0] ?? ""));
      } finally {
        // A recording that ended behind a hidden window may have been the
        // only reason for the tray keepalive.
        syncBackgroundPresence();
      }
  },
  "audioRecordingCancel": async (event, ...args) => {
      try {
        return await recorderService().cancelRecording(String(args[0] ?? ""));
      } finally {
        syncBackgroundPresence();
      }
  },
  "audioRecordingsList": async (event, ...args) => {
      return recorderService().listRecordings();
  },
  "audioRecordingGet": async (event, ...args) => {
      return recorderService().getRecording(String(args[0] ?? ""));
  },
  "audioRecordingDelete": async (event, ...args) => {
      return recorderService().deleteRecording(String(args[0] ?? ""));
  },
  "audioRecordingRename": async (event, ...args) => {
      return recorderService().renameRecording(String(args[0] ?? ""), String(args[1] ?? ""));
  },
  "audioRecordingRetain": async (event, ...args) => {
      return recorderService().retainRecording(String(args[0] ?? ""));
  },
  "audioLiveTranscriptStart": async (event, ...args) => {
      return recorderService().startLiveTranscript(String(args[0] ?? ""));
  },
  "audioLiveTranscriptStop": async (event, ...args) => {
      return recorderService().stopLiveTranscript();
  },
  "audioImportStart": async (event, ...args) => {
      return recorderService().importFileStart(args[0] ?? {});
  },
  "audioImportSource": async (event, ...args) => {
      const buffer = args[1] instanceof ArrayBuffer ? args[1] : new ArrayBuffer(0);
      return recorderService().importFileSource(String(args[0] ?? ""), buffer);
  },
  "audioImportFinish": async (event, ...args) => {
      return recorderService().importFileFinish(String(args[0] ?? ""), Number(args[1]) || 0);
  },
  "audioRecordingSaveToWorkspace": async (event, ...args) => {
      return recorderService().saveToWorkspace(String(args[0] ?? ""), String(args[1] ?? ""));
  },
  "audioLoopbackEnable": async (event, ...args) => {
      enableLoopbackAudio(session, desktopCapturer);
      return undefined;
  },
  "audioLoopbackDisable": async (event, ...args) => {
      disableLoopbackAudio(session);
      return undefined;
  },
  "audioOverlaySetVisible": async (event, ...args) => {
      return callOverlay.setVisible(Boolean(args[0]));
  },
  "audioOverlayGetVisible": async (event, ...args) => {
      return { visible: callOverlay.isVisible() };
  },
  "audioSystemDictationGet": async (event, ...args) => {
      return systemDictation.status();
  },
  "audioSystemDictationSetEnabled": async (event, ...args) => {
      try {
        return await systemDictation.setEnabled(Boolean(args[0]));
      } finally {
        syncBackgroundPresence();
      }
  },
  "audioSystemDictationSetShortcut": async (event, ...args) => {
      try {
        return await systemDictation.setShortcut(String(args[0] ?? ""));
      } finally {
        // The tray menu shows the shortcut.
        syncBackgroundPresence();
      }
  },
  "audioSystemDictationSetMode": async (event, ...args) => {
      return systemDictation.setMode(args[0] === "hold" ? "hold" : "tap");
  },
  "audioSystemDictationSetShortcutCapture": async (event, ...args) => {
      return systemDictation.setShortcutCapture(Boolean(args[0]));
  },
  "audioSystemDictationOpenSettings": async (event, ...args) => {
      return systemDictation.openSettings();
  },
  "audioSystemDictationSetState": async (event, ...args) => {
      const state = ["idle", "listening", "transcribing", "error"].includes(args[0])
        ? args[0]
        : "idle";
      return systemDictation.setRuntimeState(state, String(args[1] ?? ""));
  },
  "audioSystemDictationReadiness": async (event, ...args) => {
      return healDictationMonitor(await dictationPermissions.readiness());
  },
  "audioSystemDictationRequestPermission": async (event, ...args) => {
      const kind = ["microphone", "inputMonitoring", "accessibility", "automation"].includes(args[0])
        ? args[0]
        : "microphone";
      return healDictationMonitor(await dictationPermissions.request(kind));
  },
  "audioSystemDictationRepairPermission": async (event, ...args) => {
      const kind = ["inputMonitoring", "accessibility", "automation"].includes(args[0])
        ? args[0]
        : "inputMonitoring";
      return healDictationMonitor(await dictationPermissions.repair(kind));
  },
  "audioSystemDictationPaste": async (event, ...args) => {
      // The recording's own power session ends at stop; the decode tail and
      // paste still need suspension protection (the sherpa decode has no
      // audio-stream exemption from idle sleep).
      powerSessions.acquire("dictation-paste");
      try {
        return await systemDictation.pasteText(String(args[0] ?? ""));
      } finally {
        powerSessions.release("dictation-paste");
      }
  },
  "desktopLoginItemGet": async (event, ...args) => {
      try {
        const settings = app.getLoginItemSettings();
        return {
          openAtLogin: settings.openAtLogin === true,
          requiresApproval: settings.status === "requires-approval",
        };
      } catch {
        return { openAtLogin: false, requiresApproval: false };
      }
  },
  "desktopLoginItemSet": async (event, ...args) => {
      const openAtLogin = Boolean(args[0]);
      try {
        app.setLoginItemSettings({
          openAtLogin,
          // Windows: boot into the tray. macOS login items launch normally;
          // whenReady detects wasOpenedAtLogin instead.
          ...(process.platform === "win32" ? { args: openAtLogin ? ["--hidden"] : [] } : {}),
        });
      } catch {
        // Fall through to reporting the actual state below.
      }
      try {
        const settings = app.getLoginItemSettings();
        return {
          openAtLogin: settings.openAtLogin === true,
          requiresApproval: settings.status === "requires-approval",
        };
      } catch {
        return { openAtLogin, requiresApproval: false };
      }
  },
  "windowSetStealth": async (event, ...args) => {
      const enabled = Boolean(args[0]);
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      // While a local recording runs, exclude the window from screen shares /
      // recordings (invisible in Zoom/Teams/QuickTime). This is the only thing
      // stealth does now — no theme/backdrop change; the renderer shows a small
      // topbar "Recording locally" cue so the user knows it's on.
      mainWindow.setContentProtection(enabled);
      return true;
  },
  "__openPath": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return "Path is required.";
      return shell.openPath(target);
  },
  "__revealItemInDir": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return undefined;
      shell.showItemInFolder(target);
      return undefined;
  },
  "__getFileIcon": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return null;
      const requestedSize = args[1];
      /** @type {"small" | "normal" | "large"} */
      let validSize = "normal";
      if (requestedSize === "small" || requestedSize === "normal" || requestedSize === "large") {
        validSize = requestedSize;
      }
      try {
        const image = await app.getFileIcon(target, { size: validSize });
        return image.isEmpty() ? null : image.toDataURL();
      } catch {
        return null;
      }
  },
  "__getApplicationsForFile": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return [];
      const platform = process.platform;
      const results = [];

      try {
        if (platform === "darwin") {
          // Scan /Applications and /System/Applications for .app bundles
          const appDirs = ["/Applications", "/System/Applications", "/Applications/Utilities", `${os.homedir()}/Applications`];
          const seen = new Set();
          for (const dir of appDirs) {
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const entry of entries) {
              if (!entry.endsWith(".app")) continue;
              const appPath = path.join(dir, entry);
              if (seen.has(appPath)) continue;
              seen.add(appPath);
              const name = entry.replace(/\.app$/i, "");
              let icon = null;
              try {
                const img = await app.getFileIcon(appPath, { size: "small" });
                icon = img.isEmpty() ? null : img.toDataURL();
              } catch {}
              results.push({ name, appPath, icon });
            }
          }
        } else if (platform === "linux") {
          // Parse .desktop files in standard directories
          const desktopDirs = ["/usr/share/applications", "/usr/local/share/applications", `${os.homedir()}/.local/share/applications`];
          const seen = new Set();
          for (const dir of desktopDirs) {
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const entry of entries) {
              if (!entry.endsWith(".desktop")) continue;
              const filePath = path.join(dir, entry);
              if (seen.has(filePath)) continue;
              seen.add(filePath);
              try {
                const content = await readFile(filePath, "utf-8");
                const nameMatch = content.match(/^Name=(.+)$/m);
                const execMatch = content.match(/^Exec=(.+)$/m);
                if (!nameMatch || !execMatch) continue;
                const name = nameMatch[1].trim();
                const appPath = execMatch[1].trim().replace(/%[fFuU]/g, "").trim();
                if (!appPath) continue;
                let icon = null;
                try {
                  const img = await app.getFileIcon(filePath, { size: "small" });
                  icon = img.isEmpty() ? null : img.toDataURL();
                } catch {}
                results.push({ name, appPath, icon });
              } catch {}
            }
          }
        }
      } catch {}

      return results;
  },
  "__openWithApp": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      const appPath = String(args[1] ?? "").trim();
      if (!target || !appPath) return "Target and app path are required.";
      const platform = process.platform;
      try {
        if (platform === "darwin") {
          execFileSync("open", ["-a", appPath, target]);
        } else if (platform === "linux") {
          const child = spawn(appPath, [target], { detached: true, stdio: "ignore" });
          child.unref();
        } else {
          return `Open with app is not supported on ${platform}`;
        }
      } catch (err) {
        return String(err?.message ?? err);
      }
  },
  "__fetch": async (event, ...args) => {
      const url = String(args[0] ?? "").trim();
      const init = args[1] ?? {};
      if (!url) throw new Error("URL is required.");
      const timeoutMs = Number(init.timeoutMs);
      const response = await fetch(url, {
        method: typeof init.method === "string" ? init.method : undefined,
        headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
        body: typeof init.body === "string" ? init.body : undefined,
        signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        body: await response.text(),
      };
  },
  "__homeDir": async (event, ...args) => {
      return os.homedir();
  },
  "__joinPath": async (event, ...args) => {
      return path.join(...args.map((value) => String(value ?? "")));
  },
  "__setZoomFactor": async (event, ...args) => {
      const factor = Number(args[0]);
      const window = activeWindowFromEvent(event);
      if (!window || !Number.isFinite(factor) || factor <= 0) {
        return false;
      }
      window.webContents.setZoomFactor(factor);
      return true;
  },
  "__setNativeTheme": async (event, ...args) => {
      return applyNativeTheme(String(args[0]));
  },
  "__setApplicationMenuVisible": async (event, ...args) => {
      return applicationMenu.setVisible(args[0]);
  },
};

async function handleDesktopInvoke(event, command, ...args) {
  const handler = desktopCommandHandlers[command];
  if (!handler) {
    throw new Error(`Electron desktop bridge method is not implemented yet: ${command}`);
  }
  return handler(event, ...args);
}


async function createMainWindow() {
  if (mainWindow) return mainWindow;

  const preloadPath = path.join(__dirname, "preload.mjs");
  const windowAppearanceOptions = {};
  if (process.platform === "darwin") {
    Object.assign(windowAppearanceOptions, {
      backgroundColor: "#00000001",
      titleBarStyle: "hiddenInset",
      vibrancy: macosVibrancyForCurrentTheme(),
      visualEffectState: "active",
    });
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    title: APP_NAME,
    show: false,
    ...windowAppearanceOptions,
    ...(APP_ICON_IMAGE && !APP_ICON_IMAGE.isEmpty() ? { icon: APP_ICON_IMAGE } : {}),
    webPreferences: {
      // The renderer owns session dispatch + event streams; keep it running
      // while hidden/minimized so background tasks are not interrupted.
      backgroundThrottling: false,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enable Chromium's built-in PDF viewer (PDFium) so the in-app artifact
      // panel can render PDFs inline in a (non-sandboxed) iframe.
      plugins: true,
    },
  });
  applicationMenu.applyVisibility(mainWindow);
  if (recorderServiceInstance) {
    recorderServiceInstance.subscribe(mainWindow.webContents);
  }

  if (isDevMode) {
    mainWindow.on("page-title-updated", (event) => {
      event.preventDefault();
      mainWindow?.setTitle(APP_NAME);
    });
    mainWindow.setTitle(APP_NAME);
  }

  mainWindow.once("ready-to-show", () => {
    if (isDevMode) {
      mainWindow?.setTitle(APP_NAME);
    }
    // Login-item launches boot into the background: the renderer loads (and
    // arms the dictation pipeline) without a window appearing. Only honored
    // while dictation keeps a tray around — a hidden window with no tray
    // would be unreachable.
    if (startHiddenPending && systemDictation.status().enabled) {
      startHiddenPending = false;
      syncBackgroundPresence();
      return;
    }
    startHiddenPending = false;
    mainWindow?.show();
    flushPendingDeepLinks();
  });

  // While dictation is armed (or a recording is finishing), closing the
  // window would kill the renderer that hosts the capture pipeline — hide it
  // instead. Quit still closes for real via the before-quit flag.
  mainWindow.on("close", (event) => {
    if (appIsQuitting || !keepAliveOnClose()) return;
    const status = systemDictation.status();
    appTray.ensure({
      dictationEnabled: status.enabled,
      shortcutLabel: trayShortcutLabel(status),
    });
    // A hidden window leaves no taskbar entry on Windows; if the tray could
    // not be created, a real close beats stranding the user.
    if (process.platform === "win32" && !appTray.isActive()) return;
    event.preventDefault();
    mainWindow?.hide();
    if (process.platform === "win32" && !windowsCloseHintShown) {
      windowsCloseHintShown = true;
      appTray.displayCloseHint();
    }
  });

  mainWindow.on("show", () => {
    syncBackgroundPresence();
  });

  mainWindow.on("closed", () => {
    browserPanel.destroy();
    mainWindow = null;
  });

  // A crashed renderer takes the dictation capture pipeline with it; reload
  // so the hotkey keeps working. Repeated crashes stop the loop.
  let rendererReloads = 0;
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || details.reason === "killed") return;
    // The dead renderer owned every active recording's capture; finalize or
    // cancel them so their power blocker and the close-to-hide latch release
    // instead of pinning the machine awake until quit.
    void recorderServiceInstance?.abandonActiveRecordings().finally(syncBackgroundPresence);
    if (rendererReloads >= 3) return;
    rendererReloads += 1;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    }, 1_000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("file://")) {
      try {
        void shell.openPath(fileURLToPath(url));
      } catch {
        void shell.openExternal(url);
      }

      return { action: "deny" };
    }

    const local =
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost");
    if (!local) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (browserPanel.isMainWindowAllowedNavigation(url)) return;
    event.preventDefault();
    browserPanel.routeBlockedMainWindowNavigation(url);
  });

  // `will-navigate` does NOT fire for CDP `Page.navigate` (it behaves like
  // loadURL), so agent automation that picks the wrong CDP target — the app
  // window itself is the first page target when no browser tab exists — used
  // to replace the entire workspace UI with the website, with no way back
  // (#2000). Catch those at `did-start-navigation`, cancel the load, and
  // reroute the URL into a built-in browser tab instead.
  mainWindow.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    if (browserPanel.isMainWindowAllowedNavigation(url)) return;
    try {
      mainWindow?.webContents.stop();
    } catch {
      // best effort — routing below still gives the user a way back
    }
    browserPanel.routeBlockedMainWindowNavigation(url);
  });

  const startUrl = process.env.LEGALWORK_ELECTRON_START_URL?.trim() || process.env.ELECTRON_START_URL?.trim();
  if (startUrl) {
    await mainWindow.loadURL(startUrl);
  } else {
    const packagedIndexPath = path.join(process.resourcesPath, "app-dist", "index.html");
    const devIndexPath = path.resolve(__dirname, "../../app/dist/index.html");
    await mainWindow.loadFile(app.isPackaged ? packagedIndexPath : devIndexPath);
  }

  return mainWindow;
}

ipcMain.handle("legalwork:desktop", handleDesktopInvoke);
ipcMain.handle("legalwork:shell:openExternal", async (_event, url) => {
  if (typeof url === "string" && url.trim().length > 0) {
    await shell.openExternal(url);
  }
});
ipcMain.handle("legalwork:shell:relaunch", async () => {
  app.relaunch();
  app.exit(0);
});
ipcMain.handle("legalwork:system:architecture", async () => resolveArchitectureInfo());
ipcMain.handle("legalwork:system:microphoneStatus", async () => {
  if (process.platform !== "darwin") return { platform: process.platform, status: "not-mac" };
  return { platform: process.platform, status: systemPreferences.getMediaAccessStatus("microphone") };
});
ipcMain.handle("legalwork:system:askMicrophoneAccess", async () => {
  if (process.platform !== "darwin") return { platform: process.platform, granted: true, status: "not-mac" };
  const before = systemPreferences.getMediaAccessStatus("microphone");
  const granted = await systemPreferences.askForMediaAccess("microphone");
  const after = systemPreferences.getMediaAccessStatus("microphone");
  return { platform: process.platform, before, after, granted };
});

// ── Terminal IPC ────────────────────────────────────────────────────────
ipcMain.handle("legalwork:terminal:create", async (event, options = {}) => {
  const cwd = await resolveTerminalCwd(options?.cwd);
  const cols = Number.isFinite(options?.cols) ? Math.max(20, Math.floor(options.cols)) : 80;
  const rows = Number.isFinite(options?.rows) ? Math.max(5, Math.floor(options.rows)) : 24;
  const terminalId = `term_${nextTerminalId++}`;
  const shellPath = defaultTerminalShell();
  const child = pty.spawn(shellPath, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LEGALWORK_TERMINAL: "1",
    },
  });

  terminalProcesses.set(terminalId, { process: child, webContentsId: event.sender.id });
  event.sender.once("destroyed", () => killTerminalsForWebContents(event.sender.id));
  child.onData((data) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send("legalwork:terminal:data", { terminalId, data });
  });
  child.onExit(({ exitCode, signal }) => {
    terminalProcesses.delete(terminalId);
    if (event.sender.isDestroyed()) return;
    event.sender.send("legalwork:terminal:exit", { terminalId, exitCode, signal });
  });

  return { terminalId };
});
ipcMain.handle("legalwork:terminal:write", (event, terminalId, data) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal || typeof data !== "string") return;
  terminal.process.write(data);
});
ipcMain.handle("legalwork:terminal:resize", (event, terminalId, cols, rows) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
  terminal.process.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)));
});
ipcMain.handle("legalwork:terminal:kill", (event, terminalId) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal) return;
  killTerminal(String(terminalId));
});

browserPanel.registerIpc(ipcMain);

// ── Recorder streaming channels ────────────────────────────────────────────
// High-frequency payloads use fire-and-forget send() instead of the typed
// invoke bridge: 16 kHz mono Float32 PCM for live transcription and
// MediaRecorder chunks for the audio file on disk.
ipcMain.on("legalwork:audio:pcm", (_event, streamId, buffer) => {
  if (typeof streamId !== "string" || !(buffer instanceof ArrayBuffer)) return;
  recorderService().feedPcm(streamId, buffer);
});
ipcMain.on("legalwork:audio:media-chunk", (_event, recordingId, chunk) => {
  if (typeof recordingId !== "string" || !(chunk instanceof ArrayBuffer)) return;
  recorderService().appendMediaChunk(recordingId, chunk);
});
// Overlay ↔ main-window relays. The overlay window has no session client of
// its own; questions go to the main window's AI and answers stream back.
ipcMain.on("legalwork:audio:overlay-ask", (_event, askId, question) => {
  recorderService().broadcast({
    type: "overlay-ask",
    askId: String(askId ?? ""),
    question: String(question ?? ""),
  });
});
ipcMain.on("legalwork:audio:overlay-suggest", (_event, askId) => {
  recorderService().broadcast({ type: "overlay-suggest", askId: String(askId ?? "") });
});
ipcMain.on("legalwork:audio:ask-answer", (_event, askId, text, done, error) => {
  recorderService().broadcast({
    type: "ask-answer",
    askId: String(askId ?? ""),
    text: String(text ?? ""),
    done: Boolean(done),
    error: typeof error === "string" && error ? error : null,
  });
});
ipcMain.on("legalwork:audio:overlay-hide", () => {
  void callOverlay.setVisible(false);
});

registerMigrationIpc({ app, ipcMain });
const { ensureAutoUpdater } = registerUpdaterIpc({ app, ipcMain, getMainWindow: () => mainWindow });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    // Lets the window 'close' handler distinguish quit from close-to-hide.
    appIsQuitting = true;
    if (runtimeDisposedForQuit) return;
    event.preventDefault();
    if (runtimeDisposeInProgress) return;
    showShutdownScreen();
    recorderServiceInstance?.dispose();
    appAudioTap.stop();
    callOverlay.destroy();
    systemDictation.dispose();
    dictationHud.destroy();
    appTray.destroy();
    powerSessions.releaseAll();
    void Promise.all([disposeRuntimeBeforeQuit(), uiControlServer.stop()]).finally(() => app.quit());
  });

  app.on("second-instance", async (_event, argv) => {
    const win = await createMainWindow();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    queueDeepLinks(forwardedDeepLinks(argv));
  });

  app.on("open-url", async (event, url) => {
    event.preventDefault();
    await createMainWindow();
    queueDeepLinks([url]);
  });

  app.whenReady().then(async () => {
    // Serve recording audio to <audio> elements. The element loads this URL
    // natively (no async JS between the click and play()), so first-play works
    // within the user gesture, and Range requests stream the file for seeking.
    protocol.handle(RECORDING_AUDIO_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const id = decodeURIComponent(url.pathname.replace(/^\/+/, "")) || decodeURIComponent(url.hostname);
        const filePath = recorderService().recordingAudioFilePath(id);
        if (!filePath) return new Response(null, { status: 404 });
        // Serve with byte-range support so <audio> can seek. Without a 206 +
        // Accept-Ranges the media element treats the source as non-seekable.
        const size = statSync(filePath).size;
        const baseHeaders = {
          "Content-Type": recordingAudioContentType(filePath),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        };
        const rangeMatch = /bytes=(\d*)-(\d*)/.exec(request.headers.get("Range") ?? "");
        if (rangeMatch) {
          let start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : 0;
          let end = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : size - 1;
          if (!Number.isFinite(start) || start < 0) start = 0;
          if (!Number.isFinite(end) || end >= size) end = size - 1;
          if (start > end) {
            return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
          }
          // Node's web ReadableStream is structurally a valid Response body but
          // nominally differs from the DOM type tsc sees here — cast past it.
          return new Response(/** @type {any} */ (Readable.toWeb(createReadStream(filePath, { start, end }))), {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes ${start}-${end}/${size}`,
              "Content-Length": String(end - start + 1),
            },
          });
        }
        return new Response(/** @type {any} */ (Readable.toWeb(createReadStream(filePath))), {
          status: 200,
          headers: { ...baseHeaders, "Content-Length": String(size) },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    if (process.platform === "darwin" && app.dock) {
      await app.dock.show();
      if (APP_ICON_IMAGE && !APP_ICON_IMAGE.isEmpty()) app.dock.setIcon(APP_ICON_IMAGE);
    }
    // Keep the main process (which delivers the globalShortcut chord and the
    // hotkey→capture IPC) at Windows HighQoS so a hidden/occluded window
    // can't get it EcoQoS-throttled into laggy hotkey response.
    pinWindowsProcessQoS([process.pid]);
    installMediaPermissionHandlers(session, () => mainWindow, { isLoopbackCaptureArmed });
    applicationMenu.install();
    await runtimeManager.prepareFreshRuntime().catch(() => undefined);

    // Use Tauri's existing workspace state file as canonical so rollback and
    // Electron see the same workspace list. Import the short-lived
    // Electron-only filename only when the shared file is missing.
    await workspaceStore.migrateLegacyElectronWorkspaceStateIfNeeded();

    // Remove the analytics identity file persisted by earlier builds (the
    // identity is now in-memory only).
    try {
      const configPath = resolveLegalworkServerConfigPath(process.env);
      await rm(path.join(path.dirname(configPath), "legalwork-analytics-identity.json"), { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    await uiControlServer.start().catch((error) => {
      console.warn("[ui-control] failed to start", error);
    });
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch(describeRuntimeBootFailure);

    queueDeepLinks(forwardedDeepLinks(process.argv));
    if (process.platform === "darwin" && !startHiddenPending) {
      try {
        startHiddenPending = app.getLoginItemSettings().wasOpenedAtLogin === true;
      } catch {
        // Login-item status is a convenience; never block startup on it.
      }
    }
    await systemDictation.initialize();
    syncBackgroundPresence();

    // Suspend/resume/lock sequencing: stop work immediately on suspend (the
    // renderer finalizes call recordings and cancels dictation — a paste
    // into whatever is focused after wake would be wrong), then health-check
    // the parts that verifiably die across sleep: the native key monitor and
    // the transcription worker. The Electron chord registration is OS-held
    // and is only re-applied when the OS reports it lost.
    const powerLifecycle = new PowerLifecycle({
      powerMonitor,
      onSuspend: () => {
        recorderService().broadcast({ type: "power-suspend" });
      },
      onResume: async () => {
        await systemDictation.refreshAfterResume();
        await recorderService().ensureTranscriberAfterWake();
      },
      onLockScreen: () => {
        // No paste target exists behind the lock screen; call recordings
        // legitimately continue (locking during a call is normal).
        recorderService().broadcast({ type: "system-dictation-cancel" });
      },
      onUnlockScreen: async () => {
        // The secure desktop swallows key-ups (Win+L is pressed to get
        // there) — rebuild key state even without a sleep in between.
        await systemDictation.refreshAfterResume();
      },
    });
    powerLifecycle.start();

    const win = await createMainWindow();
    win.webContents.on("did-finish-load", () => {
      flushPendingDeepLinks();
    });

    // Initialize the packaged updater after the window is up so the user sees
    // a working app first. Renderer-owned checks pass the selected release
    // channel explicitly, avoiding stale stable-feed results for alpha users.
    void ensureAutoUpdater();
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
      return;
    }
    const win = await createMainWindow();
    win.show();
    win.focus();
  });

  // Only reachable when the window really closed — with dictation enabled
  // (or a recording running) the 'close' handler hides instead.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
