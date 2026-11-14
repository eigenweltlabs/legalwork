import { spawn } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onboarding = process.argv.includes("--onboarding");
const port = onboarding ? 5187 : 5186;
const profile = onboarding
  ? path.join(homedir(), ".legalwork", "onboarding-validation", new Date().toISOString().replace(/[:.]/g, "-"))
  : path.join(homedir(), ".legalwork", "regional-validation");
const probe = net.createServer();
await new Promise((resolve, reject) => {
  probe.once("error", () => reject(new Error(`Port ${port} is occupied. Close the previous regional dev instance first.`)));
  probe.listen(port, () => probe.close(resolve));
});
console.log(`Regional dev profile: ${profile}`);
console.log(onboarding
  ? "Create a development account and firm, then choose EU or US on the neutral coordinator. Stripe checkout uses test mode."
  : "Sign in with the Clerk development account and choose Infrastructure Validation EU or US.");
const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["dev:electron"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    LEGALWORK_DEV_MODE: "1",
    LEGALWORK_DEV_REGIONAL_ROUTING: "1",
    EIGENWELT_PLATFORM_URL: onboarding ? "http://127.0.0.1:3006" : "https://eu.platform.eigenweltlabs.com",
    LEGALWORK_ELECTRON_APP_NAME: onboarding ? "LegalWork Onboarding" : "LegalWork Regions",
    LEGALWORK_ELECTRON_APP_IDENTIFIER: onboarding ? "com.eigenweltlabs.legalwork.onboarding-dev" : "com.eigenweltlabs.legalwork.regional-dev",
    LEGALWORK_ELECTRON_USERDATA: path.join(profile, "electron"),
    LEGALWORK_DATA_DIR: path.join(profile, "data"),
    LEGALWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY: "1",
    LEGALWORK_WORD_ADDIN: "0",
    PORT: String(port),
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
