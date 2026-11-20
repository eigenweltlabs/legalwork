// A one-shot foreground snapshot requested by the Assistant shortcut.
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

class LauncherOrigin {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);

    static string ReadSelection(IntPtr hwnd) {
        var root = AutomationElement.FromHandle(hwnd);
        var element = AutomationElement.FocusedElement;
        var walker = TreeWalker.RawViewWalker;
        var ancestry = new List<AutomationElement>();
        // Chromium may put accessibility elements in a renderer process. Validate
        // the element's window ancestry instead of comparing its PID to Chrome's.
        for (int depth = 0; element != null && depth < 64; depth++) {
            if (element.Current.IsPassword) return null;
            ancestry.Add(element);
            if (Automation.Compare(root, element)) break;
            element = walker.GetParent(element);
        }
        if (element == null || !Automation.Compare(root, element) || GetForegroundWindow() != hwnd) return null;
        foreach (var ancestor in ancestry) {
            object pattern;
            if (ancestor.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
                var result = new StringBuilder();
                foreach (var range in ((TextPattern)pattern).GetSelection()) {
                    var part = range.GetText(200001 - result.Length);
                    result.Append(part);
                    if (result.Length > 200000) return null;
                }
                if (result.Length > 0) return result.ToString();
            }
        }
        return null;
    }

    [MTAThread]
    static void Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        var serializer = new JavaScriptSerializer();
        if (args.Length == 2 && args[0] == "--standby") {
            // Pay framework startup costs before the shortcut. No external
            // window or text is inspected until the parent sends a request.
            GC.KeepAlive(TextPattern.Pattern);
            serializer.Serialize(new { ok = true });
            var request = Console.ReadLine();
            if (request != "selection" && request != "frontmost") return;
            args = request == "selection" ? new string[] { "--selection", args[1] } : new string[0];
        }
        var hwnd = GetForegroundWindow();
        int pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) { Console.WriteLine("{\"ok\":false}"); return; }
        var title = new StringBuilder(512);
        GetWindowText(hwnd, title, title.Capacity);
        string name = "", executable = "", selection = null;
        try { using (var process = Process.GetProcessById(pid)) { name = process.ProcessName; executable = process.MainModule.FileName; } }
        catch (System.ComponentModel.Win32Exception) { }
        if (args.Length == 2 && args[0] == "--selection" && args[1] != pid.ToString() && GetForegroundWindow() == hwnd) {
            try { selection = ReadSelection(hwnd); } catch (Exception) { /* Inaccessible or closed application. */ }
        }
        if (GetForegroundWindow() != hwnd) { Console.WriteLine("{\"ok\":false}"); return; }
        Console.WriteLine(serializer.Serialize(new { ok = true, pid, app = name, bundleId = executable, window = title.ToString(), accessibility = true, selection }));
    }
}
