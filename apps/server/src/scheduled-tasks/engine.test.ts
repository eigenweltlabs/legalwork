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
  let documentReads = 0;
  const modelRequests: { tools: string[]; toolDefinitions: string; toolResults: string[]; system: string; users: string[] }[] = [];
  const created: ScheduledTaskInput[] = [];
  const delegated: unknown[] = [];
  const sourceReads: string[] = [];
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/assistant") return Response.json({ workspace: { id: "matter", path: folder } });
    if (path === "/assistant/settings/context") return Response.json({ context: "Use the selected resource references in isolated research workers." });
    if (path === "/assistant/access") return Response.json({ projectIds: ["matter", "other"] });
    if (path === "/assistant/tool-access") return Response.json({ ok: true });
    if (path === "/assistant/delegate") { delegated.push(await request.json()); return Response.json({ ok: true, delegation: { workspaceId: "other", sessionId: "delegated-session", title: "Review agreement", scope: "Draft for review", status: "started" } }); }
    if (path === "/snapshot") return Response.json({ ok: true, route: "/unrelated-chat" });
    if (path === "/execute") {
      const input = z.object({ actionId: z.string(), args: z.unknown().optional() }).parse(await request.json());
      // Task document inventory is a background read, even though the bridge
      // dispatches it through the action endpoint. All other actions still fail
      // the no-foreground-actions assertion below.
      if (input.actionId === "documents.list") {
        expect(z.object({ sessionId: z.string().min(1) }).safeParse(input.args).success).toBe(true);
        documentReads++;
        return Response.json({ ok: true, result: { openFiles: [], surfaces: [], activeSurface: null } });
      }
      uiActions++; return Response.json({ ok: true });
    }
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: folder }, { id: "other", path: join(root, "other") }] });
    if (path === "/scheduled-tasks/projects") return Response.json({ projects: [{ id: "matter", name: "Matter", path: folder }, { id: "other", name: "Other", path: join(root, "other") }] });
    if (path === "/workspace/matter/scheduled-tasks" && request.method === "POST") {
      const input = ScheduledTaskInputSchema.parse(await request.json());
      created.push(input);
      return Response.json({ task: { ...input, nextRunAt: nextOccurrence(input.schedule, Date.parse("2026-10-24T12:00:00Z")) } });
    }
    if ((path === "/workspace/other/project/content" || path === "/assistant/projects/other/content") && transcriptSources) { sourceReads.push(path); return Response.json(await readProjectContent(transcriptSources, Object.fromEntries(new URL(request.url).searchParams))); }
    const input = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })), tools: z.array(z.object({ function: z.object({ name: z.string(), description: z.string().optional(), parameters: z.unknown().optional() }) })).optional() }).parse(await request.json());
    const tools = input.tools?.map(tool => tool.function.name) ?? [];
    const toolResults = input.messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content));
    const system = input.messages.filter(message => message.role === "system").map(message => JSON.stringify(message.content)).join(" ");
    const users = input.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content));
    if (tools.length) modelRequests.push({ tools, toolDefinitions: JSON.stringify(input.tools), toolResults, system, users });
    const morning = input.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("every morning"));
    const delegation = input.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Delegate this work"));
    const background = users.some(text => text.includes("Run research through a subagent"));
    const callTool = tools.length > 0 && toolResults.length < (morning ? 2 : 1);
    const call = background ? { name: "task", arguments: JSON.stringify({ subagent_type: "general", description: "Research fixture", prompt: "NATIVE_WORKER_REQUEST: Read the fixture source, then return a concise verified summary." }) } : delegation ? { name: "legalwork_assistant_delegate", arguments: JSON.stringify({ projectId: "other", title: "Review agreement", conversationLanguage: "en", prompt: "Review the liability clauses", scope: "Draft for review" }) } : morning
      ? toolResults.length === 0
        ? { name: "legalwork_schedule_clock", arguments: "{}" }
        : { name: "legalwork_schedule_create", arguments: JSON.stringify({ title: "Morning deadlines", prompt: "Review this project's deadlines.", schedule: { kind: "rrule", startAt: "2026-10-25T06:00:00", rrule: "FREQ=DAILY" } }) }
      : { name: "legalwork_schedule_project_read", arguments: JSON.stringify({ projectId: "other", kind: "sessions", id: sourceSessionId }) };
    // Let the live engine clock advance before its next model step.
    if (callTool && call.name === "legalwork_schedule_clock") await Bun.sleep(1100);
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
    permission: { "*": "allow" }, lsp: false, formatter: false,
    agent: { [PROJECT_TASK_AGENT]: { mode: "primary", hidden: true, permission: projectTaskPermissions() }, [ALL_PROJECTS_TASK_AGENT]: { mode: "primary", hidden: true, permission: allProjectTaskPermissions() } },
  }));
  const discovery = join(root, "ui-bridge.json");
  await writeFile(discovery, JSON.stringify({ baseUrl: fixture.url.origin, token: "fixture" }));
  const engine = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: folder, env: {
    ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"), OPENCODE_TEST_HOME: root, OPENCODE_CONFIG: config, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    LEGALWORK_UI_CONTROL_DISCOVERY: discovery, LEGALWORK_SERVER_URL: fixture.url.origin, LEGALWORK_SERVER_TOKEN: "fixture", TZ: "Europe/Berlin",
  }, stdout: "ignore", stderr: "pipe" });
  const logs = new Response(engine.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    const startupDeadline = Date.now() + 20000;
    while (Date.now() < startupDeadline) {
      try { ready = (await fetch(base + "/global/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Startup. */ }
      if (ready || engine.exitCode !== null) break;
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("Engine did not start: " + (engine.exitCode !== null ? await logs : "timed out"));
    const client = createOpencodeClient({ baseUrl: base, directory: otherFolder });
    // Health only confirms the listener. The first request in each directory
    // also loads plugins and installs their dependencies on a cold CI runner.
    // Finish that read-only bootstrap before applying the 10s write deadline.
    for (const directory of [otherFolder, folder]) {
      try {
        await client.app.agents({ directory }, { throwOnError: true, signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        engine.kill("SIGKILL");
        await engine.exited;
        throw new Error(`Engine bootstrap failed for ${directory}: ${await logs}`, { cause: error });
      }
    }
    const { data: sourceSession } = await client.session.create({ title: "Other project chat" }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
    sourceSessionId = sourceSession.id;
    for (let i = 0; i < 23; i++) await client.session.prompt({ sessionID: sourceSession.id, noReply: true, parts: [{ type: "text", text: `Source message ${i}: Continue the contract review.` }] }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
    transcriptSources = {
      workspace: { id: "other", name: "Other", path: otherFolder, preset: "default", workspaceType: "local" }, tasks, orgId: null,
      sessions: async () => [],
      session: async id => (await client.session.get({ sessionID: id }, { throwOnError: true, signal: AbortSignal.timeout(10000) })).data,
      sessionMessages: async (id, limit, before) => { const result = await client.session.messages({ sessionID: id, limit, before }, { throwOnError: true, signal: AbortSignal.timeout(10000) }); return { messages: result.data, nextBefore: result.response.headers.get("x-next-cursor") }; },
    };
    const recent = await readProjectContent(transcriptSources, { kind: "sessions", id: sourceSession.id });
    expect(recent.content).toContain("Source message 22");
    expect(recent.content).not.toContain("Source message 0:");
    expect(recent.nextBefore).not.toBeNull();
    const older = await readProjectContent(transcriptSources, { kind: "sessions", id: sourceSession.id, before: recent.nextBefore });
    expect(older.content).toContain("Source message 0:"); expect(older.nextBefore).toBeNull();
    expect(recent.content.split("\n").length + older.content.split("\n").length).toBe(23);
    const agentsResponse = await fetch(base + "/agent", { signal: AbortSignal.timeout(10000) });
    const agents = z.array(z.object({ name: z.string(), permission: z.array(z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "deny", "ask"]) })) })).parse(await agentsResponse.json());
    expect(hasProjectTaskBoundary(agents.find(agent => agent.name === PROJECT_TASK_AGENT)), JSON.stringify(agents.find(agent => agent.name === PROJECT_TASK_AGENT)?.permission.slice(-20))).toBe(true);
    for (const agent of [PROJECT_TASK_AGENT, ALL_PROJECTS_TASK_AGENT, "build", "assistant-delegation"]) {
      const requestStart = modelRequests.length;
      const session = z.object({ id: z.string() }).parse(await (await fetch(base + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10000) })).json());
      const response = await fetch(`${base}/session/${session.id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: agent === "assistant-delegation" ? "build" : agent, model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: agent === "assistant-delegation" ? "Delegate this work to the other project." : agent === "build" ? "Remind me of this project's deadlines every morning." : "Run the scope fixture." }] }), signal: AbortSignal.timeout(25000) });
      const result = await response.text();
      expect(response.status, result).toBe(200);
      const requests = modelRequests.slice(requestStart), first = requests[0], last = requests.at(-1);
      expect(first?.tools).toContain("legalwork_schedule_project_read");
      expect(first?.tools).toContain("legalwork_schedule_clock");
      expect(first?.users.join(" ")).toContain('topic=\\"scheduling-clock\\"');
      expect(first?.users.join(" ")).toContain("time zone Europe/Berlin");
      expect(first?.system).not.toContain("Scheduling clock at the start of this user turn");
      expect(last?.system).toBe(first?.system);
      expect(last?.toolDefinitions).toBe(first?.toolDefinitions);
      expect(last?.users).toEqual(first?.users);
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
        expect(requests).toHaveLength(3);
        expect(last?.toolResults.join(" ")).toContain("currentTime");
        expect(last?.toolResults.join(" ")).toContain("Europe/Berlin");
        expect(first?.system).toContain("Do not ask the user for their time zone");
        expect(first?.system).toContain("use 06:00, starting at the next future morning");
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ sessionId: session.id, reuseChat: true, projectAccess: "project", model: { providerID: "fixture", modelID: "fixture" }, schedule: { timeZone: "Europe/Berlin", startAt: "2026-10-25T06:00:00" } });
        expect(last?.toolResults.join(" ")).toContain("2026-10-25T05:00:00.000Z");
        const followUp = await fetch(`${base}/session/${session.id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Continue." }] }), signal: AbortSignal.timeout(25000) });
        expect(followUp.status, await followUp.text()).toBe(200);
        const next = modelRequests.at(-1);
        expect(next?.system).toBe(first?.system);
        expect(next?.toolDefinitions).toBe(first?.toolDefinitions);
        expect(next?.users.slice(0, first.users.length)).toEqual(first.users);
        expect(next?.users.at(-1)).toContain('topic=\\"scheduling-clock\\"');
        expect(next?.users.at(-1)).not.toBe(first.users.at(-1));
      } else if (agent === PROJECT_TASK_AGENT) {
        expect(first?.tools).not.toContain("legalwork_assistant_delegate"); expect(first?.tools).not.toContain("legalwork_assistant_project_read"); expect(first?.tools).not.toContain("bash"); expect(first?.tools).not.toContain("read"); expect(first?.tools).not.toContain("task");
        for (const tool of ["projects", "session_search", "tasks", "calendar", "calendar_read", "file_search"]) expect(first?.tools).not.toContain(`legalwork_assistant_${tool}`);
        expect(last?.toolResults.join(" ")).toContain("cannot access that project"); expect(sourceReads).toEqual([]);
      } else {
        for (const tool of ["projects", "project_list", "project_read", "session_status", "tasks", "calendar", "calendar_read", "share_file"]) expect(first?.tools).toContain(`legalwork_assistant_${tool}`);
        for (const tool of ["get", "create"]) expect(first?.tools).toContain(`legalwork_task_${tool}`);
        expect(first?.tools).toContain("bash"); expect(last?.toolResults.join(" ")).toContain("Source message 22");
        expect(sourceReads).toEqual(["/assistant/projects/other/content"]);
      }
    }
    // A real child session starts with empty history; the parent link does not clone context.
    const parent = await client.session.create({ title: "Daily coordinator" }, { throwOnError: true });
    await client.session.prompt({ sessionID: parent.data.id, noReply: true, parts: [{ type: "text", text: "PRIVATE_PARENT_CONTEXT_MARKER" }] }, { throwOnError: true });
    const worker = await client.session.create({ parentID: parent.data.id, title: "Isolated scheduled research" }, { throwOnError: true });
    expect(worker.data.parentID).toBe(parent.data.id);
    expect((await client.session.messages({ sessionID: worker.data.id }, { throwOnError: true })).data).toEqual([]);
    const firstWorkerRequest = modelRequests.length;
    await client.session.prompt({ sessionID: worker.data.id, agent: ALL_PROJECTS_TASK_AGENT, model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Read the fixture source in this isolated worker." }] }, { throwOnError: true, signal: AbortSignal.timeout(25000) });
    expect(modelRequests.length).toBeGreaterThan(firstWorkerRequest);
    expect(modelRequests.slice(firstWorkerRequest).every(request => !request.users.join(" ").includes("PRIVATE_PARENT_CONTEXT_MARKER"))).toBe(true);
    expect((await client.session.messages({ sessionID: parent.data.id }, { throwOnError: true })).data).toHaveLength(1);
    const nativeStart = modelRequests.length;
    await client.session.prompt({ sessionID: parent.data.id, agent: ALL_PROJECTS_TASK_AGENT, model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Run research through a subagent." }] }, { throwOnError: true, signal: AbortSignal.timeout(25000) });
    const nativeRequests = modelRequests.slice(nativeStart);
    const childRequests = nativeRequests.filter(request => request.users.some(text => text.includes("NATIVE_WORKER_REQUEST")));
    expect(childRequests.length).toBeGreaterThan(0);
    expect(childRequests.every(request => !request.users.join(" ").includes("PRIVATE_PARENT_CONTEXT_MARKER"))).toBe(true);
    const coordinatorRequests = nativeRequests.filter(request => request.users.some(text => text.includes("Run research through a subagent")));
    expect(coordinatorRequests.length).toBeGreaterThan(1);
    expect(coordinatorRequests.every(request => !request.toolResults.join(" ").includes("Source message 22"))).toBe(true);
    expect(uiActions).toBe(0);
    expect(documentReads).toBeGreaterThan(0);
  } finally { engine.kill("SIGKILL"); await engine.exited; fixture.stop(true); await rm(root, { recursive: true, force: true }); }
}, 180000);
