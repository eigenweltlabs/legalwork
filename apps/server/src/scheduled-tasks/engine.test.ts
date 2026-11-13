import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { OpenCode } from "@opencode/client";
import { ScheduledTaskInputSchema, ScheduledTaskSchema, type ScheduledTaskInput } from "@legalwork/types/scheduled-tasks";
import { ALL_PROJECTS_TASK_AGENT, PROJECT_TASK_AGENT, hasProjectTaskBoundary, projectTaskPermissions, allProjectTaskPermissions } from "./access.js";
import { nativePermissions } from "../native-opencode-config.js";
import { TaskStore } from "../task-store.js";
import { readProjectContent, type ProjectContentSources } from "../project-contents.js";
import { nextOccurrence } from "./schedule.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const jsonObject = z.record(z.string(), z.unknown());
const requestSchema = z.object({
  instructions: z.string().optional(), input: z.array(jsonObject),
  tools: z.array(z.object({ name: z.string() })).optional(),
});
// Discovery runs inside the real native interpreter and follows every page.
const catalogCode = 'const names = []; let offset = 0; while (true) { const page = search({limit: 200, offset}); for (const item of page.items) names.push(item.path); if (!page.next) break; offset = page.next.offset; }';

// Uses only an isolated engine, loopback provider and fake service. No live account or model.
test.skipIf(!binary)("real native engine preserves scheduled project scope, full chat paging and local scheduling defaults", async () => {
  if (!binary) throw new Error("An isolated OpenCode binary is required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "schedule-engine-")));
  for (const name of ["matter", "other", "home", "config", "data", "cache", "state", "tmp"]) await mkdir(join(root, name));
  const folder = join(root, "matter"), otherFolder = join(root, "other");
  const tasks = await TaskStore.open(join(root, "tasks.sqlite"), join(root, "attachments"));
  let transcriptSources: ProjectContentSources | undefined;
  let sourceSessionId = "";
  let scenario: "project" | "all" | "morning" | "followup" = "project";
  let stage = 0, responseId = 0, uiActions = 0, documentReads = 0;
  const modelRequests: Array<{ tools: string[]; definitions: string; results: string[]; system: string; users: string[] }> = [];
  const created: ScheduledTaskInput[] = [];
  const sourceReads: string[] = [];
  const token = randomBytes(32).toString("hex");
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/assistant") return Response.json({ workspace: null });
    if (path === "/snapshot") return Response.json({ ok: true, route: "/unrelated-chat" });
    if (path === "/execute") {
      const input = z.object({ actionId: z.string(), args: z.unknown().optional() }).parse(await request.json());
      if (input.actionId === "documents.list") {
        expect(z.object({ sessionId: z.string().min(1) }).safeParse(input.args).success).toBe(true);
        documentReads++;
        return Response.json({ ok: true, result: { openFiles: [], surfaces: [], activeSurface: null } });
      }
      uiActions++;
      return Response.json({ ok: true });
    }
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: folder }, { id: "other", path: otherFolder }] });
    if (path === "/scheduled-tasks/projects") return Response.json({ projects: [{ id: "matter", name: "Matter", path: folder }, { id: "other", name: "Other", path: otherFolder }] });
    if (path === "/workspace/matter/scheduled-tasks" && request.method === "POST") {
      const input = ScheduledTaskInputSchema.parse(await request.json());
      created.push(input);
      return Response.json({ task: ScheduledTaskSchema.parse({ ...input, id: randomUUID(), workspaceId: "matter", revision: 1, status: "active", createdAt: "2026-10-24T12:00:00Z", updatedAt: "2026-10-24T12:00:00Z", nextRunAt: nextOccurrence(input.schedule, Date.parse("2026-10-24T12:00:00Z")) }) });
    }
    if (path === "/workspace/other/project/content" && transcriptSources) {
      sourceReads.push(path);
      return Response.json(await readProjectContent(transcriptSources, Object.fromEntries(url.searchParams)));
    }
    const input = requestSchema.parse(await request.json());
    const tools = input.tools?.map(tool => tool.name) ?? [];
    const primary = tools.includes("execute");
    if (primary) modelRequests.push({
      tools, definitions: JSON.stringify(input.tools),
      results: input.input.filter(item => item.type === "function_call_output").map(item => String(item.output)),
      system: [input.instructions, ...input.input.filter(item => item.role === "system" || item.role === "developer").map(item => JSON.stringify(item.content))].filter(Boolean).join("\n"),
      users: input.input.filter(item => item.role === "user").map(item => JSON.stringify(item.content)),
    });
    let code: string | undefined;
    if (primary && scenario !== "followup") {
      if (scenario === "morning") {
        if (stage === 0) {
          await Bun.sleep(1100); // Verify the on-demand clock can advance beyond admission.
          code = `${catalogCode} return {catalog:names, clock:await tools.legalwork_schedule_clock({})};`;
        } else if (stage === 1) {
          code = 'return await tools.legalwork_schedule_create({title:"Morning deadlines",prompt:"Review this project deadlines.",schedule:{kind:"rrule",startAt:"2026-10-25T06:00:00",rrule:"FREQ=DAILY"}});';
        }
      } else if (stage === 0) {
        code = `${catalogCode} return {catalog:names, source:await tools.legalwork_schedule_project_read({projectId:"other",kind:"sessions",id:${JSON.stringify(sourceSessionId)}})};`;
      }
      stage++;
    }
    const id = `resp_fixture_${++responseId}`;
    const item = code
      ? { type: "function_call", id: `fc_${responseId}`, call_id: `call_${responseId}`, name: "execute", arguments: JSON.stringify({ code }), status: "completed" }
      : { type: "message", id: `msg_${responseId}`, role: "assistant", content: [{ type: "output_text", text: "Finished the fixture check." }], status: "completed" };
    const events = [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: code ? { ...item, arguments: "" } : item },
      ...(code ? [
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
      ] : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let logs = "";
  try {
    const plugins: string[] = [];
    for (const name of ["legalwork-scheduled-task-tools", "legalwork-extensions-preview"]) {
      const outdir = join(root, "plugins", name);
      await mkdir(outdir, { recursive: true });
      // Build in a clean Bun process: the test runner's loaded schema modules can
      // otherwise collide with Bun's in-process bundler cache.
      const build = Bun.spawn([process.execPath, "build", resolve(import.meta.dir, "../opencode-plugins", `${name}.ts`), "--outfile", join(outdir, "index.mjs"), "--target", "node", "--format", "esm", "--external", "@opencode/plugin", "--external", "@opencode/plugin/*", "--external", "effect", "--external", "effect/*"], { stdout: "pipe", stderr: "pipe" });
      const [code, output, errors] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
      if (code !== 0) throw new Error(`Plugin build failed: ${output}\n${errors}`);
      plugins.push(outdir);
    }
    const discovery = join(root, "ui-bridge.json");
    await writeFile(discovery, JSON.stringify({ baseUrl: fixture.url.origin, token }));
    const engineConfig = {
      plugins, model: "openai/fixture", share: "disabled", update: "disable",
      providers: { openai: { settings: { baseURL: `${fixture.url.origin}/v1`, apiKey: "fixture", transport: "http" }, models: { fixture: { modelID: "fixture", limit: { context: 200000, output: 32000 }, capabilities: { tools: true } } } } },
      permissions: nativePermissions("allow"),
      agents: {
        [PROJECT_TASK_AGENT]: { mode: "primary", hidden: true, permissions: projectTaskPermissions() },
        [ALL_PROJECTS_TASK_AGENT]: { mode: "primary", hidden: true, permissions: allProjectTaskPermissions([{ action: "*", resource: "*", effect: "allow" }]) },
        legalwork: { mode: "primary", permissions: nativePermissions("allow") },
      },
    };
    const password = randomBytes(32).toString("hex");
    const running = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: folder, env: {
      PATH: process.env.PATH, HOME: join(root, "home"), USERPROFILE: join(root, "home"), TMPDIR: join(root, "tmp"), LANG: "en_US.UTF-8", TZ: "Europe/Berlin",
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "data", "engine.db"), OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(engineConfig),
      OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      LEGALWORK_UI_CONTROL_DISCOVERY: discovery, LEGALWORK_SERVER_URL: fixture.url.origin, LEGALWORK_SERVER_TOKEN: token,
    }, stdio: ["ignore", "pipe", "pipe"] });
    child = running;
    exited = new Promise(resolve => running.once("exit", resolve));
    running.stdout.on("data", data => logs += data);
    running.stderr.on("data", data => logs += data);
    let base: string | undefined;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      base = /^server listening on (https?:\/\/[^\s]+)/m.exec(logs)?.[1];
      if (base) break;
      if (running.exitCode !== null) throw new Error(`Engine exited: ${logs}`);
      await Bun.sleep(30);
    }
    if (!base) throw new Error(`Engine did not start: ${logs}`);
    const client = OpenCode.make({ baseUrl: base, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
    // Match scheduledRunner.send: model discovery awaits native plugin activation;
    // agent metadata alone can return before configured agents are registered.
    for (const directory of [otherFolder, folder]) await client.model.list({ location: { directory } }, { signal: AbortSignal.timeout(15000) });
    const empty = await client.session.create({ location: { directory: otherFolder }, title: "Other project chat" });
    await client.session.remove({ sessionID: empty.id });
    const sourceSession = await client.session.import({ info: empty, location: { directory: otherFolder }, messages: Array.from({ length: 23 }, (_, index) => ({ type: "user", id: `msg_source_${index}`, time: { created: index + 1 }, text: `Source message ${index}: Continue the contract review.` })) });
    sourceSessionId = sourceSession.id;
    transcriptSources = {
      workspace: { id: "other", name: "Other", path: otherFolder, preset: "default", workspaceType: "local" }, tasks, orgId: null,
      sessions: async () => [],
      session: id => client.session.get({ sessionID: id }),
      sessionMessages: async (id, limit, before) => {
        const page = await client.message.list({ sessionID: id, limit, ...(before ? { cursor: before } : { order: "desc" }) });
        return { sessionID: id, messages: [...page.data].reverse(), nextBefore: page.cursor.next ?? null };
      },
    };
    const recent = await readProjectContent(transcriptSources, { kind: "sessions", id: sourceSession.id });
    expect(recent.content).toContain("Source message 22");
    expect(recent.content).not.toContain("Source message 0:");
    expect(recent.nextBefore).not.toBeNull();
    const older = await readProjectContent(transcriptSources, { kind: "sessions", id: sourceSession.id, before: recent.nextBefore });
    expect(older.content).toContain("Source message 0:");
    // Native cursors can point to a final empty page; follow the cursor instead
    // of assuming a short page means the engine has omitted history.
    const end = await readProjectContent(transcriptSources, { kind: "sessions", id: sourceSession.id, before: older.nextBefore });
    expect(end.nextBefore).toBeNull();
    expect(end.content).toBe("");
    expect([recent.content, older.content, end.content].flatMap(text => text.split("\n").filter(Boolean))).toHaveLength(23);
    const agents = (await client.agent.list({ location: { directory: folder } })).data;
    const projectAgent = agents.find(agent => agent.id === PROJECT_TASK_AGENT);
    expect(hasProjectTaskBoundary(projectAgent), JSON.stringify({ projectAgent, availableAgentIds: agents.map(agent => agent.id) })).toBe(true);
    for (const agent of [PROJECT_TASK_AGENT, ALL_PROJECTS_TASK_AGENT, "legalwork"]) {
      scenario = agent === PROJECT_TASK_AGENT ? "project" : agent === ALL_PROJECTS_TASK_AGENT ? "all" : "morning";
      stage = 0;
      const requestStart = modelRequests.length;
      const session = await client.session.create({ location: { directory: folder }, title: "Scheduling fixture", agent, model: { providerID: "openai", id: "fixture" } });
      await client.session.prompt({ sessionID: session.id, text: scenario === "morning" ? "Remind me of this project's deadlines every morning." : "Run the scope fixture." });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(25000) });
      const requests = modelRequests.slice(requestStart), first = requests[0], last = requests.at(-1);
      expect(first?.tools).toContain("execute");
      expect(first?.users.join(" ")).toContain("scheduling-clock");
      expect(first?.users.join(" ")).toContain("time zone Europe/Berlin");
      expect(first?.system).not.toContain("Scheduling clock at the start of this user turn");
      expect(last?.system).toBe(first?.system);
      expect(last?.definitions).toBe(first?.definitions);
      expect(last?.users).toEqual(first?.users);
      const output = z.object({ catalog: z.array(z.string()) }).passthrough().parse(JSON.parse(last?.results[0] ?? "null"));
      expect(output.catalog).toContain("tools.legalwork_schedule_project_read");
      expect(output.catalog).toContain("tools.legalwork_schedule_clock");
      if (agent !== "legalwork") for (const name of ["legalwork_ui_execute_action", "legalwork_ui_snapshot", "legalwork_ui_list_actions"]) expect(output.catalog).not.toContain(`tools.${name}`);
      if (agent === "legalwork") {
        expect(output.catalog).toContain("tools.legalwork_schedule_create");
        expect(requests).toHaveLength(3);
        expect(last?.results.join(" ")).toContain("currentTime");
        expect(last?.results.join(" ")).toContain("Europe/Berlin");
        expect(first?.system).toContain("Do not ask the user for their time zone");
        expect(first?.system).toContain("use 06:00, starting at the next future morning");
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ sessionId: session.id, reuseChat: true, projectAccess: "project", model: { providerID: "openai", modelID: "fixture" }, schedule: { timeZone: "Europe/Berlin", startAt: "2026-10-25T06:00:00" } });
        expect(last?.results.join(" ")).toContain("2026-10-25T05:00:00.000Z");
        scenario = "followup";
        await client.session.prompt({ sessionID: session.id, text: "Continue." });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(25000) });
        const next = modelRequests.at(-1);
        expect(next?.system).toBe(first?.system);
        expect(next?.definitions).toBe(first?.definitions);
        expect(next?.users.slice(0, first.users.length)).toEqual(first.users);
        expect(next?.users.at(-1)).toContain("scheduling-clock");
        expect(next?.users.at(-1)).not.toBe(first.users.at(-1));
      } else if (agent === PROJECT_TASK_AGENT) {
        for (const name of ["shell", "read", "subagent"]) { expect(output.catalog).not.toContain(`tools.${name}`); expect(first?.tools).not.toContain(name); }
        expect(last?.results.join(" ")).toContain("cannot access that project");
        expect(sourceReads).toEqual([]);
      } else {
        expect(first?.tools).toContain("shell");
        expect(last?.results.join(" ")).toContain("Source message 22");
        expect(sourceReads).toEqual(["/workspace/other/project/content"]);
      }
    }
    expect(uiActions).toBe(0);
    expect(documentReads).toBeGreaterThan(0);
  } catch (error) {
    throw new Error("Native scheduled-task fixture failed", { cause: error });
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    fixture.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
