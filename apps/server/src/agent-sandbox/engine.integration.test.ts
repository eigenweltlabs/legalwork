import { webInputSchema } from "./web.js";
import { writeSandboxDefault } from "./settings.js";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { VmSandbox } from "./vm.js";
import { sandboxEngineAgents, sandboxEnginePermissions } from "./engine-policy.js";
import { AgentSandboxService } from "./service.js";
import { ApprovalService } from "../approvals.js";
import { closeRuntimeOpencodeConfig, GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { createManagedOpencodeServer } from "../managed-opencode.js";
import { nativeOpencodeConfig } from "../native-opencode-config.js";
import { buildNativePluginFixture } from "../opencode-plugins/native-plugin-build.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary || process.env.LEGALWORK_SANDBOX_INTEGRATION !== "1")("the shipped engine calls the protected tool with identity and cannot run host bash", async () => {
  if (!binary) return;
  const evidenceDirectory = process.env.LEGALWORK_SANDBOX_ENGINE_EVIDENCE_DIR;
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(evidenceDirectory ?? tmpdir(), "sandbox-engine-")));
  const folder = join(root, "matter"); await mkdir(folder);
  for (const name of ["home", "config", "data", "cache", "state", "sandbox", "probe"]) await mkdir(join(root, name));
  const sandbox = new VmSandbox();
  const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: folder, preset: "starter", workspaceType: "local" };
  const serverConfig: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "private", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [folder],
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  await writeRuntimeOpencodeConfig(serverConfig, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { bash: "ask", read: "allow", edit: "ask", webfetch: "allow" } }));
  await writeSandboxDefault(serverConfig, { enabled: true, networkMode: "approve" });
  const approvals: string[] = [];
  const chatApprovals = new ApprovalService(serverConfig.approval, async () => {
    throw new Error("Chat approvals must not open a host dialog.");
  }, () => queueMicrotask(() => {
    for (const request of chatApprovals.list()) {
      expect(request.sessionID).toBeTruthy();
      approvals.push(request.action);
      chatApprovals.respond(request.id, "allow");
    }
  }));
  const service = new AgentSandboxService(serverConfig, chatApprovals, sandbox);
  const offered: string[][] = [];
  const calls: { agent: string; sessionID: string }[] = [];
  const webCalls: string[] = [];
  let sequence = 0;
  const fixture = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.includes("/sandbox/session/")) return Response.json({ enabled: true, networkMode: "approve", shell: "Bash", platform: "linux", cwd: "/workspace" });
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: folder }] });
    if (path === "/workspace/matter/sandbox/execute") {
      const command = z.object({ command: z.string(), write: z.boolean(), agent: z.string(), sessionID: z.string() }).parse(await request.json());
      calls.push(command);
      return Response.json(await service.run(workspace, { ...command, timeoutMs: 10000 }, { type: "host" }, request.signal));
    }
    if (path === "/workspace/matter/sandbox/web") {
      const input = webInputSchema.parse(await request.json());
      webCalls.push(input.kind);
      return Response.json(await service.web(workspace, input, { type: "host" }, request.signal));
    }
    const body = await request.text(), exchange = ++sequence;
    if (evidenceDirectory) await writeFile(join(root, `provider-${exchange}.request.json`), body);
    const input = z.object({ messages: z.array(z.object({ role: z.string() })), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(JSON.parse(body));
    const tools = input.tools?.map(tool => tool.function.name) ?? [];
    if (tools.length) offered.push(tools);
    const step = input.messages.filter(message => message.role === "tool").length;
    const tool = step === 0 ? "legalwork_shell" : step === 1 ? "legalwork_webfetch" : null;
    const invoke = tool !== null && tools.includes(tool);
    const args = step === 0 ? { command: "python3 -c 'open(\"proof.txt\", \"w\").write(\"inside VM\")'", description: "Write isolation proof", write: true }
      : { url: "https://example.com", format: "text" };
    const delta = invoke ? { tool_calls: [{ index: 0, id: "call_protected_" + step, type: "function", function: { name: tool,
      arguments: JSON.stringify(args) } }] } : { content: "Checked." };
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const output = chunk({ role: "assistant", ...delta }, null) + chunk({}, invoke ? "tool_calls" : "stop") + "data: [DONE]\n\n";
    if (evidenceDirectory) await writeFile(join(root, `provider-${exchange}.response.sse`), output);
    return new Response(output, { headers: { "content-type": "text/event-stream" } });
  } });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    await buildNativePluginFixture(join(import.meta.dir, "../opencode-plugins/legalwork-sandbox.ts"), join(root, "sandbox", "index.js"));
    // Preserve the fixture's direct-tool catalog checks; Code Mode batching has
    // separate released-host coverage.
    await writeFile(join(root, "probe", "index.js"), `import{Plugin}from'@opencode/plugin';export default Plugin.define({id:'fixture.sandbox-direct-tools',async setup(ctx){await ctx.tool.transform(editor=>{for(const item of editor.list())editor.update(item.id,tool=>{tool.options={...tool.options,codemode:false}})})}});`);
    const policy = nativeOpencodeConfig({ permission: sandboxEnginePermissions({ "*": "allow" }), agent: sandboxEngineAgents({}) }).config;
    engine = await createManagedOpencodeServer({ bin: binary, cwd: folder, timeoutMs: 200 * 100, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      LEGALWORK_SERVER_URL: fixture.url.origin, LEGALWORK_SERVER_TOKEN: "fixture",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...policy, update: "disable", warming: false, model: "fixture/fixture", plugins: [join(root, "sandbox"), join(root, "probe")],
        policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }],
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: fixture.url.origin + "/v1", apiKey: "fixture" }, models: { fixture: { name: "Fixture", limit: { context: 100000, output: 4000 }, capabilities: { tools: true } } } } },
      }),
    } });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const location = { directory: folder };
    const info = await client.server.info();
    expect(engine.pid).toBe(info.pid);
    const session = await client.session.create({ location, agent: "build", model: { providerID: "fixture", id: "fixture" } }, { signal: AbortSignal.timeout(60000) });
    const signal = AbortSignal.timeout(60000);
    const result = await client.session.prompt({ sessionID: session.id, text: "Run the isolation proof." }, { signal });
    await client.session.wait({ sessionID: session.id }, { signal });
    expect(result.id).toBeTruthy();
    expect(offered.length).toBeGreaterThan(0);
    for (const tools of offered) { expect(tools).not.toContain("bash"); expect(tools).toContain("legalwork_shell"); expect(tools).not.toContain("webfetch"); expect(tools).not.toContain("websearch"); expect(tools).toContain("legalwork_webfetch"); expect(tools).toContain("legalwork_websearch"); }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agent: "build", sessionID: session.id });
    expect(approvals).toEqual(["sandbox.bash", "sandbox.edit", "sandbox.webfetch"]);
    expect(webCalls).toEqual(["fetch"]);
    const messages = await client.session.context({ sessionID: session.id });
    if (evidenceDirectory) await writeFile(join(root, "result.json"), JSON.stringify({ info, execution: engine.execution, result, messages, offered, calls, approvals, webCalls }, null, 2));
    const fetched = messages.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool") : []).find(part => part.name === "legalwork_webfetch");
    expect(fetched?.state?.status).toBe("completed");
    expect(fetched?.state.status === "completed" ? fetched.state.content.flatMap(content => content.type === "text" ? [content.text] : []).join("\n") : "").toContain("Example Domain");
    expect(await readFile(join(folder, "proof.txt"), "utf8")).toBe("inside VM");
    await expect(client.session.shell({ sessionID: session.id, command: "echo escaped > host-escape.txt" }, { signal: AbortSignal.timeout(10000) })).rejects.toThrow();
    expect(await readFile(join(folder, "host-escape.txt")).catch(() => null)).toBeNull();
  } finally {
    await engine?.close(); fixture.stop(true);
    await service.stop();
    await VmSandbox.shutdown();
    await closeRuntimeOpencodeConfig(serverConfig); Bun.gc(true);
    if (!evidenceDirectory) await rm(root, { recursive: true, force: true });
  }
}, 120000);
