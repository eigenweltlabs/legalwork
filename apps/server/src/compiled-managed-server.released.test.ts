import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { EngineProjectStatusSchema } from "@legalwork/types/engine-project";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";

const serverBinary = process.env.LEGALWORK_TEST_SERVER_BIN;
const engineBinary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!serverBinary || !engineBinary)("a standalone compiled server carries all native plugins and manages one registered engine without its checkout", async () => {
  if (!serverBinary || !engineBinary) throw new Error("Explicit compiled server and released engine binaries are required");
  const expectedEngineVersion = await expectedOpencodeVersion(resolve(engineBinary));
  const root = await realpath(await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/compiled-managed-server-")));
  const workspace = join(root, "matter"), executable = join(root, "bin", "legalwork-server"), marker = join(root, "approved-plugin-ran");
  for (const directory of [workspace, join(root, "bin"), join(root, "fixture-plugin"), ...["home", "config", "data", "state", "cache", "private"].map(name => join(root, name))]) await mkdir(directory, { recursive: true });
  await copyFile(resolve(serverBinary), executable); await chmod(executable, 0o755);
  const authored = `// Retained authored native configuration\n${JSON.stringify({
    plugins: [join(root, "fixture-plugin")], providers: { fixture: {
      package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:7/v1", apiKey: "synthetic" },
      models: { fixture: { variants: [{ id: "deep", settings: { reasoningEffort: "high" } }], limit: { context: 900_000, output: 80_000 } } },
    } },
  })}\n`;
  await writeFile(join(workspace, "opencode.jsonc"), authored);
  await writeFile(join(root, "fixture-plugin", "index.js"), `import {writeFileSync} from 'node:fs';import {Plugin} from '@opencode/plugin';export default Plugin.define({id:'fixture.compiled',setup(){writeFileSync(${JSON.stringify(marker)},'approved');}});`);
  let output = "";
  const child = Bun.spawn([executable, "--host", "127.0.0.1", "--port", "0", "--config", join(root, "private", "server.json"), "--workspace", workspace, "--approval", "auto"], {
    cwd: workspace, stdout: "pipe", stderr: "pipe", env: {
      ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      LEGALWORK_RUNTIME_DB: join(root, "private", "runtime.sqlite"), LEGALWORK_TOKEN_STORE: join(root, "private", "tokens.json"), LEGALWORK_STORAGE_STORE: join(root, "private", "storage.json"), OPENCODE_DB: join(root, "private", "engine.db"),
      LEGALWORK_MANAGE_OPENCODE: "1", LEGALWORK_MANAGED_OPENCODE_SANDBOX: "0", LEGALWORK_OPENCODE_BIN: resolve(engineBinary), LEGALWORK_OPENCODE_BASE_URL: "", LEGALWORK_OPENCODE_SDK_DIR: "", LEGALWORK_TOKEN: "compiled-client", LEGALWORK_HOST_TOKEN: "compiled-host", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    },
  });
  const capture = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) output += new TextDecoder().decode(chunk); };
  const readers = Promise.all([capture(child.stdout), capture(child.stderr)]);
  const headers = { authorization: "Bearer compiled-client" };
  let baseUrl = "";
  try {
    const deadline = Date.now() + 30_000;
    while (!baseUrl) {
      baseUrl = /LegalWork server listening on (http:\/\/[^\s]+)/.exec(output)?.[1] ?? "";
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("Compiled server did not start: " + output);
      if (!baseUrl) await Bun.sleep(20);
    }
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    const info = await fetch(`${baseUrl}/opencode/api/info`, { headers });
    expect(info.status, await info.clone().text()).toBe(200);
    expect((await info.json()).version).toBe(expectedEngineVersion);
    const workspaces: unknown = await (await fetch(`${baseUrl}/workspaces`, { headers })).json();
    if (!workspaces || typeof workspaces !== "object" || !("items" in workspaces) || !Array.isArray(workspaces.items)) throw new Error("Missing workspace list");
    const selected = workspaces.items.find((item: unknown) => item && typeof item === "object" && "path" in item && item.path === workspace);
    if (!selected || typeof selected !== "object" || !("id" in selected) || typeof selected.id !== "string") throw new Error("Missing compiled workspace");
    const projectUrl = `${baseUrl}/workspace/${selected.id}/engine-project`;
    const status = EngineProjectStatusSchema.parse(await (await fetch(projectUrl, { headers })).json());
    expect(status.state).toBe("ready");
    expect(status.required).toBe(false);
    expect(status.plugins).toEqual([]);
    const approved = await fetch(`${projectUrl}/approve`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ directory: workspace, pluginTargets: status.plugins.map(plugin => plugin.target) }) });
    expect(approved.status, await approved.clone().text()).toBe(404);
    const client = OpenCode.make({ baseUrl: `${baseUrl}/opencode`, headers });
    const location = { directory: workspace };
    const models = (await client.model.list({ location })).data.filter(model => model.providerID === "fixture");
    expect(models.map(model => model.id)).toEqual(["fixture"]);
    expect(models[0]?.limit).toMatchObject({ context: 900_000, output: 80_000 });
    expect(models[0]?.variants.some(variant => variant.id === "deep")).toBe(true);
    const plugins = (await client.plugin.list({ location })).data;
    expect(plugins.filter(plugin => plugin.state.status === "failed"), JSON.stringify(plugins)).toEqual([]);
    for (const id of ["legalwork.project-admission", "legalwork.product-scope", "legalwork.commands", "legalwork.legalmemory-access", "fixture.compiled"]) expect(plugins.find(plugin => plugin.id === id)?.state.status, id).toBe("active");
    expect(await readFile(marker, "utf8")).toBe("approved");
    const addConnector = await fetch(`${baseUrl}/workspace/${selected.id}/mcp`, { method: "POST", signal: AbortSignal.timeout(15_000), headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "hot-added", scope: "workspace", config: { type: "remote", url: "http://127.0.0.1:7/mcp", enabled: false, oauth: false } }) }).catch(error => { throw new Error("Managed connector save did not finish: " + output, { cause: error }); });
    expect(addConnector.status, await addConnector.clone().text()).toBe(200);
    expect((await client.mcp.list({ location })).data.some(server => server.name === "hot-added")).toBe(true);
    expect(await readFile(join(workspace, "opencode.jsonc"), "utf8")).toBe(authored);
    expect(output).not.toContain("compiled-client"); expect(output).not.toContain("compiled-host");
  } finally {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await readers;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
