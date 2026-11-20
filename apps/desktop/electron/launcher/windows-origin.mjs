import { spawn } from "node:child_process";

/** An idle worker loads the Windows UI Automation libraries, then waits for a
 * single request. Closing its input without a request exits without sampling. */
export function prepareWindowsOrigin(executable) {
  const child = spawn(executable, ["--standby", String(process.pid)], {
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("close", code => code === 0 ? resolve(output) : reject(new Error("Windows selection helper exited.")));
  });
  // An idle worker may exit before a shortcut requests it.
  void finished.catch(() => {});
  return {
    async read(selection) {
      const timeout = setTimeout(() => child.kill(), 1600);
      try {
        child.stdin.end(selection ? "selection\n" : "frontmost\n");
        return await finished;
      } finally { clearTimeout(timeout); }
    },
    dispose() { child.kill(); },
  };
}
