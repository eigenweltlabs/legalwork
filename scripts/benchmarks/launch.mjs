import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { privateWrite, readJson } from "./evidence.mjs";

const index = process.argv.indexOf("--root");
if (index < 0 || !process.argv[index + 1]) throw new Error("--root is required");
const root = resolve(process.argv[index + 1]);
const harnessRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoIndex = process.argv.indexOf("--repo");
const repo = repoIndex < 0 ? harnessRoot : resolve(process.argv[repoIndex + 1]);
const desktop = join(repo, "apps/desktop");
const configured = await readJson(join(root, "launch-env.json"));
const require = createRequire(join(desktop, "package.json"));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
if (!process.argv.includes("--prepared")) {
  const preparation = [[process.execPath, [join(desktop, "scripts/prepare-actaport-mcp.mjs")], repo], [process.execPath, [join(desktop, "scripts/prepare-sidecar.mjs")], repo], [pnpm, ["exec", "electron-builder", "install-app-deps"], desktop], [pnpm, ["--filter", "legalwork-server", "build"], repo]];
  for (const [command, args, cwd] of preparation) execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && command.endsWith(".cmd") });
}
execFileSync(process.execPath, [join(desktop, "scripts/prepare-opencode-sdk.mjs")], { cwd: repo, stdio: "inherit" });
await mkdir(join(root, "fixture-home"), { recursive: true, mode: 0o700 });
await mkdir(join(root, "fixture-documents"), { recursive: true, mode: 0o700 });
await privateWrite(join(root, "empty-env.json"), { schemaVersion: 1, variables: [] });
// Shell credentials and host personal configuration are excluded. Runtime dev
// isolation still applies normally inside the unmodified LegalWork main process.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|ACCESS_KEY|AUTH_TOKEN|SECRET|CREDENTIAL|OPENCODE_|LEGALWORK_|^(?:AWS|AZURE|OPENAI|ANTHROPIC|GOOGLE|GEMINI|GROQ|OPENROUTER|LITELLM|VERTEX)_)/i.test(key)));
const environment = { ...inherited, ...configured, LEGALWORK_BENCH_ROOT: root, LEGALWORK_BENCH_REPO: repo, LEGALWORK_ENV_STORE: join(root, "empty-env.json") };
// pnpm creates a Vite descendant. Give each owned subtree its own process group
// so stopping this isolated launcher cannot leave that listener behind.
const ownProcessGroup = process.platform !== "win32";
const ui = spawn(pnpm, ["--filter", "@legalwork/app", "dev", "--host", "127.0.0.1"], { cwd: repo, env: environment, stdio: "inherit", shell: process.platform === "win32", detached: ownProcessGroup });
let electron;
let stopping = false;
function stopChild(child, signal) {
  if (!child?.pid) return;
  try {
    if (ownProcessGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== "ESRCH") throw error; }
}
function stop(signal = "SIGINT") { if (stopping) return; stopping = true; stopChild(electron, signal); stopChild(ui, signal); }
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
const readyTimeoutMs = Number(process.env.LEGALWORK_BENCH_UI_READY_TIMEOUT_MS ?? "60000");
if (!(readyTimeoutMs > 0)) throw new Error("LEGALWORK_BENCH_UI_READY_TIMEOUT_MS must be positive");
const url = `http://127.0.0.1:${configured.PORT}`;
const started = performance.now();
try {
  while (true) {
    try { if ((await fetch(`${url}/@vite/client`)).ok) break; } catch { /* Startup, not an inference retry. */ }
    if (ui.exitCode !== null || performance.now() - started >= readyTimeoutMs) throw new Error("Benchmark Vite renderer did not become ready before the explicit UI startup watchdog");
    await delay(100);
  }
  await privateWrite(join(root, "launch-record.json"), { timestamp: new Date().toISOString(), kind: "unmodified-legalwork-electron-with-isolated-discovery-home", readyTimeoutMs, readinessPollMs: 100, preparedExternally: process.argv.includes("--prepared"), sourceRoot: repo, appHome: join(root, "fixture-home"), appDocuments: join(root, "fixture-documents"), envStore: join(root, "empty-env.json"), transport: "local-opencode-http-server", note: "Startup watchdog only; no agent task deadline, retry injection or tool output cap." });
  electron = spawn(require("electron"), [join(harnessRoot, "scripts/benchmarks/electron-entry.mjs")], { cwd: desktop, env: { ...environment, LEGALWORK_ELECTRON_START_URL: url }, stdio: "inherit", detached: ownProcessGroup });
  electron.on("exit", (code, signal) => { stop(); process.exitCode = code ?? (signal ? 1 : 0); });
  ui.on("exit", code => { if (!stopping) { stop(); process.exitCode = code ?? 1; } });
} catch (error) { stop(); throw error; }
