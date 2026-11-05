// Launch the real packaged main process with an isolated profile. This catches
// bad ASAR integrity metadata, missing native modules, and startup regressions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { assertPackagedServerImports } from "./check-packaged-server-imports.mjs";
import { assertPackagedOpencodeSdk } from "./packaged-opencode-sdk.cjs";
import { createWorkspaceStore } from "../electron/workspace-store.mjs";
import { opencodeEngineSelection } from "@legalwork/opencode-release/selection";
import { Service } from "@opencode/client/service";
import { collectStartupFailure, snapshotStartupLogs } from "./packaged-startup-diagnostics.mjs";

const target = process.argv[2];
if (!target) throw new Error("Usage: node packaged-startup-regression.mjs <packaged executable>");
const resources = path.resolve(path.dirname(target), process.platform === "darwin" ? "../Resources" : "resources");
assertPackagedServerImports(path.join(resources, "app.asar"));
assertPackagedOpencodeSdk(resources);
const root = await mkdtemp(path.join(tmpdir(), "legalwork-packaged-startup-"));
const userData = path.join(root, "userdata");
const runtime = path.join(root, "runtime");
await mkdir(userData);
await mkdir(runtime);
const workspace = path.join(root, "workspace");
await mkdir(workspace);
for (const name of ["home", "config", "data", "state", "cache", "appdata", "localappdata"]) await mkdir(path.join(root, name));
// Windows verifies that the isolated profile's Documents known folder exists.
if (process.platform === "win32") await mkdir(path.join(root, "home", "Documents"));
const workspaceStore = createWorkspaceStore({ app: { getPath: () => userData } });
await workspaceStore.writeWorkspaceState({ selectedId: "package-test", activeId: "package-test", watchedId: "package-test",
  workspaces: [{ id: "package-test", path: workspace, name: "Package test", workspaceType: "local", preset: "starter" }] });
const discoveryPath = path.join(userData, "legalwork-ui-control.json");
await writeFile(discoveryPath, JSON.stringify({ token: "legacy-test-token" }));
await chmod(discoveryPath, 0o644);
let output = "";
let launchError;
let passed = false;
const logDirectories = [path.join(userData, "logs"),
  path.join(root, "home", "Library", "Logs", "LegalWork Package Test"),
  path.join(homedir(), "Library", "Logs", "LegalWork Package Test"),
  ...(process.platform === "win32" ? [root] : [])];
const logBaseline = await snapshotStartupLogs(logDirectories);
const startedAt = Date.now();
const milestones = [{ event: "launch-requested", elapsedMs: 0 }];
const args = process.platform === "win32" ? ["--enable-logging=file", `--log-file=${path.join(root, "chromium-startup.log")}`]
  : process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
const child = spawn(path.resolve(target), args, {
  env: {
    ...process.env,
    NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "",
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
    LEGALWORK_DESKTOP_BOOTSTRAP_PATH: path.join(runtime, "desktop-bootstrap.json"),
    LEGALWORK_ELECTRON_USERDATA: userData,
    LEGALWORK_ELECTRON_APP_NAME: "LegalWork Package Test",
    LEGALWORK_ELECTRON_APP_IDENTIFIER: "com.eigenweltlabs.legalwork.package-test",
    LEGALWORK_DATA_DIR: runtime,
    LEGALWORK_SERVER_CONFIG: path.join(runtime, "server.json"),
    LEGALWORK_RUNTIME_DB: path.join(runtime, "runtime.db"),
    LEGALWORK_ENGINE_STORAGE_DIR: runtime,
    OPENCODE_DB: path.join(runtime, "opencode.db"),
    LEGALWORK_WORKSPACES: workspace,
    LEGALWORK_WORD_ADDIN: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.on("error", (error) => { launchError = error; });
child.on("spawn", () => milestones.push({ event: "process-spawned", elapsedMs: Date.now() - startedAt }));
child.on("exit", (code, signal) => milestones.push({ event: "process-exited", elapsedMs: Date.now() - startedAt, code, signal }));
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
        if (actions.ok && result.ok && Array.isArray(result.actions)) {
          milestones.push({ event: "renderer-controls-ready", elapsedMs: Date.now() - startedAt });
          ready = true; break;
        }
      }
    } catch { /* Main process has not published its health endpoint yet. */ }
    await setTimeout(500);
  }
  assert.ok(ready, "Packaged renderer did not register its app controls");
  let engineReady = false, lastEngineError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Packaged app exited before engine readiness");
    try {
      const key = path.resolve(workspace).replace(/\\/g, "/").toLowerCase();
      const state = JSON.parse(await readFile(path.join(userData, "legalwork-server-state.json"), "utf8"));
      if (!milestones.some(item => item.event === "server-state-observed"))
        milestones.push({ event: "server-state-observed", elapsedMs: Date.now() - startedAt });
      const tokens = JSON.parse(await readFile(path.join(userData, "legalwork-server-tokens.json"), "utf8"));
      const base = `http://127.0.0.1:${state.workspacePorts[key]}`;
      const headers = { authorization: `Bearer ${tokens.workspaces[key].clientToken}` };
      const get = async (route) => {
        const response = await fetch(base + route, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200, `Packaged engine route failed: ${route}`);
        return response.json();
      };
      const list = await get("/workspaces");
      const matches = list.items.filter((item) => path.resolve(item.path) === path.resolve(workspace));
      assert.equal(matches.length, 1, "Exact packaged workspace is required");
      const selected = matches[0];
      assert.equal(selected.opencodeUsername, undefined); assert.equal(selected.opencodePassword, undefined);
      assert.equal(selected.opencode?.username, undefined); assert.equal(selected.opencode?.password, undefined);
      const native = `/workspace/${selected.id}/opencode`;
      const info = await get(`${native}/api/info`);
      assert.equal(info.version, opencodeEngineSelection.version, "Actual packaged engine must match its build-owned selection");
      engineReady = true;
      milestones.push({ event: "actual-engine-ready", elapsedMs: Date.now() - startedAt });
      break;
    } catch (error) { lastEngineError = error; }
    await setTimeout(500);
  }
  assert.ok(engineReady, `The real packaged engine did not become ready: ${lastEngineError?.message}`);
  await setTimeout(3000);
  assert.equal(child.exitCode, null, "Packaged app must remain running");
  assert.equal(child.signalCode, null);
  if (process.platform !== "win32") assert.equal((await stat(discoveryPath)).mode & 0o777, 0o600);
  console.log(`PASS: packaged app, renderer and actual ${opencodeEngineSelection.version} engine start; workspace metadata contains no engine credentials`);
  passed = true;
} catch (error) {
  try {
    const evidence = await collectStartupFailure({
      artifactDirectory: path.resolve(import.meta.dirname, "../.test-artifacts/packaged-startup"),
      root, userData, runtime, child, output, milestones, startedAt, logBaseline, logDirectories, failure: error,
      selection: { kind: opencodeEngineSelection.kind, version: opencodeEngineSelection.version,
        artifactId: opencodeEngineSelection.artifactId,
        manifestSha256: opencodeEngineSelection.kind === "derivative" ? opencodeEngineSelection.artifactId : null },
    });
    console.error(evidence.consoleOutput);
    console.error(`Scrubbed startup failure diagnostics: ${evidence.directory}`);
  } catch {
    console.error("Startup diagnostics could not be retained; original startup assertion follows.");
  }
  throw error;
} finally {
  try {
    const waitForChild = () => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([waitForChild(), setTimeout(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([waitForChild(), setTimeout(5000)]);
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, "Test desktop must stop before deleting its profile");
    // A service can outlive its desktop. Inspect only this test's private
    // registrations after stopping the child; never discover a global engine.
    const registrations = [];
    for (const name of ["service.json", "service-legalwork.json"]) {
      const file = path.join(runtime, "engine-home", "state", "opencode", name);
      let text;
      try { text = await readFile(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const info = JSON.parse(text), url = new URL(info.url);
      assert.ok(Number.isSafeInteger(info.pid) && info.pid > 0);
      assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
      registrations.push({ file, text, pid: info.pid });
    }
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    for (const { file, text, pid } of registrations) {
      if (!alive(pid)) continue;
      assert.equal(await readFile(file, "utf8"), text, "Private service registration changed during cleanup");
      assert.ok(await Service.discover({ file, version: opencodeEngineSelection.version }), "Refuse to stop an unverified service");
      await Service.stop({ file, pty: "clear" });
      assert.equal(alive(pid), false, "Test's verified engine must stop before deleting its profile");
    }
    if (passed) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    else console.error(`Preserved failed startup profile: ${root}`);
  } catch (error) {
    console.error(`Preserved startup profile for cleanup inspection: ${root}`);
    throw error;
  }
}
