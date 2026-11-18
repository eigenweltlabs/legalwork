import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";

// AppKit can abort before the Electron main module runs when this process
// cannot reach the WindowServer. Query CoreGraphics without opening a window.
if (process.platform === "darwin") {
  const displayProbe = `
    ObjC.import("CoreGraphics");
    const display = Ref(), count = Ref();
    const status = $.CGGetActiveDisplayList(1, display, count);
    status === 0 && count[0] === 0;
  `;
  const probe = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", displayProbe], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() === "true") {
    console.error("HUD test requires a macOS graphical session. No display is accessible to this process. Run from a Terminal in the logged-in desktop or on a macOS GUI runner.");
    process.exit(1);
  }
}

const fixture = fileURLToPath(new URL("./dictation-hud-regression.mjs", import.meta.url));
const result = spawnSync(electron, [fixture, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) console.error(`Electron exited with ${result.signal}`);
process.exitCode = result.status ?? 1;
