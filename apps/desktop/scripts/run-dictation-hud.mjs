import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixture = fileURLToPath(new URL("./dictation-hud-regression.mjs", import.meta.url));

export function runHud(electron, args, platform = process.platform, spawn = spawnSync) {
  // AppKit can abort before the Electron main module runs. Only start it after
  // CoreGraphics confirms that this process can reach an active display.
  if (platform === "darwin") {
    const displayProbe = `
      ObjC.import("CoreGraphics");
      const display = Ref(), count = Ref();
      const status = $.CGGetActiveDisplayList(1, display, count);
      status === 0 && count[0] > 0;
    `;
    const probe = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", displayProbe], { encoding: "utf8" });
    if (probe.status !== 0 || probe.stdout.trim() !== "true") {
      console.error("HUD test requires a macOS graphical session. Could not confirm an accessible display. Run from a Terminal in the logged-in desktop or on a macOS GUI runner.");
      return 1;
    }
  }

  const result = spawn(electron, [fixture, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) console.error(`Electron exited with ${result.signal}`);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: electron } = await import("electron");
  process.exitCode = runHud(electron, process.argv.slice(2));
}
