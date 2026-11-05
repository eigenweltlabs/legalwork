// Isolated host for native stdin-lease crash tests, never a production entry.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createManagedOpencodeServer } from "./managed-opencode.js";

const root = process.argv[2], binary = process.argv[3], mode = process.argv[4], port = Number(process.argv[5]);
if (!root || !binary) throw new Error("A private fixture directory and engine binary are required.");
const home = join(root, "home"); await mkdir(home, { recursive: true });
const env = {
  HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
  XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
  OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: join(root, "config"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
  NODE_USE_SYSTEM_CA: "1",
};
if (mode === "before-ready") {
  // Direct native launch exposes its PID before a public authenticated API
  // exists; the managed path is exercised separately after readiness.
  const child = spawn(binary, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: home, env: { ...process.env, ...env, OPENCODE_PASSWORD: randomBytes(32).toString("hex") }, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.resume(); child.stderr?.resume();
  await writeFile(join(root, "spawned.json"), JSON.stringify({ pid: child.pid }), { mode: 0o600 });
  child.once("exit", code => process.exit(code ?? 0));
  process.once("SIGTERM", () => child.stdin?.end());
} else {
  const engine = await createManagedOpencodeServer({ bin: binary, cwd: home, timeoutMs: 30_000, parentLease: true, env });
  const keepAlive = setInterval(() => {}, 1000);
  process.once("SIGTERM", () => { void engine.close().then(() => { clearInterval(keepAlive); process.exit(0); }); });
  await writeFile(join(root, "ready.json"), JSON.stringify({ pid: engine.pid, url: engine.url, password: engine.password, args: engine.execution.args }), { mode: 0o600 });
}
