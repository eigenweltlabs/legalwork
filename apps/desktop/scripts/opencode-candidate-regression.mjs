import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { verifyOpencodeCandidate } from "@legalwork/opencode-release/candidate";

// Explicit acceptance entrypoint only. Normal desktop startup does not read
// candidate-validation environment variables or serialize a host capability.
const directory = process.env.LEGALWORK_TEST_CANDIDATE_DIRECTORY;
const provenanceSha256 = process.env.LEGALWORK_TEST_CANDIDATE_PROVENANCE_SHA256;
if (!directory || !provenanceSha256) throw new Error("An explicit candidate directory and independently reviewed provenance SHA256 are required.");
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "legalwork-electron-candidate-")));
for (const name of ["home", "documents", "userdata", "config", "data", "state", "cache", "private", "matter"]) mkdirSync(path.join(root, name));
for (const key of Object.keys(process.env)) {
  if (/^(?:OPENCODE_|LEGALWORK_|XDG_)/.test(key) || /(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|ACCESS_KEY)/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
  LEGALWORK_DEV_MODE: "1", LEGALWORK_CONFIG_PATH: path.join(root, "private", "server.json"),
  LEGALWORK_RUNTIME_DB: path.join(root, "private", "runtime.sqlite"), LEGALWORK_TOKEN_STORE: path.join(root, "private", "tokens.json"),
  LEGALWORK_STORAGE_STORE: path.join(root, "private", "storage.json"), LEGALWORK_ENV_STORE: path.join(root, "private", "env.json"),
  LEGALWORK_DATA_DIR: path.join(root, "private", "orchestrator"),
  OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: "", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
});
app.setPath("home", path.join(root, "home"));
app.setPath("documents", path.join(root, "documents"));
app.setPath("userData", path.join(root, "userdata"));
app.whenReady().then(async () => {
app.hide();
let runtime, failed = false;
const pids = new Set();
try {
  const candidate = await verifyOpencodeCandidate({ directory, provenanceSha256 });
  console.log("Candidate identity verified in the real Electron host.");
  const { createRuntimeManager } = await import("../electron/runtime.mjs");
  const { OpenCode } = await import("@opencode/client");
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workspace = path.join(root, "matter");
  // A serialized lookalike cannot cross the capability boundary, even frozen.
  const forged = createRuntimeManager({ app, desktopRoot, listLocalWorkspacePaths: () => [workspace], opencodeCandidateBuild: Object.freeze({ ...candidate }) });
  await assert.rejects(forged.engineStart(workspace, { opencodeBinPath: candidate.path }), /unknown or mutable candidate/);
  await forged.dispose();
  runtime = createRuntimeManager({ app, desktopRoot, listLocalWorkspacePaths: () => [workspace], opencodeCandidateBuild: candidate });
  for (let cycle = 0; cycle < 2; cycle++) {
    const engine = await runtime.engineStart(workspace, { opencodeBinPath: candidate.path });
    assert.equal(engine.running, true);
    const server = await runtime.legalworkServerInfo();
    assert.equal(server.running, true);
    assert.equal(server.managedOpencodeBinPath, candidate.path);
    const headers = { authorization: `Bearer ${server.ownerToken ?? server.clientToken}` };
    const client = OpenCode.make({ baseUrl: `${server.baseUrl}/opencode`, headers });
    const info = await client.server.info();
    assert.equal(info.version, candidate.version);
    assert.equal(info.pid, engine.pid);
    assert.equal(pids.has(info.pid), false);
    pids.add(info.pid);
    assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);
    const workspaces = await (await fetch(`${server.baseUrl}/workspaces`, { headers })).json();
    const selected = workspaces.items.find(item => item.path === workspace);
    assert.ok(selected);
    const projectUrl = `${server.baseUrl}/workspace/${selected.id}/engine-project`;
    const status = await (await fetch(projectUrl, { headers })).json();
    assert.equal(status.state, "ready");
    assert.equal(status.required, false);
    const location = { directory: workspace };
    await client.model.list({ location });
    const plugins = (await client.plugin.list({ location })).data;
    assert.deepEqual(plugins.filter(plugin => plugin.state.status === "failed"), []);
    for (const id of ["legalwork.project-admission", "legalwork.product-scope", "legalwork.commands", "legalwork.legalmemory-access"]) {
      assert.equal(plugins.find(plugin => plugin.id === id)?.state.status, "active", id);
    }
    const repeated = await runtime.engineStart(workspace, { opencodeBinPath: candidate.path });
    assert.equal(repeated.pid, info.pid);
    if (cycle === 0) {
      const restarted = await runtime.engineRestart();
      assert.equal(restarted.running, true);
      assert.notEqual(restarted.pid, info.pid);
      assert.equal(pids.has(restarted.pid), false);
      pids.add(restarted.pid);
      assert.throws(() => process.kill(info.pid, 0), /ESRCH/);
      const nextServer = await runtime.legalworkServerInfo();
      assert.equal(nextServer.remoteAccessEnabled, server.remoteAccessEnabled);
      assert.equal(nextServer.managedOpencodeBinPath, candidate.path);
      const nextInfo = await OpenCode.make({ baseUrl: `${nextServer.baseUrl}/opencode`, headers: {
        authorization: `Bearer ${nextServer.ownerToken ?? nextServer.clientToken}`,
      } }).server.info();
      assert.equal(nextInfo.pid, restarted.pid);
      assert.equal(nextInfo.version, candidate.version);
    }
    await runtime.engineStop();
    assert.throws(() => process.kill(info.pid, 0), /ESRCH/);
    assert.equal((await runtime.engineInfo()).running, false);
  }
  console.log("PASS: real Electron host capability reaches compiled embedded server through the same module; exact native identity, automatic project readiness, native plugin ABI, stop/restart and child reaping verified (zero model calls).");
} catch (error) {
  failed = true; console.error(error);
} finally {
  await runtime?.dispose();
  for (const pid of pids) {
    try { process.kill(pid, 0); failed = true; console.error(`Owned candidate process ${pid} remained after runtime disposal.`); }
    catch (error) { if (error.code !== "ESRCH") { failed = true; console.error(error); } }
  }
  await rm(root, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}
}).catch(error => { console.error(error); app.exit(1); });
