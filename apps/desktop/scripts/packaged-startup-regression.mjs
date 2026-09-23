// Launch the real packaged main process with an isolated profile. This catches
// bad ASAR integrity metadata, missing native modules, and startup regressions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

const target = process.argv[2];
if (!target) throw new Error("Usage: node packaged-startup-regression.mjs <packaged executable>");
const root = await mkdtemp(path.join(tmpdir(), "legalwork-packaged-startup-"));
const userData = path.join(root, "userdata");
const runtime = path.join(root, "runtime");
await mkdir(userData);
await mkdir(runtime);
await mkdir(path.join(root, "workspace"));
const discoveryPath = path.join(userData, "legalwork-ui-control.json");
await writeFile(discoveryPath, JSON.stringify({ token: "legacy-test-token" }));
await chmod(discoveryPath, 0o644);
let output = "";
let launchError;
const child = spawn(path.resolve(target), process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [], {
  env: {
    ...process.env,
    NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "",
    LEGALWORK_ELECTRON_USERDATA: userData,
    LEGALWORK_ELECTRON_APP_NAME: "LegalWork Package Test",
    LEGALWORK_ELECTRON_APP_IDENTIFIER: "com.eigenweltlabs.legalwork.package-test",
    LEGALWORK_DATA_DIR: runtime,
    LEGALWORK_SERVER_CONFIG: path.join(runtime, "server.json"),
    LEGALWORK_RUNTIME_DB: path.join(runtime, "runtime.db"),
    OPENCODE_DB: path.join(runtime, "opencode.db"),
    LEGALWORK_WORKSPACES: path.join(root, "workspace"),
    LEGALWORK_WORD_ADDIN: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.on("error", (error) => { launchError = error; });
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged app exited early: ${child.exitCode ?? child.signalCode}`);
    try {
      const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
      if (discovery.baseUrl && discovery.token !== "legacy-test-token") {
        const actions = await fetch(`${discovery.baseUrl}/actions`, {
          headers: { authorization: `Bearer ${discovery.token}` }, signal: AbortSignal.timeout(5000),
        });
        const result = await actions.json();
        if (actions.ok && result.ok && Array.isArray(result.actions)) { ready = true; break; }
      }
    } catch { /* Main process has not published its health endpoint yet. */ }
    await setTimeout(500);
  }
  assert.ok(ready, "Packaged renderer did not register its app controls");
  await setTimeout(3000);
  assert.equal(child.exitCode, null, "Packaged app must remain running");
  assert.equal(child.signalCode, null);
  if (process.platform !== "win32") assert.equal((await stat(discoveryPath)).mode & 0o777, 0o600);
  console.log("PASS: packaged app and renderer start and replace the legacy token file");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), setTimeout(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
