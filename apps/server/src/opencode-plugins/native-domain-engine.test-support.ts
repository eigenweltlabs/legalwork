import { OpenCode } from "@opencode/client";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedOpencodeServer } from "../managed-opencode.js";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { buildNativePluginFixture } from "./native-plugin-build.test-support.js";
import { ensureWikiAgentToken } from "../wiki/agent-access.js";

/** A real released host and real LegalWork domain routes. Direct tool exposure
 * defaults on for permission/resource scenarios; disable it to check normal
 * Code Mode exposure against the released host. */
export async function nativeDomainEngine(options: {
  binary: string;
  plugins: string[];
  modelURL: string;
  configuration?: Record<string, unknown>;
  /** Keep normal Code Mode exposure when false; domain-only fixtures default to direct tools. */
  directTools?: boolean;
  setup?: (config: ServerConfig, root: string) => Promise<void>;
  /** Exercise the managed session-origin credential rather than bearer-only tools. */
  scopedRuntime?: boolean;
  /** Keep complete controlled-fixture traffic and isolated runtime state. */
  evidenceDirectory?: string;
}) {
  if (options.evidenceDirectory) await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(options.evidenceDirectory ?? tmpdir(), "legalwork-native-domain-")));
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousDb = process.env.OPENCODE_DB;
  process.env.XDG_CONFIG_HOME = join(root, "library-config");
  process.env.OPENCODE_DB = join(root, "engine.db");
  for (const name of ["project", "home", "config", "data", "state", "cache", "plugins", "library-config"]) await mkdir(join(root, name));
  const directory = join(root, "project"), location = { directory };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "synthetic-domain-fixture", hostToken: "synthetic-domain-host", configPath: join(root, "private", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  const close = async () => {
    await engine?.close(); await server?.stop();
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousDb === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previousDb;
    if (!options.evidenceDirectory) await rm(root, { recursive: true, force: true });
  };
  try {
    await options.setup?.(config, root);
    server = await startServer(config);
    const plugins: string[] = [];
    for (const [index, source] of options.plugins.entries()) {
      const directory = join(root, "plugins", String(index)); await mkdir(directory);
      await buildNativePluginFixture(source, join(directory, "index.js")); plugins.push(directory);
    }
    const probe = join(root, "plugins", "probe"); await mkdir(probe);
    await writeFile(join(probe, "index.js"), `import {Plugin} from "@opencode/plugin";export default Plugin.define({id:"legalwork.domain-fixture",async setup(ctx){if(${options.directTools !== false})await ctx.tool.transform(editor=>{for(const item of editor.list())editor.update(item.id,tool=>{tool.options={...tool.options,codemode:false}})});await ctx.rpc.register({id:"legalwork.domain-fixture",methods:{tools:{input:{type:"object"},output:{type:"array",items:{type:"string"}}}},events:{}},{async tools(){return (await ctx.tool.list()).map(tool=>tool.id)}})}});`);
    plugins.push(probe);
    engine = await createManagedOpencodeServer({ bin: options.binary, cwd: directory, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      LEGALWORK_SERVER_URL: `http://127.0.0.1:${server.port}`, LEGALWORK_SERVER_TOKEN: config.token,
      ...(options.scopedRuntime ? { LEGALWORK_WIKI_AGENT_TOKEN: await ensureWikiAgentToken(config) } : {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins, model: "fixture/fixture",
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: options.modelURL, apiKey: "synthetic-fixture" }, models: { fixture: { limit: { context: 128000, output: 4096 }, capabilities: { tools: true } } } } },
        policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }],
        ...options.configuration,
      }),
    } });
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    let exchange = 0;
    const makeClient = (channel: string, baseUrl: string, authorization: string) => OpenCode.make({ baseUrl, headers: { authorization },
      ...(options.evidenceDirectory ? { fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init), prefix = join(options.evidenceDirectory!, `${channel}-${String(++exchange).padStart(4, "0")}`);
        await writeFile(`${prefix}.request.raw`, Buffer.from(await request.clone().arrayBuffer()));
        const startedAt = new Date().toISOString();
        try {
          const response = await fetch(request);
          await writeFile(`${prefix}.response.raw`, Buffer.from(await response.clone().arrayBuffer()));
          await writeFile(`${prefix}.json`, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), method: request.method, url: request.url, status: response.status,
            // Synthetic credentials still do not belong in evidence headers.
            requestHeaders: [...request.headers].filter(([name]) => !["authorization", "cookie", "x-api-key"].includes(name)),
            responseHeaders: [...response.headers].filter(([name]) => name !== "set-cookie"),
          }, null, 2));
          return response;
        } catch (error) {
          await writeFile(`${prefix}.error.json`, JSON.stringify({ startedAt, failedAt: new Date().toISOString(), error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }, null, 2));
          throw error;
        }
      }, { preconnect: fetch.preconnect }) } : {}),
    });
    const client = makeClient("native", engine.url, `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`);
    const appClient = makeClient("app", `http://127.0.0.1:${server.port}/workspace/matter/opencode`, `Bearer ${config.token}`);
    await client.model.list({ location });
    if (options.evidenceDirectory) await writeFile(join(options.evidenceDirectory, "runtime.json"), JSON.stringify({ root, directory, scopedRuntime: options.scopedRuntime === true,
      native: await client.server.info(), enginePid: engine.pid, execution: engine.execution, appProxy: `http://127.0.0.1:${server.port}/workspace/matter/opencode`,
      originRegistration: "ordinary authenticated app proxy; no manual grant",
    }, null, 2));
    return { root, directory, location, config, client, appClient, close, serverURL: `http://127.0.0.1:${server.port}`,
      tools: async () => (await client.rpc.call({ location, rpcID: "legalwork.domain-fixture", method: "tools", input: {} })).output,
    };
  } catch (error) { await close(); throw error; }
}

export function nativeChatResponse(call: { name: string; input: unknown } | undefined, sequence: number) {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `fixture_${sequence}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", ...(call ? { tool_calls: [{ index: 0, id: `call_fixture_${sequence}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: "Fixture checked." }) }, null)
    + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
