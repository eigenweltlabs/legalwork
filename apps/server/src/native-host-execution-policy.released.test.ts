import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { buildOrgPolicyEngineLayerFor, legalworkRuntimeConfigFilePath } from "./legalwork-runtime-config.js";
import { orgPolicyEngineDir, writeOrgPolicyEngineLayer } from "./org-policy-engine.js";
import { closeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const rpc = { id: "fixture.host-policy", methods: { shell: { input: { type: "object", properties: { sessionID: { type: "string" }, command: { type: "string" } }, required: ["sessionID", "command"] }, output: { type: "string" } } }, events: {} };
test.skipIf(!binary)("protected native host execution stays denied when the sandbox plugin fails, while a separate host-only instance remains usable", async () => {
  const root = await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/native-host-policy-"));
  const previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "shared", "runtime.sqlite");
  const directory = join(root, "matter"), guard = join(root, "guard"), probe = join(root, "probe"), broken = join(root, "broken");
  for (const path of [directory, guard, probe, broken]) await mkdir(path, { recursive: true });
  const base: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }], authorizedRoots: [directory], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const engines: Array<Awaited<ReturnType<typeof createManagedOpencodeServer>>> = [];
  try {
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "opencode-plugins/legalwork-project-admission.ts")], outdir: guard, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
    if (!build.success) throw new AggregateError(build.logs, "Admission guard must build");
    await writeFile(join(broken, "index.js"), "import{Plugin}from'@opencode/plugin';export default Plugin.define({id:'legalwork.sandbox',setup(){throw new Error('Deliberate sandbox plugin fixture failure')}});");
    await writeFile(join(probe, "index.js"), `import{Plugin}from'@opencode/plugin';export default Plugin.define({id:'fixture.host-policy',async setup(ctx){await ctx.rpc.register(${JSON.stringify(rpc)},{async shell(input){const tool=(await ctx.tool.list()).find(tool=>tool.name==='shell');if(!tool)throw new Error('Missing native shell');return JSON.stringify(await tool.execute({command:input.command,description:'Native policy fixture'},{sessionID:input.sessionID,messageID:'msg_fixture',id:'call_fixture',agent:'fixture',signal:new AbortController().signal,progress:async()=>{}}));}})}});`);
    const registryPath = join(root, "projects.json"); await writeFile(registryPath, JSON.stringify({ version: 1, projects: [{ directory, approved: true }] }));
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ plugins: ["-opencode.config.policy"], permissions: [{ action: "*", resource: "*", effect: "allow" }] }));
    for (const protectedHost of [true, false]) {
      const home = join(root, protectedHost ? "desktop" : "cli"); await mkdir(home);
      const config: ServerConfig = { ...base, managedEngineStorageDirectory: home, agentSandboxEnabled: protectedHost };
      await writeFile(legalworkRuntimeConfigFilePath(config), JSON.stringify({ plugins: [guard, probe, broken] }));
      await writeOrgPolicyEngineLayer(config, await buildOrgPolicyEngineLayerFor(config, "matter"));
      const marker = join(home, "executed");
      const engine = await createManagedOpencodeServer({ bin: binary, cwd: directory, timeoutMs: 30_000, env: {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_CONFIG_DIR: orgPolicyEngineDir(config), OPENCODE_CONFIG: legalworkRuntimeConfigFilePath(config), OPENCODE_DB: join(home, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", LEGALWORK_TEST_MARKER: marker,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", plugins: [{ package: guard, options: { registryPath, protectedHostExecution: protectedHost } }], permissions: [{ action: "*", resource: "*", effect: "allow" }], agents: { fixture: { mode: "all", permissions: [{ action: "*", resource: "*", effect: "allow" }] } } }),
      } });
      engines.push(engine);
      const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
      const location = { directory }; await client.model.list({ location });
      expect((await client.plugin.list({ location })).data.find(plugin => plugin.id === "legalwork.sandbox")?.state.status).toBe("failed");
      expect((await client.plugin.list({ location })).data.find(plugin => plugin.id === "opencode.config.policy")?.state.status).toBe("active");
      const command = "node -e \"require('node:fs').writeFileSync(process.env.LEGALWORK_TEST_MARKER,'allowed')\"";
      const session = await client.session.create({ location, agent: "fixture", permissions: [{ action: "*", resource: "*", effect: "allow" }] });
      const execute = () => client.rpc.call({ rpcID: rpc.id, method: "shell", location, input: { sessionID: session.id, command } });
      if (protectedHost) {
        await expect(execute()).rejects.toThrow();
        await expect(client.shell.create({ location, command })).rejects.toThrow();
        expect(existsSync(marker)).toBe(false);
      } else {
        await execute();
        expect(existsSync(marker)).toBe(true);
        await client.shell.create({ location, command });
      }
    }
    expect(engines[0]?.pid).not.toBe(engines[1]?.pid);
  } finally {
    for (const engine of engines.reverse()) await engine.close();
    await closeRuntimeOpencodeConfig(base);
    if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
