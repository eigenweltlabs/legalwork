import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const root = fileURLToPath(new URL("../", import.meta.url));
// Supervised browser previews pass --host/--port. Keep the normal command
// launching Electron, and serve the actual UI from the monorepo for web QA.
const webPreview = args.some((arg) => arg === "--host" || arg.startsWith("--host="));
const child = spawn(
  webPreview ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  webPreview
    ? [fileURLToPath(new URL("../apps/app/node_modules/vite/bin/vite.js", import.meta.url)), ...args]
    : ["--filter", "@legalwork/desktop", "dev", ...args],
  {
    cwd: webPreview ? fileURLToPath(new URL("../apps/app/", import.meta.url)) : root,
    stdio: "inherit",
    env: {
      ...process.env,
      LEGALWORK_DEV_MODE: "1",
      ...(webPreview ? { LEGALWORK_VISUAL_PREVIEW: "1" } : {}),
      LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT: process.env.LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT || "9823",
    },
  },
);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
