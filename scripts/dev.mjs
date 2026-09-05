import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Preview supervisors pass a host/port. Run the web client in that case;
// ordinary `pnpm dev` continues to launch the Electron desktop app.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const webPreview = args.includes("--host");
const child = webPreview
  ? spawn(process.execPath, [fileURLToPath(new URL("../apps/app/node_modules/vite/bin/vite.js", import.meta.url)), ...args], {
      cwd: fileURLToPath(new URL("../apps/app", import.meta.url)),
      env: process.env,
      stdio: "inherit",
    })
  : spawn("pnpm", ["--filter", "@legalwork/desktop", "dev", ...args], { stdio: "inherit" });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
