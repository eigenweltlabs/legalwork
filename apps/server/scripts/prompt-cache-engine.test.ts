import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { buildSessionPromptRequest, nativePrompt } from "../../app/src/app/lib/system-reminder";
import { writeLegalworkRuntimeConfigFile, legalworkMandatoryRuntimeConfigContent, legalworkRuntimeConfigFilePath, managedEngineSettingsFilePath } from "../src/legalwork-runtime-config";
import { approveEngineProject, engineProjectStatus, writeNativeEngineProjectRegistry } from "../src/engine-project";
import { orgPolicyEngineDir } from "../src/org-policy-engine";
import { createManagedOpencodeServer } from "../src/managed-opencode";
import { assertCachePrefix, CacheRequestSchema, type CacheRequest } from "../src/prompt-cache.test-support";
import { closeRuntimeOpencodeConfig, writeRuntimeOpencodeConfig, GLOBAL_TOOL_PERMISSIONS_ID } from "../src/runtime-opencode-config-store";
import { startServer } from "../src/server";
import { listEngineMessages } from "../src/engine-client";
import type { ServerConfig } from "../src/types";

// Run in a separate process: actual released engine, production config writer,
// plugins, queue, Code Mode, child sessions, skills and MCP. Only external model,
// MCP contents and document UI are deterministic local protocol fixtures.
const setting = (name: string, fallback: number) => z.coerce.number().int().positive().parse(process.env[name] ?? fallback);
const deadlines = { request: setting("LEGALWORK_CACHE_FIXTURE_REQUEST_MS", 60_000), readiness: setting("LEGALWORK_CACHE_FIXTURE_READY_MS", 45_000), startup: setting("LEGALWORK_CACHE_FIXTURE_STARTUP_MS", 30_000) };
async function ready<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const deadline = Date.now() + deadlines.readiness;
  do { const value = await read(); if (accept(value)) return value; await Bun.sleep(20); } while (Date.now() < deadline);
  throw new Error("Native cache fixture readiness watchdog expired (test infrastructure only).");
}

async function runFixture(injectTimestamp: boolean) {
  const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
  if (!binary) throw new Error("Set LEGALWORK_TEST_OPENCODE_BIN to the released engine; build legalwork-server plugins first.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-cache-")));
  const workspace = { id: "matter", name: "Synthetic matter", path: join(root, "matter"), preset: "starter", workspaceType: "local" } satisfies ServerConfig["workspaces"][number];
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "private", "server.json"), engineProjectTrustRequired: true,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [workspace.path], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const captures: { trajectory: string; sessionID: string; kind: string; epoch: string; request: CacheRequest }[] = [];
  const auxiliary: { sessionID: string; kind: string; request: CacheRequest }[] = [];
  const previous = new Map<string, CacheRequest>(), steps = new Map<string, number>();
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, client: OpenCodeClient | undefined;
  let activeSession = "", surface = "", epoch = "continuous", modelID = "fixture", skillID = "", contractError: Error | undefined, fixtureError: Error | undefined;
  let inventory: unknown;
  const diagnostics: unknown[] = [];
  const ui = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const snapshot = { ok: true, route: `/workspace/matter/session/${activeSession}`, activeSurface: surface ? { id: `${activeSession}:file:${surface}`, kind: "document", format: "docx", sessionId: activeSession, workspaceId: "matter", name: surface, path: surface, editable: true } : null, actions: [] };
    if (new URL(request.url).pathname === "/execute") {
      const action = z.object({ actionId: z.literal("documents.list"), args: z.object({ sessionId: z.string() }) }).parse(await request.json());
      return Response.json({ ok: true, result: { ...snapshot, activeSurface: action.args.sessionId === activeSession ? snapshot.activeSurface : null } });
    }
    return Response.json(snapshot);
  } });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
    const input = CacheRequestSchema.parse(await request.json());
    const sessionID = request.headers.get("x-legalwork-cache-session") ?? "unknown", kind = request.headers.get("x-legalwork-cache-kind") ?? "unknown";
    const toolNames = (input.tools ?? []).map(tool => z.object({ function: z.object({ name: z.string() }) }).parse(tool).function.name);
    const child = sessionID !== activeSession;
    const trajectory = child ? "child" : "parent", key = `${sessionID}:${epoch}`;
    const step = steps.get(trajectory) ?? 0;
    let call: { name: string; arguments: string } | undefined;
    if (kind === "primary") {
      const prior = previous.get(key);
      try { if (prior) assertCachePrefix(prior, input, `${trajectory}/${epoch} request ${step + 1}`); }
      catch (error) { contractError = error instanceof Error ? error : new Error(String(error)); }
      captures.push({ trajectory, sessionID, kind, epoch, request: input }); previous.set(key, input); steps.set(trajectory, step + 1);
      if (child && step === 0) call = { name: "read", arguments: JSON.stringify({ path: join(workspace.path, "fixture.txt") }) };
      if (!child && step === 0) { await Bun.sleep(1100); surface = "opened-during-tool.docx"; call = { name: "read", arguments: JSON.stringify({ path: join(workspace.path, "fixture.txt") }) }; }
      if (!child && step === 1) call = { name: "execute", arguments: JSON.stringify({ code: 'return search({query:"echo",namespace:"cachefixture"});' }) };
      if (!child && step === 2) {
        const result = input.messages.find(message => message.role === "tool" && Reflect.get(message, "tool_call_id") === "call_parent_1");
        const content = result && Reflect.get(result, "content");
        if (typeof content !== "string") throw new Error("Native Code Mode discovery did not return tool results");
        const found = z.object({ items: z.array(z.object({ path: z.string() })) }).parse(JSON.parse(content)).items;
        expect(found).toHaveLength(1);
        const path = found[0].path.split(".");
        expect(path.shift()).toBe("tools");
        const expression = "tools" + path.map(part => `[${JSON.stringify(part)}]`).join("");
        call = { name: "execute", arguments: JSON.stringify({ code: `return await ${expression}({value:"synthetic echo"});` }) };
      }
      if (!child && step === 3) call = { name: "subagent", arguments: JSON.stringify({ description: "Cache fixture child", prompt: "CACHE_CHILD: Read fixture.txt and report its synthetic text.", agent: "explore", background: false }) };
      if (!child && step === 4) call = { name: "execute", arguments: JSON.stringify({ code: "return await tools.legalwork_schedule_clock({});" }) };
      if (!child && step === 5) call = { name: "skill", arguments: JSON.stringify({ id: skillID }) };
      if (call && !toolNames.includes(call.name)) throw new Error(`Production native tool not discovered: ${call.name}; available ${toolNames.join(",")}`);
    } else auxiliary.push({ sessionID, kind, request: input });
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `fixture_${trajectory}_${step}`, object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    // Optional CI proxy must itself be a loopback deterministic fixture; this
    // script never forwards to a production model or accepts production keys.
    const gateway = process.env.LEGALWORK_CACHE_GATEWAY;
    if (gateway && !injectTimestamp) {
      const target = new URL(gateway), control = new URL(process.env.LEGALWORK_CACHE_PROVIDER ?? "");
      if (![target, control].every(url => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Cache CI gateway/provider must be local deterministic fixtures.");
      const calls = input.messages.reduce((count, message) => count + (z.object({ tool_calls: z.array(z.unknown()).optional() }).parse(message).tool_calls?.length ?? 0), 0);
      const plan = await fetch(new URL("/plan", control), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: `${kind === "primary" ? trajectory : "other"}:${calls}`, call }), signal: AbortSignal.timeout(deadlines.request) });
      if (!plan.ok) throw new Error("Could not configure local provider fixture");
      return fetch(new URL("/v1/chat/completions", target), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-cache-fixture" }, body: JSON.stringify(input), signal: AbortSignal.timeout(deadlines.request) });
    }
    const delta = call ? { tool_calls: [{ index: 0, id: `call_${trajectory}_${step}`, type: "function", function: call }] } : { content: "Synthetic fixture complete." };
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } catch (error) {
      fixtureError = error instanceof Error ? error : new Error(String(error));
      return Response.json({ error: { message: "Deterministic cache provider fixture failed; original error retained by the harness." } }, { status: 400 });
    }
  } });
  const discovery = join(root, "ui.json"), instrumentation = join(root, "instrumentation"), mutation = join(root, "mutation");
  const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    if (!server) throw new Error("LegalWork server unavailable");
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: "Bearer fixture", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(deadlines.request) });
    if (!response.ok) throw new Error(`LegalWork ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const startEngine = async () => {
    const runtimePath = await writeLegalworkRuntimeConfigFile(config, workspace.id);
    await writeNativeEngineProjectRegistry(config);
    engine = await createManagedOpencodeServer({ bin: binary, cwd: workspace.path, timeoutMs: deadlines.startup, service: { configDirectory: orgPolicyEngineDir(config), stateDirectory: join(root, "state") }, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), OPENCODE_CONFIG: runtimePath, OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config), OPENCODE_CONFIG_DIR: orgPolicyEngineDir(config), OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DB: join(root, "engine.db"), LEGALWORK_UI_CONTROL_DISCOVERY: discovery,
      LEGALWORK_SERVER_URL: server ? `http://127.0.0.1:${server.port}` : "", LEGALWORK_SERVER_TOKEN: "fixture", TZ: "Europe/Berlin",
    } });
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const location = { directory: workspace.path };
    await client.model.list({ location });
    const agents = (await client.agent.list({ location })).data;
    expect(agents.some(agent => agent.id === "legalwork")).toBe(true); expect(agents.some(agent => agent.id === "explore")).toBe(true);
    const skills = (await client.skill.list({ location })).data;
    skillID = skills.find(skill => skill.name === "cache-fixture")?.id ?? ""; expect(skillID).not.toBe("");
    await ready(async () => (await client!.mcp.list({ location })).data.find(server => server.name === "cachefixture")?.status.status, value => value === "connected");
    inventory = (await client.plugin.list({ location })).data;
    const failed = z.array(z.object({ state: z.object({ status: z.string() }) }).passthrough()).parse(inventory).filter(plugin => plugin.state.status !== "active");
    expect(failed, JSON.stringify(failed)).toEqual([]);
  };
  const prompt = async (text: string, context: string) => {
    if (!client) throw new Error("Native client unavailable");
    const serialized = nativePrompt(buildSessionPromptRequest({ sessionID: activeSession, parts: [{ type: "text", text }] }, context));
    await request(`/workspace/matter/sessions/${activeSession}/dispatch`, { ...serialized, sessionID: undefined, kind: "prompt", agent: "legalwork", model: { providerID: "fixture", id: modelID }, waitForCompletion: true });
    if (fixtureError) throw fixtureError;
    const session = await client.session.get({ sessionID: activeSession });
    const messages = await listEngineMessages(client, activeSession);
    if (session.outcome !== "succeeded") {
      const status = await engineProjectStatus(config, workspace);
      const files = [legalworkRuntimeConfigFilePath(config), managedEngineSettingsFilePath(config), join(orgPolicyEngineDir(config), "opencode.json"), status.projection.path].filter((path): path is string => Boolean(path));
      diagnostics.push({ session, messages, status, agents: await client.agent.list({ location: session.location }), plugins: await client.plugin.list({ location: session.location }), files: await Promise.all(files.map(async path => ({ path, content: await readFile(path, "utf8") }))) });
    }
    expect(session.outcome, JSON.stringify(messages.filter(message => message.type === "idle"))).toBe("succeeded");
    const failures = messages.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool" && (part.state.status === "error" || "metadata" in part.state && part.state.metadata?.error === true)) : []);
    expect(failures, JSON.stringify(failures)).toEqual([]);
  };
  const personalize = async (customInstructions: string) => {
    const { revision } = z.object({ revision: z.number() }).parse(await request("/workspace/matter/personalization"));
    await request("/workspace/matter/personalization", { revision, customInstructions }, "PUT");
  };
  try {
    for (const directory of [workspace.path, instrumentation, ...["home", "config", "data", "cache", "state"].map(name => join(root, name))]) await mkdir(directory, { recursive: true });
    await writeFile(join(workspace.path, "fixture.txt"), "SYNTHETIC FILE CONTENT\n");
    const skill = join(workspace.path, ".opencode", "skills", "cache-fixture"); await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: cache-fixture\ndescription: Synthetic cache regression skill\n---\nUse the synthetic fixture file.\n");
    await writeFile(discovery, JSON.stringify({ baseUrl: ui.url.origin, token: "fixture" }));
    await writeFile(join(instrumentation, "index.js"), `import{Plugin}from'@opencode/plugin';export default Plugin.define({id:'legalwork.cache-instrumentation',async setup(ctx){await ctx.session.hook('model.request',event=>{event.headers['x-legalwork-cache-session']=event.sessionID;event.headers['x-legalwork-cache-kind']=event.kind;});}});`);
    if (injectTimestamp) { await mkdir(mutation); await writeFile(join(mutation, "index.js"), `import{Plugin}from'@opencode/plugin';export default Plugin.define({id:'legalwork.cache-negative',async setup(ctx){await ctx.session.hook('context',event=>{event.system.push({type:'text',text:'CACHE_REGRESSION_TIME: '+new Date().toISOString()});});}});`); }
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { "*": "allow" } }));
    await writeRuntimeOpencodeConfig(config, workspace.id, () => ({ plugin: [instrumentation, ...(injectTimestamp ? [mutation] : [])],
      mcp: { cachefixture: { type: "local", command: [process.execPath, join(import.meta.dir, "prompt-cache-mcp.ts")], enabled: true } },
      providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${provider.url.origin}/v1`, apiKey: "fixture" }, models: {
        fixture: { name: "Fixture", limit: { context: 128_000, output: 4096 }, capabilities: { tools: true } }, alternate: { name: "Alternate fixture", limit: { context: 128_000, output: 4096 }, capabilities: { tools: true } },
      } } }, providerActivation: { fixture: "allow" },
    }));
    await writeLegalworkRuntimeConfigFile(config, workspace.id);
    const review = await engineProjectStatus(config, workspace);
    await approveEngineProject(config, workspace, review.directory, review.plugins.filter(plugin => !plugin.approved).map(plugin => plugin.target));
    server = await startServer(config);
    await startEngine();
    if (!client) throw new Error("Native client unavailable");
    const session = await client.session.create({ location: { directory: workspace.path }, agent: "legalwork", model: { providerID: "fixture", id: modelID }, title: "Synthetic native cache contract" }); activeSession = session.id;
    await personalize("PROJECT INITIAL SYNTHETIC PREFERENCE");
    await prompt("CACHE_PARENT: Read the file, use MCP through Code Mode, delegate, get the clock and load the fixture skill.", "APP INITIAL SYNTHETIC CONTEXT");
    if (injectTimestamp) {
      expect(captures.length).toBeGreaterThan(2);
      const systemIndex = captures[0].request.messages.findIndex(message => message.role === "system" && JSON.stringify(message.content).includes("CACHE_REGRESSION_TIME"));
      expect(systemIndex).toBeGreaterThanOrEqual(0); expect(contractError?.message).toContain(`prompt cache prefix changed at messages[${systemIndex}].content`); return;
    }
    if (contractError) throw contractError;
    expect(steps.get("parent")).toBeGreaterThanOrEqual(7); expect(steps.get("child")).toBeGreaterThanOrEqual(2);
    surface = "follow-up-document.docx"; await personalize("PROJECT UPDATED SYNTHETIC PREFERENCE");
    await request("/workspace/matter/office-tools/poll?wait=0&host=word&document=synthetic-word.docx");
    await prompt("Continue the synthetic check.", "APP UPDATED SYNTHETIC CONTEXT"); if (contractError) throw contractError;
    await engine?.close(); await startEngine();
    await prompt("Continue after persisted service restart.", "APP RESTART SYNTHETIC CONTEXT"); if (contractError) throw contractError;
    const parent = captures.filter(capture => capture.trajectory === "parent" && capture.epoch === "continuous"), first = parent[0].request, last = parent.at(-1)?.request;
    const wire = JSON.stringify(last?.messages);
    for (const text of ["Use the synthetic fixture file.", "APP INITIAL SYNTHETIC CONTEXT", "APP UPDATED SYNTHETIC CONTEXT", "PROJECT UPDATED SYNTHETIC PREFERENCE", "MCP fixture: synthetic echo", "follow-up-document.docx", "synthetic-word.docx", "SYNTHETIC FILE CONTENT"]) expect(wire).toContain(text);
    for (const name of ["read", "subagent", "skill", "execute"]) expect(JSON.stringify(first.tools)).toContain(`"${name}"`);
    const bad = structuredClone(first), system = bad.messages.find(message => message.role === "system"); if (!system) throw new Error("Missing system prompt");
    system.content = `${JSON.stringify(system.content)}\nCurrent time: ${new Date().toISOString()}`;
    expect(() => assertCachePrefix(first, bad, "negative live clock")).toThrow("prompt cache prefix changed");
    expect(() => assertCachePrefix(first, { ...first, tools: [...(first.tools ?? [])].reverse() }, "negative tool order")).toThrow("tools[");
    // Reset only after explicit completed compaction/model selection. Ordinary
    // turns, app changes and restart never reset a cache baseline.
    await client!.session.compact({ sessionID: activeSession }); await client!.session.wait({ sessionID: activeSession }, { signal: AbortSignal.timeout(deadlines.request) });
    epoch = "compaction";
    await prompt("Continue after explicit compaction.", "APP COMPACTED SYNTHETIC CONTEXT"); await prompt("Continue in compacted context.", "APP COMPACTED FOLLOW-UP CONTEXT"); if (contractError) throw contractError;
    modelID = "alternate"; epoch = "model-change";
    await prompt("Continue with alternate fixture model.", "APP MODEL CHANGE CONTEXT"); await prompt("Continue with this model.", "APP MODEL FOLLOW-UP CONTEXT"); if (contractError) throw contractError;
    for (const boundary of ["compaction", "model-change"]) expect(captures.filter(capture => capture.trajectory === "parent" && capture.epoch === boundary)).toHaveLength(2);
    expect(auxiliary.some(capture => capture.kind === "compaction")).toBe(true);
    console.log(`Native prefix contract: ${parent.length} parent requests, ${captures.filter(capture => capture.trajectory === "child").length} child requests, ${auxiliary.length} separately recorded auxiliary requests; Code Mode/MCP/subagent/skill/production plugins and persisted service restart. This is not a provider cache-hit or cost-performance claim.`);
  } finally {
    if (process.env.LEGALWORK_CACHE_CAPTURE) await writeFile(process.env.LEGALWORK_CACHE_CAPTURE + (injectTimestamp ? ".negative" : ""), JSON.stringify({ negativeControl: injectTimestamp, captures, auxiliary, inventory, diagnostics, limits: { infrastructureDeadlinesMs: deadlines, modelFixture: { context: 128_000, output: 4096 }, outputCaps: [] } }, null, 2), { mode: 0o600 });
    await engine?.close(); await server?.stop(); provider.stop(true); ui.stop(true); await closeRuntimeOpencodeConfig(config); await rm(root, { recursive: true, force: true });
  }
}

// Native integration is opt-in in the default unit suite; CI supplies the pinned
// released binary explicitly. Missing/broken configured binaries still fail.
test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("native production agent preserves prompt prefix through Code Mode, MCP, app changes, subagents and service restart", () => runFixture(false), setting("LEGALWORK_CACHE_FIXTURE_TEST_MS", 150_000));
test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("native prefix guard detects an actual plugin injecting changing system timestamps", () => runFixture(true), setting("LEGALWORK_CACHE_FIXTURE_NEGATIVE_TEST_MS", 120_000));
