import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_NAME = "LegalWorkKeyMonitor";
const START_TIMEOUT_MS = 5_000;

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
  /** @param {{ app: import("electron").App, platform?: string }} options */
  constructor(options) {
    this.app = options.app;
    this.platform = options.platform ?? process.platform;
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
    this.child = null;
    this.startTimer = null;
  }

  isSupported() {
    if (this.platform === "darwin") return fs.existsSync(resolveKeyMonitorPath(this.app));
    return this.platform === "win32" || this.platform === "windows";
  }

  /**
   * @param {(event: { type: "down" | "up"; key: string } | { type: "unavailable"; error: string }) => void | Promise<void>} onEvent
   */
  start(onEvent) {
    this.stop();
    let executable = "";
    let args = [];
    if (this.platform === "darwin") {
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
      const finish = (available) => {
        if (settled) return;
        settled = true;
        clearTimeout(this.startTimer);
        this.startTimer = null;
        resolve(available);
      };

      let child;
      try {
        child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch {
        finish(false);
        return;
      }
      this.child = child;
      this.startTimer = setTimeout(() => {
        finish(false);
        this.stop();
      }, START_TIMEOUT_MS);

      const consumeLine = (line) => {
        const value = line.trim();
        if (!value) return;
        if (value === "ready") {
          ready = true;
          finish(true);
          return;
        }
        const [type, key] = value.split("\t");
        if ((type === "down" || type === "up") && key) void onEvent({ type, key });
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
        if (ready && current) void onEvent({ type: "unavailable", error: error.message });
      });
      child.once("exit", (code) => {
        const current = this.child === child;
        if (current) this.child = null;
        finish(false);
        if (ready && current) {
          const detail = stderr.trim();
          void onEvent({
            type: "unavailable",
            error: detail || `Keyboard monitor exited with code ${code ?? "unknown"}.`,
          });
        }
      });
    });
  }

  stop() {
    clearTimeout(this.startTimer);
    this.startTimer = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // The helper already exited.
    }
  }
}
