import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ScheduledTaskInputSchema, type ScheduledTaskInput } from "@legalwork/types/scheduled-tasks";
import { ALL_PROJECTS_TASK_AGENT, PROJECT_TASK_AGENT, hasProjectTaskBoundary, projectTaskPermissions, allProjectTaskPermissions } from "./access.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { TaskStore } from "../task-store.js";
import { readProjectContent, type ProjectContentSources } from "../project-contents.js";
import { nextOccurrence } from "./schedule.js";

// Opt-in integration with the shipped engine. No live model/account is used.
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("real engine enforces project scope and supplies local scheduling defaults", async () => {
  if (!binary) return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "schedule-engine-")));
  const folder = join(root, "matter"), otherFolder = join(root, "other"); await mkdir(folder); await mkdir(otherFolder);
  const tasks = await TaskStore.open(join(root, "tasks.sqlite"), join(root, "attachments"));
  let transcriptSources: ProjectContentSources | undefined;
  let sourceSessionId = "";
  let uiActions = 0;
  const modelRequests: { tools: string[]; toolResults: string[]; system: string }[] = [];
  const created: ScheduledTaskInput[] = [];
  const delegated: unknown[] = [];
  const sourceReads: string[] = [];
  const fixture = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/assistant") return Response.json({ workspace: { id: "matter", path: folder } });
    if (path === "/assistant/delegate") { delegated.push(await request.json()); return Response.json({ ok: true, delegation: { workspaceId: "other", sessionId: "delegated-session", title: "Review agreement", scope: "Draft for review", status: "started" } }); }
    if (path === "/snapshot") return Response.json({ ok: true, route: "/unrelated-chat" });
    if (path === "/execute") { uiActions++; return Response.json({ ok: true }); }
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: folder }, { id: "other", path: join(root, "other") }] });
    if (path === "/scheduled-tasks/projects") return Response.json({ projects: [{ id: "matter", name: "Matter", path: folder }, { id: "other", name: "Other", path: join(root, "other") }] });
    if (path === "/workspace/matter/scheduled-tasks" && request.method === "POST") {
      const input = ScheduledTaskInputSchema.parse(await request.json());
      created.push(input);
      return Response.json({ task: { ...input, nextRunAt: nextOccurrence(input.schedule, Date.parse("2026-10-24T12:00:00Z")) } });
    }
    if (path === "/workspace/other/project/content" && transcriptSources) { sourceReads.push(path); return Response.json(await readProjectContent(transcriptSources, Object.fromEntries(new URL(request.url).searchParams))); }
    const input = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(await request.json());
    const tools = input.tools?.map(tool => tool.function.name) ?? [];
    const toolResults = input.messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content));
    const system = input.messages.filter(message => message.role === "system").map(message => JSON.stringify(message.content)).join(" ");
    if (tools.length) modelRequests.push({ tools, toolResults, system });
    const callTool = tools.length > 0 && toolResults.length === 0;
    const morning = input.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("every morning"));
    const delegation = input.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Delegate this work"));
    const call = delegation ? { name: "legalwork_assistant_delegate", arguments: JSON.stringify({ projectId: "other", title: "Review agreement", conversationLanguage: "en", prompt: "Review the liability clauses", scope: "Draft for review" }) } : morning
      ? { name: "legalwork_schedule_create", arguments: JSON.stringify({ title: "Morning deadlines", prompt: "Review this project's deadlines.", schedule: { kind: "rrule", startAt: "2026-10-25T06:00:00", rrule: "FREQ=DAILY" } }) }
      : { name: "legalwork_schedule_project_read", arguments: JSON.stringify({ projectId: "other", kind: "sessions", id: sourceSessionId }) };
    const delta = callTool ? { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: call }] } : { content: "Finished the fixture check." };
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, callTool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() }), port = reservation.port;
  reservation.stop(true);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    enabled_providers: ["fixture"], model: "fixture/fixture", small_model: "fixture/fixture", share: "disabled", autoupdate: false,
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: fixture.url.origin + "/v1", apiKey: "fixture" }, models: { fixture: { name: "Fixture", limit: { context: 100000, output: 4000 } } } } },
    plugin: ["legalwork-scheduled-task-tools", "legalwork-extensions-preview", "legalwork-assistant-tools", "legalwork-task-tools"].map(name => pathToFileURL(join(import.meta.dir, `../../dist/opencode-plugins/${name}.js`)).href),
    permission: { "*": "allow" },
    agent: { [PROJECT_TASK_AGENT]: { mode: "primary", hidden: true, permission: projectTaskPermissions() }, [ALL_PROJECTS_TASK_AGENT]: { mode: "primary", hidden: true, permission: allProjectTaskPermissions() } },
  }));
  const discovery = join(root, "ui-bridge.json");
  await writeFile(discovery, JSON.stringify({ baseUrl: fixture.url.origin, token: "fixture" }));
  const engine = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: folder, env: {
    ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG: config, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    LEGALWORK_UI_CONTROL_DISCOVERY: discovery, LEGALWORK_SERVER_URL: fixture.url.origin, LEGALWORK_SERVER_TOKEN: "fixture", TZ: "Europe/Berlin",
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
    const client = createOpencodeClient({ baseUrl: base, directory: otherFolder });
    const { data: sourceSession } = await client.session.create({ title: "Other project chat" }, { throwOnError: true });
    sourceSessionId = sourceSession.id;
    for (let i = 0; i < 23; i++) await client.session.prompt({ sessionID: sourceSession.id, noReply: true, parts: [{ type: "text", text: `Source message ${i}: Continue the contract review.` }] }, { throwOnError: true });
    transcriptSources = {
      workspace: { id: "other", name: "Other", path: otherFolder, preset: "default", workspaceType: "local" }, tasks, orgId: null,
      sessions: async () => [],
      session: async id => (await client.session.get({ sessionID: id }, { throwOnError: true })).data,
      sessionMessages: async (id, limit, before) => { const result = await client.session.messages({ sessionID: id, limit, before }, { throwOnError: true }); return { messages: result.data, nextBefore: result.response.headers.get("x-next-cursor") }; },
    };
    const recent = await readProjectContent(transcriptSources, { kind: "sessions", id: sourceSession.id });
    expect(recent.content).toContain("Source message 22");
    expect(recent.content).not.toContain("Source message 0:");
    expect(recent.nextBefore).not.toBeNull();
    const older = await readProjectContent(transcriptSources, { kind: "sessions", id: sourceSession.id, before: recent.nextBefore });
    expect(older.content).toContain("Source message 0:"); expect(older.nextBefore).toBeNull();
    expect(recent.content.split("\n").length + older.content.split("\n").length).toBe(23);
    const agentsResponse = await fetch(base + "/agent");
    const agents = z.array(z.object({ name: z.string(), permission: z.array(z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "deny", "ask"]) })) })).parse(await agentsResponse.json());
    expect(hasProjectTaskBoundary(agents.find(agent => agent.name === PROJECT_TASK_AGENT)), JSON.stringify(agents.find(agent => agent.name === PROJECT_TASK_AGENT)?.permission.slice(-20))).toBe(true);
    for (const agent of [PROJECT_TASK_AGENT, ALL_PROJECTS_TASK_AGENT, "build", "assistant-delegation"]) {
      const session = z.object({ id: z.string() }).parse(await (await fetch(base + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json());
      const response = await fetch(`${base}/session/${session.id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: agent === "assistant-delegation" ? "build" : agent, model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: agent === "assistant-delegation" ? "Delegate this work to the other project." : agent === "build" ? "Remind me of this project's deadlines every morning." : "Run the scope fixture." }] }), signal: AbortSignal.timeout(25000) });
      const result = await response.text();
      expect(response.status, result).toBe(200);
      const first = modelRequests.at(-2), last = modelRequests.at(-1);
      expect(first?.tools).toContain("legalwork_schedule_project_read");
      if (agent !== "build" && agent !== "assistant-delegation") {
        expect(first?.tools).not.toContain("legalwork_ui_execute_action");
        expect(first?.tools).not.toContain("legalwork_ui_snapshot");
        expect(first?.tools).not.toContain("legalwork_ui_list_actions");
      }
      if (agent === "assistant-delegation") {
        expect(first?.tools).toContain("legalwork_assistant_delegate");
        for (const tool of ["projects", "session_search", "tasks", "calendar", "calendar_read", "file_search"]) expect(first?.tools).toContain(`legalwork_assistant_${tool}`);
        expect(first?.tools).toContain("bash");
        expect(first?.system).toContain("Each device-local calendar day has a separate context");
        expect(first?.system).toContain("Search legalwork_assistant_projects");
        expect(first?.system).toContain("Always set conversationLanguage to the user's current chat language");
        expect(first?.system).toContain("turning the outstanding evidence requests and decisions into source-linked tasks");
        expect(delegated).toEqual([{ workspaceId: "other", sourceWorkspaceId: "matter", sourceSessionId: session.id, title: "Review agreement", conversationLanguage: "en", prompt: "Review the liability clauses", scope: "Draft for review" }]);
        expect(last?.toolResults.join(" ")).toContain("delegated-session");
      } else if (agent === "build") {
        expect(first?.tools).toContain("legalwork_schedule_create");
        expect(first?.system).toContain("local time zone is Europe/Berlin");
        expect(first?.system).toContain("Do not ask the user for their time zone");
        expect(first?.system).toContain("use 06:00, starting at the next future morning");
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ sessionId: session.id, reuseChat: true, projectAccess: "project", model: { providerID: "fixture", modelID: "fixture" }, schedule: { timeZone: "Europe/Berlin", startAt: "2026-10-25T06:00:00" } });
        expect(last?.toolResults.join(" ")).toContain("2026-10-25T05:00:00.000Z");
      } else if (agent === PROJECT_TASK_AGENT) {
        expect(first?.tools).not.toContain("legalwork_assistant_delegate"); expect(first?.tools).not.toContain("legalwork_assistant_project_read"); expect(first?.tools).not.toContain("bash"); expect(first?.tools).not.toContain("read"); expect(first?.tools).not.toContain("task");
        for (const tool of ["projects", "session_search", "tasks", "calendar", "calendar_read", "file_search"]) expect(first?.tools).not.toContain(`legalwork_assistant_${tool}`);
        expect(last?.toolResults.join(" ")).toContain("cannot access that project"); expect(sourceReads).toEqual([]);
      } else {
        for (const tool of ["projects", "project_list", "project_read", "session_status", "tasks", "calendar", "calendar_read", "share_file"]) expect(first?.tools).toContain(`legalwork_assistant_${tool}`);
        for (const tool of ["get", "create"]) expect(first?.tools).toContain(`legalwork_task_${tool}`);
        expect(first?.tools).toContain("bash"); expect(last?.toolResults.join(" ")).toContain("Source message 22");
        expect(sourceReads).toEqual(["/workspace/other/project/content"]);
      }
    }
    expect(uiActions).toBe(0);
  } finally { engine.kill(); await engine.exited; fixture.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60000);
