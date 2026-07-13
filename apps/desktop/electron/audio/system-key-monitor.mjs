import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_NAME = "LegalWorkKeyMonitor";
const START_TIMEOUT_MS = 5_000;
// A helper that dies after running is restarted with backoff before the
// feature degrades: low-level hooks and event taps verifiably die across
// sleep/wake and under load (the OS removes them silently), and losing hold
// mode until an app restart is the worst failure a dictation user can hit.
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000];
const RESTART_RESET_UPTIME_MS = 10_000;

const WINDOWS_MONITOR_SCRIPT = String.raw`
$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class LegalWorkKeyMonitor {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_KEYUP = 0x0101;
  private const int WM_SYSKEYDOWN = 0x0104;
  private const int WM_SYSKEYUP = 0x0105;

  private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  private static readonly HookProc Callback = HookCallback;
  private static IntPtr hook = IntPtr.Zero;

  [StructLayout(LayoutKind.Sequential)]
  private struct KeyboardData {
    public uint virtualKey;
    public uint scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct Message {
    public IntPtr window;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x;
    public int y;
    public uint privateValue;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PowerThrottlingState {
    public uint Version;
    public uint ControlMask;
    public uint StateMask;
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int hookId, HookProc callback, IntPtr module, uint threadId);
  [DllImport("user32.dll")]
  private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")]
  private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")]
  private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentThread();
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetProcessInformation(IntPtr process, int informationClass, ref PowerThrottlingState state, uint size);
  [DllImport("kernel32.dll")]
  private static extern bool SetThreadPriority(IntPtr thread, int priority);

  // Windows 11 EcoQoS / timer-resolution coalescing can throttle a hidden
  // background process hard enough that the hook callback risks the silent
  // LowLevelHooksTimeout removal. Pin this process to HighQoS and keep
  // high-resolution timers; both calls are no-ops before Win11 22H2.
  private static void PinResponsiveness() {
    try {
      PowerThrottlingState state = new PowerThrottlingState();
      state.Version = 1; // PROCESS_POWER_THROTTLING_CURRENT_VERSION
      // PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
      state.ControlMask = 0x1 | 0x4;
      state.StateMask = 0; // opted out (never throttle)
      SetProcessInformation(GetCurrentProcess(), 4 /* ProcessPowerThrottling */, ref state,
        (uint)Marshal.SizeOf(typeof(PowerThrottlingState)));
      SetThreadPriority(GetCurrentThread(), 15 /* THREAD_PRIORITY_TIME_CRITICAL */);
    } catch (Exception) {
      // Older Windows: run without the pin.
    }
  }

  private static string KeyName(uint key) {
    if (key >= 0x41 && key <= 0x5A) return ((char)key).ToString();
    if (key >= 0x30 && key <= 0x39) return ((char)key).ToString();
    if (key >= 0x70 && key <= 0x87) return "F" + (key - 0x6F).ToString();
    switch (key) {
      case 0xA2: case 0xA3: case 0x11: return "Control";
      case 0xA4: case 0xA5: case 0x12: return "Alt";
      case 0xA0: case 0xA1: case 0x10: return "Shift";
      case 0x5B: case 0x5C: return "Super";
      case 0x20: return "Space";
      case 0x08: return "Backspace";
      case 0x09: return "Tab";
      case 0x0D: return "Enter";
      case 0x1B: return "Escape";
      case 0x21: return "PageUp";
      case 0x22: return "PageDown";
      case 0x23: return "End";
      case 0x24: return "Home";
      case 0x25: return "Left";
      case 0x26: return "Up";
      case 0x27: return "Right";
      case 0x28: return "Down";
      case 0x2D: return "Insert";
      case 0x2E: return "Delete";
      default: return null;
    }
  }

  private static IntPtr HookCallback(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      int kind = message.ToInt32();
      string type = kind == WM_KEYDOWN || kind == WM_SYSKEYDOWN ? "down" :
        kind == WM_KEYUP || kind == WM_SYSKEYUP ? "up" : null;
      if (type != null) {
        KeyboardData keyboard = Marshal.PtrToStructure<KeyboardData>(data);
        string key = KeyName(keyboard.virtualKey);
        if (key != null) {
          Console.WriteLine(type + "\t" + key);
          Console.Out.Flush();
        }
      }
    }
    return CallNextHookEx(hook, code, message, data);
  }

  public static int Run() {
    Console.OutputEncoding = new UTF8Encoding(false);
    PinResponsiveness();
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, Callback, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) return 2;
    Console.WriteLine("ready");
    Console.Out.Flush();
    Message message;
    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {}
    UnhookWindowsHookEx(hook);
    return 0;
  }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
exit [LegalWorkKeyMonitor]::Run()
`;

export function resolveKeyMonitorPath(app) {
  if (app.isPackaged) return path.join(process.resourcesPath, "helpers", HELPER_NAME);
  const candidates = [
    path.resolve(__dirname, "../../resources/helpers", HELPER_NAME),
    path.resolve(__dirname, "../../native/key-monitor/.build/release", HELPER_NAME),
    path.resolve(__dirname, "../../native/key-monitor/.build/arm64-apple-macosx/release", HELPER_NAME),
    path.resolve(__dirname, "../../native/key-monitor/.build/x86_64-apple-macosx/release", HELPER_NAME),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export class SystemKeyMonitor {
  /**
   * @param {{
   *   app: import("electron").App,
   *   platform?: string,
   *   restartDelaysMs?: number[],
   *   restartResetUptimeMs?: number,
   *   spawn?: (command: string, args: string[], options: object) => any,
   *   resolveExecutable?: () => string | null,
   * }} options
   */
  constructor(options) {
    this.app = options.app;
    this.platform = options.platform ?? process.platform;
    this.restartDelaysMs = options.restartDelaysMs ?? RESTART_DELAYS_MS;
    this.restartResetUptimeMs = options.restartResetUptimeMs ?? RESTART_RESET_UPTIME_MS;
    // Injectable so the lifecycle can be unit-tested without a real helper.
    this.spawn = options.spawn ?? spawn;
    this.resolveExecutable = options.resolveExecutable ?? null;
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
    this.child = null;
    /** @type {((event: { type: "down" | "up"; key: string } | { type: "reset" } | { type: "unavailable"; error: string }) => void | Promise<void>) | null} */
    this.onEvent = null;
    this.desired = false;
    this.restartAttempt = 0;
    this.restartTimer = null;
    this.spawnedAt = 0;
    // Bumped on every teardown/spawn. Overlapping start()/restart()/stop()
    // calls (wake + unlock arriving together) each capture the generation
    // they own; a call whose generation was superseded must not write shared
    // state or resurrect a child the newer call already replaced.
    this.generation = 0;
  }

  isSupported() {
    if (this.platform === "darwin") return fs.existsSync(resolveKeyMonitorPath(this.app));
    return this.platform === "win32" || this.platform === "windows";
  }

  /**
   * @param {(event: { type: "down" | "up"; key: string } | { type: "reset" } | { type: "unavailable"; error: string }) => void | Promise<void>} onEvent
   */
  async start(onEvent) {
    const generation = this.teardown();
    this.onEvent = onEvent;
    this.desired = true;
    this.restartAttempt = 0;
    const available = await this.spawnHelper(generation);
    // Superseded by a later start()/restart()/stop() while spawning: leave
    // shared state to the newer call.
    if (this.generation !== generation) return available;
    if (!available) {
      this.desired = false;
      this.onEvent = null;
    }
    return available;
  }

  /**
   * Kill and re-spawn the helper with the existing listener. Used after
   * wake/unlock, where hooks and taps are the components that verifiably die.
   * Resolves with availability; emits a "reset" so chord state is rebuilt.
   */
  async restart() {
    if (!this.desired || !this.onEvent) return false;
    const onEvent = this.onEvent;
    const generation = this.killChild();
    this.restartAttempt = 0;
    const available = await this.spawnHelper(generation);
    // A concurrent restart (wake + unlock together) or a stop() superseded
    // us — the newer call owns the live child; do not flip desired/onEvent.
    if (this.generation !== generation) return available;
    if (available) void onEvent({ type: "reset" });
    else {
      this.desired = false;
      this.onEvent = null;
    }
    return available;
  }

  /**
   * @param {number} generation the lifecycle token this spawn belongs to;
   *   every write to shared state is gated on it still being current.
   */
  spawnHelper(generation) {
    let executable = "";
    let args = [];
    if (this.resolveExecutable) {
      executable = this.resolveExecutable() ?? "";
      if (!executable) return Promise.resolve(false);
    } else if (this.platform === "darwin") {
      executable = resolveKeyMonitorPath(this.app);
      if (!fs.existsSync(executable)) return Promise.resolve(false);
    } else if (this.platform === "win32" || this.platform === "windows") {
      executable = "powershell.exe";
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_MONITOR_SCRIPT];
    } else {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let settled = false;
      let ready = false;
      let stdout = "";
      let stderr = "";
      // Per-spawn watchdog: never shared, so a stale spawn's exit can never
      // clear a newer spawn's timer (which would strand its promise unsettled).
      let startTimer = null;
      const finish = (available) => {
        if (settled) return;
        settled = true;
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
        resolve(available);
      };

      // A newer lifecycle call already superseded this spawn before it began.
      if (this.generation !== generation) {
        finish(false);
        return;
      }

      let child;
      try {
        child = this.spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch {
        finish(false);
        return;
      }
      this.child = child;
      this.spawnedAt = Date.now();
      startTimer = setTimeout(() => {
        finish(false);
        // Kill only this hung child, and only if it is still ours.
        if (this.child === child) this.child = null;
        try {
          child.stdin.end();
          child.kill();
        } catch {
          // already gone
        }
      }, START_TIMEOUT_MS);
      startTimer.unref?.();

      const consumeLine = (line) => {
        const value = line.trim();
        if (!value) return;
        if (value === "ready") {
          ready = true;
          // A ready arriving after a newer start()/restart()/stop() already
          // replaced this child must resolve false — its helper is dead.
          finish(this.child === child);
          return;
        }
        // Ignore events from a child a newer call has already replaced.
        if (this.child !== child) return;
        const [type, key] = value.split("\t");
        if (type === "reset") {
          // The helper recreated its tap in-process (wake, session switch) —
          // any held-key bookkeeping upstream is stale now.
          void this.onEvent?.({ type: "reset" });
          return;
        }
        if ((type === "down" || type === "up") && key) void this.onEvent?.({ type, key });
      };
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", (error) => {
        const current = this.child === child;
        if (current) this.child = null;
        finish(false);
        if (ready && current && this.generation === generation) this.handleUnexpectedExit(error.message);
      });
      child.once("exit", (code) => {
        const current = this.child === child;
        if (current) this.child = null;
        finish(false);
        if (ready && current && this.generation === generation) {
          const detail = stderr.trim();
          this.handleUnexpectedExit(detail || `Keyboard monitor exited with code ${code ?? "unknown"}.`);
        }
      });
    });
  }

  handleUnexpectedExit(error) {
    if (!this.desired || !this.onEvent) return;
    // A helper that ran for a while earns fresh restart attempts; a
    // crash-loop right after spawn burns through them and degrades loudly.
    if (Date.now() - this.spawnedAt >= this.restartResetUptimeMs) this.restartAttempt = 0;
    const delay = this.restartDelaysMs[this.restartAttempt];
    if (delay === undefined) {
      this.desired = false;
      const onEvent = this.onEvent;
      this.onEvent = null;
      void onEvent?.({ type: "unavailable", error });
      return;
    }
    this.restartAttempt += 1;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desired || this.child) return;
      const generation = ++this.generation;
      void this.spawnHelper(generation).then((available) => {
        if (this.generation !== generation) return;
        if (available) void this.onEvent?.({ type: "reset" });
        // A failed spawn triggers 'exit'/'error' handlers only for processes
        // that launched; cover the spawn-throw path explicitly.
        else if (this.desired && !this.child) this.handleUnexpectedExit(error);
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  /**
   * Invalidate the current lifecycle and kill the running child. Returns the
   * new generation the caller should thread through its next spawn.
   */
  killChild() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // The helper already exited.
      }
    }
    return ++this.generation;
  }

  teardown() {
    return this.killChild();
  }

  stop() {
    this.desired = false;
    this.onEvent = null;
    this.killChild();
  }
}
