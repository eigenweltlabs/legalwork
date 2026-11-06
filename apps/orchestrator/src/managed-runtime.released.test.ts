import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { expectedOpencodeServiceFilename, expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";

const serverBinary = process.env.LEGALWORK_TEST_SERVER_BIN;
const engineBinary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const orchestratorScript = process.env.LEGALWORK_TEST_ORCHESTRATOR_JS;
const orchestratorEntry = orchestratorScript ? resolve(orchestratorScript) : resolve(import.meta.dir, "cli.ts");
const orchestratorRuntime = orchestratorScript ? "node" : process.execPath;

for (const stopDuringStartup of [false, true]) test.skipIf(!serverBinary || !engineBinary)(stopDuringStartup
  ? "standalone cancellation during startup reaps its managed engine and independently deployed server"
  : "standalone orchestrator delegates its engine to the independently deployed server and stops only its private owner", async () => {
  if (!serverBinary || !engineBinary) throw new Error("Explicit released engine and compiled server binaries are required");
  const expectedEngineVersion = await expectedOpencodeVersion(resolve(engineBinary));
  const root = await realpath(await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/managed-orchestrator-")));
  const directory = join(root, "matter"), server = join(root, "bin", "legalwork-server"), data = join(root, "orchestrator");
  await Promise.all([directory, join(root, "bin"), ...["home", "config", "data", "cache", "state", "shared"].map(name => join(root, name))].map(path => mkdir(path, { recursive: true })));
  await copyFile(resolve(serverBinary), server); await chmod(server, 0o755);
  const authoredPlugin = join(directory, "authored-plugin"), marker = join(root, "project-activated");
  await mkdir(authoredPlugin);
  await writeFile(join(authoredPlugin, "index.js"), `import{writeFileSync}from'node:fs';import{Plugin}from'@opencode/plugin';export default Plugin.define({id:'fixture.readiness',setup(){writeFileSync(${JSON.stringify(marker)},'approved')}});`);
  await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ plugins: [authoredPlugin] }));
  const catalog = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  let output = "";
  const token = "orchestrator-fixture-client", hostToken = "orchestrator-fixture-host";
  const child = Bun.spawn([orchestratorRuntime, orchestratorEntry, "serve", "--workspace", directory, "--data-dir", data,
    "--no-tui", "--json", "--allow-external", "--sidecar-source", "external", "--opencode-source", "external",
    "--legalwork-server-bin", server, "--opencode-bin", resolve(engineBinary), "--approval", "auto", "--legalwork-token", token, "--legalwork-host-token", hostToken], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env,
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      LEGALWORK_SERVER_CONFIG: join(root, "shared", "server.json"), LEGALWORK_RUNTIME_DB: join(root, "shared", "runtime.sqlite"), LEGALWORK_TOKEN_STORE: join(root, "shared", "tokens.json"), LEGALWORK_STORAGE_STORE: join(root, "shared", "storage.json"),
      LEGALWORK_DEV_MODE: "0", OPENCODE_DB: "", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_MODELS_URL: `http://127.0.0.1:${catalog.port}`,
      LEGALWORK_ENGINE_STORAGE_DIR: "", LEGALWORK_ENGINE_PLUGIN_DIRECTORIES: "", LEGALWORK_OPENCODE_BASE_URL: "", LEGALWORK_OPENCODE_SDK_DIR: "",
    },
  });
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try {
      while (true) { const next = await reader.read(); if (next.done) return; output += new TextDecoder().decode(next.value); }
    } finally { reader.releaseLock(); }
  };
  const readers = Promise.all([capture(child.stdout), capture(child.stderr)]);
  let nativePID: number | undefined;
  try {
    const deadline = Date.now() + 30_000;
    let baseURL = "";
    while (!baseURL) {
      baseURL = /LegalWork server listening on (http:\/\/[^\s"\\]+)/.exec(output)?.[1] ?? "";
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("Orchestrator did not become ready: " + output);
      if (!baseURL) await Bun.sleep(20);
    }
    const headers = { authorization: `Bearer ${token}` };
    const client = OpenCode.make({ baseUrl: `${baseURL}/opencode`, headers });
    const info = await client.server.info(); nativePID = info.pid;
    expect(info.version).toBe(expectedEngineVersion); expect(info.pid).not.toBe(child.pid);
    const health = await (await fetch(`${baseURL}/health`)).json();
    expect(health.engine.status).toBe("ready");
    if (stopDuringStartup) return;
    while (!output.includes('"authentication": "legalwork-bearer"')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("Orchestrator did not publish complete native engine readiness: " + output);
      await Bun.sleep(20);
    }
    const response = await fetch(`${baseURL}/workspaces`, { headers });
    const workspaces: unknown = await response.json();
    if (!workspaces || typeof workspaces !== "object" || !("items" in workspaces) || !Array.isArray(workspaces.items)) throw new Error("Missing workspace metadata");
    const workspace = workspaces.items.find((value: unknown) => value && typeof value === "object" && "path" in value && value.path === directory);
    if (!workspace || typeof workspace !== "object" || !("id" in workspace) || typeof workspace.id !== "string") throw new Error("Missing managed matter");
    const projectURL = `${baseURL}/workspace/${workspace.id}/engine-project`;
    const status = await (await fetch(projectURL, { headers })).json();
    expect(status.state).toBe("ready");
    expect(status.required).toBe(false);
    for (const proxy of [`${baseURL}/opencode`, `${baseURL}/w/${workspace.id}/opencode`]) {
      const statusChild = Bun.spawn([orchestratorRuntime, orchestratorEntry, "status", "--json", "--opencode-url", proxy, "--legalwork-token", token], { stdout: "pipe", stderr: "pipe" });
      const [text, errors, code] = await Promise.all([new Response(statusChild.stdout).text(), new Response(statusChild.stderr).text(), statusChild.exited]);
      expect(code, errors).toBe(0);
      expect(JSON.parse(text)).toMatchObject({ opencode: { ok: true, url: proxy, health: { healthy: true, version: expectedEngineVersion, pid: info.pid, status: "ready" } } });
      expect(text).not.toContain(token); expect(text).not.toContain(hostToken);
    }
    const location = { directory }; await client.model.list({ location });
    const plugins = (await client.plugin.list({ location })).data;
    expect(existsSync(marker)).toBe(true);
    for (const id of ["legalwork.project-admission", "legalwork.product-scope", "legalwork.commands"]) {
      expect(plugins.find(plugin => plugin.id === id)?.state.status, id).toBe("active");
    }
    expect(plugins.some(plugin => plugin.id?.startsWith("legalwork.messaging."))).toBe(false);
    const session = await client.session.create({ location, title: "No inference standalone proof", permissions: [{ action: "fixture_permission", resource: "*", effect: "ask" }] });
    expect((await client.session.get({ sessionID: session.id })).location.directory).toBe(directory);
    const permission = await client.permission.create({ sessionID: session.id, action: "fixture_permission", resources: ["fixture"] });
    expect(permission.effect).toBe("ask");
    const retiredClient = OpenCode.make({ baseUrl: `${baseURL}/opencode`, headers: { authorization: "Bearer owt_retired_viewer" } });
    await expect(retiredClient.permission.reply({ sessionID: session.id, requestID: permission.id, decision: "once" })).rejects.toThrow();
    await client.permission.reply({ sessionID: session.id, requestID: permission.id, decision: "once" });
    expect((await client.permission.list({ sessionID: session.id })).length).toBe(0);
    expect((await client.shell.create({ location, command: "true" })).data.id.length).toBeGreaterThan(0);
    const storage = join(data, "opencode-config", "managed-engine-v2");
    expect((await readFile(join(storage, "org-policy-engine", await expectedOpencodeServiceFilename(resolve(engineBinary))), "utf8")).length).toBeGreaterThan(0);
    expect((await readFile(join(storage, "runtime-opencode-config.json"), "utf8")).length).toBeGreaterThan(0);
    expect(output).not.toContain('"username"'); expect(output).not.toContain('"password"');
  } catch (cause) {
    throw new Error("Standalone managed runtime fixture failed: " + output, { cause });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(12_000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await readers; await catalog.stop(true);
    const pid = nativePID;
    if (pid) expect(() => process.kill(pid, 0), output).toThrow();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
