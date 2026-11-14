import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

/** Run a native helper and collect its stdout; a timeout kills it and rejects. */
export function execHelper(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, options.timeoutMs ?? 5000);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); resolve(stdout); });
  });
}

const WINDOWS_FRONTMOST_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LegalWorkFront {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
}
'@
$window = [LegalWorkFront]::GetForegroundWindow()
if ($window -eq [IntPtr]::Zero) { '{"ok":false,"reason":"none"}'; exit 0 }
$foregroundProcessId = [uint32]0; [LegalWorkFront]::GetWindowThreadProcessId($window, [ref]$foregroundProcessId) | Out-Null
$title = New-Object System.Text.StringBuilder 512; [LegalWorkFront]::GetWindowText($window, $title, 512) | Out-Null
$process = Get-Process -Id $foregroundProcessId -ErrorAction SilentlyContinue
@{ ok = $true; pid = [int]$foregroundProcessId; app = $(if ($process) { $process.ProcessName } else { "" }); bundleId = $(if ($process -and $process.Path) { $process.Path } else { "" }); window = $title.ToString(); accessibility = $true } | ConvertTo-Json -Compress
`;
const WINDOWS_SELECTION_SCRIPT = String.raw`
param([int]$TargetPid)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
try {
  $element = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $element) { '{"ok":false,"reason":"unsupported"}'; exit 0 }
  if ($element.Current.ProcessId -ne $TargetPid) { '{"ok":false,"reason":"changed"}'; exit 0 }
  $pattern = $null
  if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { '{"ok":false,"reason":"unsupported"}'; exit 0 }
  $text = ($pattern.GetSelection() | ForEach-Object { $_.GetText(200000) }) -join ""
  if (-not $text) { '{"ok":false,"reason":"empty"}'; exit 0 }
  @{ ok = $true; text = $text } | ConvertTo-Json -Compress
} catch { '{"ok":false,"reason":"failed"}' }
`;
const WINDOWS_ACTIVATE_SCRIPT = String.raw`
param([int]$TargetPid)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LegalWorkActivate {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}
'@
$process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if ($null -eq $process -or $process.MainWindowHandle -eq [IntPtr]::Zero) { '{"ok":false,"reason":"no-origin"}'; exit 0 }
[LegalWorkActivate]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
[LegalWorkActivate]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 120
$foregroundProcessId = [uint32]0; [LegalWorkActivate]::GetWindowThreadProcessId([LegalWorkActivate]::GetForegroundWindow(), [ref]$foregroundProcessId) | Out-Null
@{ ok = ([int]$foregroundProcessId -eq $TargetPid); reason = $(if ([int]$foregroundProcessId -eq $TargetPid) { "" } else { "changed" }) } | ConvertTo-Json -Compress
`;

/** The last JSON object a helper printed, or null for anything else. */
export function parseHelperJson(output) {
  const lines = String(output ?? "").split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith("{"));
  for (const line of lines.reverse()) { try { return JSON.parse(line); } catch { /* keep looking */ } }
  return null;
}
/** The origin is valid while the same process shows the same window; a document switch is a changed origin. */
export function originMatches(origin, front) {
  if (!origin || !front?.ok) return false;
  if (origin.pid !== null && front.pid !== undefined && origin.pid !== Number(front.pid)) return false;
  if (origin.bundleId && front.bundleId && origin.bundleId !== front.bundleId) return false;
  if (!origin.window || !front.window || origin.window !== front.window) return false;
  return true;
}
const ownPids = () => new Set([process.pid]);

/**
 * Platform origin and focus service. The origin is captured before the panel
 * takes focus, revalidated before anything is read from or written to it, and
 * never guessed from whichever window happens to be in front later.
 */
export class OriginService {
  /**
   * @param {{ platform?: string, helperPath?: string | null, exec: (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<string>,
   *   clipboard: { readText: () => string, writeText: (text: string) => void }, pasteText: (text: string) => Promise<{ pasted: boolean, copied: boolean, error: string | null }>,
   *   isOwnProcess?: (pid: number | null, bundleId: string | null) => boolean, exists?: (path: string) => boolean }} options
   */
  constructor(options) {
    /** @type {"darwin" | "windows" | "linux"} */
    this.platform = options.platform === "darwin" || options.platform === "windows" || options.platform === "linux" ? options.platform : process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    this.helperPath = options.helperPath ?? null;
    this.exec = options.exec;
    this.clipboard = options.clipboard;
    this.pasteText = options.pasteText;
    this.isOwnProcess = options.isOwnProcess ?? ((pid, bundleId) => ownPids().has(pid ?? -1) || Boolean(bundleId && /legalwork/i.test(bundleId)));
    this.exists = options.exists ?? existsSync;
    /** @type {import("@legalwork/types/launcher").LauncherOrigin | null} */
    this.origin = null;
    /** A selection read as part of an explicit capture shortcut, handed out once to the panel. */
    this.prefetched = null;
  }
  helperAvailable() { return Boolean(this.helperPath && this.exists(this.helperPath)); }
  capabilities() {
    const helper = this.helperAvailable();
    if (this.platform === "darwin") return { origin: true, selection: true, insert: true, windowCapture: true, regionCapture: true, helper };
    if (this.platform === "windows") return { origin: true, selection: true, insert: true, windowCapture: true, regionCapture: true, helper: false };
    return { origin: false, selection: false, insert: false, windowCapture: true, regionCapture: true, helper: false };
  }
  async frontmost() {
    try {
      if (this.platform === "darwin") {
        if (this.helperAvailable()) return parseHelperJson(await this.exec(this.helperPath, ["--frontmost"], { timeoutMs: 4000 }));
        const output = await this.exec("/usr/bin/osascript", ["-e", 'tell application "System Events" to get {name, unix id, bundle identifier} of first application process whose frontmost is true'], { timeoutMs: 4000 });
        const [name, pid, bundleId] = String(output).trim().split(", ");
        return name ? { ok: true, app: name, pid: Number(pid), bundleId: bundleId ?? "", window: null, accessibility: false } : { ok: false, reason: "none" };
      }
      if (this.platform === "windows") return parseHelperJson(await this.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FRONTMOST_SCRIPT], { timeoutMs: 6000 }));
    } catch { return { ok: false, reason: "failed" }; }
    return { ok: false, reason: "unsupported" };
  }
  /** Record the external origin. LegalWork's own windows are never an origin. */
  async capture() {
    this.prefetched = null;
    const front = await this.frontmost();
    if (!front?.ok || this.isOwnProcess(Number(front.pid) || null, front.bundleId || null)) { this.invalidate(); return null; }
    const capabilities = this.capabilities();
    this.origin = { id: `origin_${randomBytes(6).toString("hex")}`, app: front.app || null, window: front.window || null, bundleId: front.bundleId || null, pid: Number.isInteger(front.pid) ? Number(front.pid) : null,
      // Windows can read the selection only while the source still has focus: the selection shortcut prefetches it; a plain open offers nothing it cannot deliver.
      capturedAt: Date.now(), supportsSelection: capabilities.selection && Boolean(front.accessibility ?? true) && this.platform !== "windows", supportsInsert: capabilities.insert, platform: this.platform };
    return this.origin;
  }
  current() { return this.origin; }
  invalidate() { this.origin = null; this.prefetched = null; }
  /** An explicit selection shortcut reads the selection as part of the invocation, before the panel takes focus. */
  async prefetchSelection() {
    this.prefetched = null;
    const origin = this.origin;
    if (!origin) return null;
    const result = await this.readSelection(origin);
    if (result.ok) { this.prefetched = { originId: origin.id, text: result.text }; origin.supportsSelection = true; }
    return result;
  }
  /** @returns {Promise<import("@legalwork/types/launcher").LauncherSelectionResult>} */
  async selection(originId) {
    const origin = this.origin;
    if (!origin || origin.id !== originId) return { ok: false, reason: "no-origin", message: "The source app was not recorded.", origin: null };
    if (this.prefetched?.originId === originId) { const { text } = this.prefetched; this.prefetched = null; return { ok: true, text, origin }; }
    if (this.platform === "windows") return { ok: false, reason: "changed", message: "On Windows the selection is read by the selection shortcut before the panel opens. Select the text and use that shortcut.", origin };
    return this.readSelection(origin);
  }
  /**
   * Read the selection of the recorded origin from the platform.
   * @param {import("@legalwork/types/launcher").LauncherOrigin} origin
   * @returns {Promise<import("@legalwork/types/launcher").LauncherSelectionResult>}
   */
  async readSelection(origin) {
    if (!this.capabilities().selection) return { ok: false, reason: "unsupported", message: "Reading a selection is not supported on this system.", origin };
    try {
      let result = null;
      if (this.platform === "darwin" && this.helperAvailable()) result = parseHelperJson(await this.exec(this.helperPath, ["--selected-text", String(origin.pid)], { timeoutMs: 5000 }));
      else if (this.platform === "windows") result = parseHelperJson(await this.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SELECTION_SCRIPT, "-TargetPid", String(origin.pid)], { timeoutMs: 8000 }));
      else return { ok: false, reason: "unsupported", message: "The native helper is not installed; the selection cannot be read.", origin };
      if (result?.ok && typeof result.text === "string" && result.text) return { ok: true, text: result.text, origin };
      const reason = /** @type {"empty" | "changed" | "denied" | "unsupported" | "failed"} */ (["empty", "changed", "denied", "unsupported", "failed"].includes(result?.reason) ? result.reason : "failed");
      return { ok: false, reason, message: "", origin };
    } catch { return { ok: false, reason: "failed", message: "The selection could not be read.", origin }; }
  }
  async activate(origin) {
    try {
      if (this.platform === "darwin") {
        if (this.helperAvailable()) return parseHelperJson(await this.exec(this.helperPath, ["--activate", String(origin.pid)], { timeoutMs: 5000 }))?.ok === true;
        await this.exec("/usr/bin/osascript", ["-e", `tell application "System Events" to set frontmost of (first application process whose unix id is ${Number(origin.pid)}) to true`], { timeoutMs: 4000 });
        return true;
      }
      if (this.platform === "windows") return parseHelperJson(await this.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACTIVATE_SCRIPT, "-TargetPid", String(origin.pid)], { timeoutMs: 8000 }))?.ok === true;
    } catch { return false; }
    return false;
  }
  /**
   * Insert only into the validated origin. Anything else copies and says why.
   * @returns {Promise<import("@legalwork/types/launcher").LauncherInsertResult>}
   */
  async insert(originId, text) {
    const origin = this.origin;
    const value = String(text ?? "");
    /** @param {"no-origin" | "changed" | "unavailable" | "denied" | "failed"} reason @param {string} message @returns {import("@legalwork/types/launcher").LauncherInsertResult} */
    const copy = (reason, message) => { try { this.clipboard.writeText(value); } catch { return { ok: false, reason: "failed", message: "The result could not be copied. It remains in the conversation.", copied: false, origin }; } return { ok: false, reason, message, copied: true, origin }; };
    if (!origin || origin.id !== originId) return copy("no-origin", "The destination app was not recorded. The result was copied.");
    if (!origin.supportsInsert || origin.pid === null) return copy("unavailable", "Inserting into this app is not supported. The result was copied.");
    const activated = await this.activate(origin);
    const front = await this.frontmost();
    if (!activated || !originMatches(origin, front)) return copy("changed", "The destination changed since the panel opened. The result was copied; paste it where it belongs.");
    const result = await this.pasteText(value);
    if (result.pasted) return { ok: true, method: "paste", origin };
    return { ok: false, reason: result.error?.includes("Accessibility") ? "denied" : "failed", message: result.error ?? "Automatic paste failed. The result was copied.", copied: result.copied, origin };
  }
}
