import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ALL_PROJECTS_TASK_AGENT, PROJECT_TASK_AGENT, hasProjectTaskBoundary, projectTaskPermissions } from "./access.js";

// Opt-in integration with the shipped engine. No live model/account is used.
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("real engine filters project-only tools and supplies trusted agent context", async () => {
  if (!binary) return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "schedule-engine-")));
  const folder = join(root, "matter"); await mkdir(folder);
  const modelRequests: { tools: string[]; toolResults: string[] }[] = [];
  const sourceReads: string[] = [];
  const fixture = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: folder }, { id: "other", path: join(root, "other") }] });
    if (path === "/scheduled-tasks/projects") return Response.json({ projects: [{ id: "matter", name: "Matter", path: folder }, { id: "other", name: "Other", path: join(root, "other") }] });
    if (path.startsWith("/workspace/")) { sourceReads.push(path); return Response.json({ content: "Other project source" }); }
    const input = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(await request.json());
    const tools = input.tools?.map(tool => tool.function.name) ?? [];
    const toolResults = input.messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content));
    if (tools.length) modelRequests.push({ tools, toolResults });
    const callTool = tools.length > 0 && toolResults.length === 0;
    const delta = callTool ? { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "legalwork_schedule_project_read", arguments: JSON.stringify({ projectId: "other", kind: "files", id: "brief.md" }) } }] } : { content: "Finished the fixture check." };
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, callTool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() }), port = reservation.port;
  reservation.stop(true);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    enabled_providers: ["fixture"], model: "fixture/fixture", small_model: "fixture/fixture", share: "disabled", autoupdate: false,
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: fixture.url.origin + "/v1", apiKey: "fixture" }, models: { fixture: { name: "Fixture", limit: { context: 100000, output: 4000 } } } } },
    plugin: [pathToFileURL(join(import.meta.dir, "../../dist/opencode-plugins/legalwork-scheduled-task-tools.js")).href],
    permission: { "*": "allow" },
    agent: { [PROJECT_TASK_AGENT]: { mode: "primary", hidden: true, permission: projectTaskPermissions() }, [ALL_PROJECTS_TASK_AGENT]: { mode: "primary", hidden: true } },
  }));
  const engine = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: folder, env: {
    ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG: config, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    LEGALWORK_SERVER_URL: fixture.url.origin, LEGALWORK_SERVER_TOKEN: "fixture",
  }, stdout: "pipe", stderr: "pipe" });
  const logs = new Response(engine.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(base + "/global/health")).ok; } catch { /* Startup. */ }
      if (ready || engine.exitCode !== null) break;
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("Engine did not start: " + (engine.exitCode !== null ? await logs : "timed out"));
    const agentsResponse = await fetch(base + "/agent");
    const agents = z.array(z.object({ name: z.string(), permission: z.array(z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "deny", "ask"]) })) })).parse(await agentsResponse.json());
    expect(hasProjectTaskBoundary(agents.find(agent => agent.name === PROJECT_TASK_AGENT)), JSON.stringify(agents.find(agent => agent.name === PROJECT_TASK_AGENT)?.permission.slice(-20))).toBe(true);
    for (const agent of [PROJECT_TASK_AGENT, ALL_PROJECTS_TASK_AGENT]) {
      const session = z.object({ id: z.string() }).parse(await (await fetch(base + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json());
      const response = await fetch(`${base}/session/${session.id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Run the scope fixture." }] }), signal: AbortSignal.timeout(25000) });
      const result = await response.text();
      expect(response.status, result).toBe(200);
      const first = modelRequests.at(-2), last = modelRequests.at(-1);
      expect(first?.tools).toContain("legalwork_schedule_project_read");
      if (agent === PROJECT_TASK_AGENT) {
        expect(first?.tools).not.toContain("bash"); expect(first?.tools).not.toContain("read"); expect(first?.tools).not.toContain("task");
        expect(last?.toolResults.join(" ")).toContain("cannot access that project"); expect(sourceReads).toEqual([]);
      } else {
        expect(first?.tools).toContain("bash"); expect(last?.toolResults.join(" ")).toContain("Other project source");
        expect(sourceReads).toEqual(["/workspace/other/project/content"]);
      }
    }
  } finally { engine.kill(); await engine.exited; fixture.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60000);
