import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "../managed-opencode.js";
import { buildNativePluginFixture } from "./native-plugin-build.test-support.js";
import { webResult } from "../agent-sandbox/web.js";
import { ApiError, formatError } from "../errors.js";
import type { UsageLimitDetails } from "../provider-usage-limit.js";
import { projectMessage } from "@legalwork/types/opencode-view";

const cases = [
  { name: "uncaught", code: 'return await tools.legalwork_websearch({query:"§ 203 StGB"});', agentSeesAllowance: true },
  { name: "caught as JSON", code: 'try { return await tools.legalwork_websearch({query:"§ 203 StGB"}); } catch (error) { return {error: String(error)}; }', agentSeesAllowance: true },
  { name: "caught and rewritten", code: 'try { return await tools.legalwork_websearch({query:"§ 203 StGB"}); } catch { return "Search is unavailable; please try later."; }', agentSeesAllowance: false },
  { name: "rethrown", code: 'try { return await tools.legalwork_websearch({query:"§ 203 StGB"}); } catch { throw new Error("Rewritten failure"); }', agentSeesAllowance: false },
];

test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN).each(cases)("released Code Mode search recovery survives reload: $name", async scenario => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-search-allowance-"));
  const workspace = join(root, "workspace");
  for (const name of ["workspace", "home", "config", "data", "state", "cache", "plugins"]) await mkdir(join(root, name));
  const limit: UsageLimitDetails = { reason: "extra_disabled", requiredMicros: 1, availableMicros: 0 };
  let calls = 0, searches = 0;
  let agentSawAllowance = false;
  const relay = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: workspace }] });
    if (path.includes("/sandbox/session/")) return Response.json({ enabled: false, networkMode: "allow", shell: "Bash", platform: "darwin", cwd: workspace });
    if (path.endsWith("/sandbox/web")) {
      searches++;
      try {
        await webResult({ kind: "search", query: "§ 203 StGB", sessionID: "fixture", agent: "legalwork", numResults: 8, type: "auto", livecrawl: "fallback" }, "https://gateway.example/v1/web/search",
          { status: 429, headers: {}, bodyBase64: Buffer.from(JSON.stringify({ detail: "Budget has been exceeded. Eigenwelt usage limit: " + JSON.stringify(limit) })).toString("base64") }, undefined,
          { name: "aws", url: "https://gateway.example/v1/web/search", apiKey: "fixture" });
      } catch (error) { if (error instanceof ApiError) return Response.json(formatError(error), { status: error.status }); throw error; }
    }
    if (path === "/v1/responses") {
      const body = await request.json();
      const first = calls++ === 0;
      if (!first) agentSawAllowance = JSON.stringify(body).includes("Do not retry or use another search route");
      const id = `resp_${calls}`;
      const item = first
        ? { type: "function_call", id: "fc_search", call_id: "call_search", name: "execute", arguments: JSON.stringify({ code: scenario.code }), status: "completed" }
        : { type: "message", id: "msg_answer", role: "assistant", content: [{ type: "output_text", text: "Search needs more allowance." }], status: "completed" };
      const response = { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
      return new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("Unknown fixture route", { status: 404 });
  } });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    const entry = join(root, "plugin.ts");
    await writeFile(entry, `
      import { Plugin } from "@opencode/plugin";
      import { LegalWorkSandbox } from ${JSON.stringify(resolve(import.meta.dir, "legalwork-sandbox.ts"))};
      import { registerChatToolResults } from ${JSON.stringify(resolve(import.meta.dir, "native-chat-tool-results.ts"))};
      export default Plugin.define({ id: "search-recovery-fixture", async setup(ctx) {
        const stopResults = await registerChatToolResults(ctx);
        const stopSandbox = await LegalWorkSandbox.setup(ctx);
        return async () => { await stopSandbox?.(); stopResults(); };
      } });
    `);
    await buildNativePluginFixture(entry, join(root, "plugins", "index.mjs"));
    const startEngine = () => createManagedOpencodeServer({ bin: process.env.LEGALWORK_TEST_OPENCODE_BIN, cwd: workspace, hostname: "127.0.0.1", port: 0, timeoutMs: 30000, env: {
      HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_DB: join(root, "data", "engine.db"), OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      LEGALWORK_SERVER_URL: relay.url.origin, LEGALWORK_SERVER_TOKEN: "fixture",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, model: "fixture/fixture", plugins: [join(root, "plugins")],
        agents: { legalwork: { mode: "primary" } }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
        providers: { fixture: { package: "@opencode/ai/providers/openai", settings: { baseURL: relay.url.origin + "/v1", apiKey: "fixture" }, models: { fixture: { capabilities: { tools: true } } } } } }),
    } });
    engine = await startEngine();
    const clientFor = (running: Awaited<ReturnType<typeof startEngine>>) => OpenCode.make({ baseUrl: running.url, headers: { Authorization: `Basic ${Buffer.from(`${running.username}:${running.password}`).toString("base64")}` } });
    const client = clientFor(engine);
    const session = await client.session.create({ location: { directory: workspace }, title: "Search allowance fixture" });
    await client.session.prompt({ sessionID: session.id, text: "Search public law" }, { signal: AbortSignal.timeout(30000) });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) });
    const assertRecovery = async (current: typeof client) => {
      const history = await current.session.context({ sessionID: session.id });
      const execute = history.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool") : []).find(part => part.name === "execute");
      expect(execute?.state.status).toBe("completed");
      if (execute?.state.status !== "completed") throw new Error("Expected Code Mode wrapper: " + JSON.stringify(history));
      expect(execute.state.metadata?.toolCalls).toMatchObject([{ tool: "legalwork_websearch", status: "error" }]);
      expect(execute.state.metadata?.legalworkWebSearchUsageLimit).toEqual(limit);
      const projected = history.flatMap(message => projectMessage(session.id, message)).flatMap(message => message.parts)
        .find(part => part.type === "tool" && part.tool === "execute");
      expect(projected?.type === "tool" && "metadata" in projected.state && projected.state.metadata?.legalworkWebSearchUsageLimit).toEqual(limit);
    };
    await assertRecovery(client);
    await engine.close();
    engine = await startEngine();
    await assertRecovery(clientFor(engine));
    expect(searches).toBe(1);
    expect(agentSawAllowance).toBe(scenario.agentSeesAllowance);
  } finally { await engine?.close(); relay.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60000);
