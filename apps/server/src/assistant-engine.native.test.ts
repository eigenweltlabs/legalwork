import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { codeModeWidgetResults } from "@legalwork/types/chat-tool-results";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { assistantEngineClient } from "./assistant-engine.js";
import { nativeChatResponse, nativeDomainEngine } from "./opencode-plugins/native-domain-engine.test-support.js";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { exportCheckpoint } from "./cloud-sync/state.js";
import { DirectoryObjects, getBlob } from "./cloud-sync/objects.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { channelLiveEvents } from "./channel-live-events.js";

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const session = { id: "session", projectID: "project", location: { directory: "/project" }, model: { providerID: "fixture", id: "model" }, cost: 0, tokens, time: { created: 1, updated: 1 } };

test("Assistant uses only native admission, retains identity and hidden context, and pages across the human boundary", async () => {
  const requests: Array<{ method: string; url: URL; body: unknown }> = [];
  const engine = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url), body: unknown = request.body ? await request.json() : null;
    requests.push({ method: request.method, url, body });
    if (url.pathname === "/api/session/session/model" || url.pathname === "/api/session/session/agent") return new Response(null, { status: 204 });
    if (url.pathname === "/api/session/session/prompt") return Response.json({ data: { id: "human", type: "user", time: { created: 1 }, text: "Find the source", delivery: "queue" } });
    if (url.pathname === "/api/session/session") return Response.json({ data: session });
    if (url.pathname === "/api/session/session/message") return Response.json({ data: url.searchParams.has("cursor")
      ? [{ id: "human", type: "user", text: "Find the source", time: { created: 1 }, metadata: { legalworkPrompt: { visibleText: "Find the source", reminders: ["private runtime hint"] } } }]
      : [{ id: "reply", type: "assistant", agent: "legalwork", model: session.model, time: { created: 2, completed: 3 }, finish: "stop", content: [{ type: "text", text: "Complete answer" }] }], cursor: { next: url.searchParams.has("cursor") ? null : "older", previous: null } });
    return new Response("Unexpected native operation", { status: 500 });
  } });
  const client = assistantEngineClient(OpenCode.make({ baseUrl: engine.url.origin }), "/project");
  try {
    await client.session.promptAsync({ sessionID: "session", messageID: "human", agent: "legalwork", model: { providerID: "fixture", modelID: "model" }, parts: [
      { type: "text", text: "Find the source", metadata: { legalworkAssistantSender: "mobile" } }, { type: "text", text: "private runtime hint", synthetic: true },
    ] }, { throwOnError: true });
    expect(requests.find(row => row.url.pathname.endsWith("/prompt"))?.body).toMatchObject({ id: "human", text: "Find the source\n\nprivate runtime hint", delivery: "queue", resume: true,
      metadata: { legalworkAssistantSender: "mobile", legalworkPrompt: { visibleText: "Find the source", reminders: ["private runtime hint"] } } });
    const history = await client.session.messages({ sessionID: "session", limit: 1 }, { throwOnError: true });
    expect(history.data?.[0].info.parentID).toBe("human");
    expect(channelLiveEvents(history.data ?? [], "human")).toMatchObject([{ event: { type: "message.created", text: "Complete answer" } }]);
    expect(requests.filter(row => row.url.pathname.endsWith("/message"))).toHaveLength(2);
    expect(requests.every(row => row.url.pathname.startsWith("/api/"))).toBe(true);
  } finally { engine.stop(true); }
});

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("released v2 executes Assistant naming and file sharing through Code Mode and retains their cards", async () => {
  let turns = 0;
  let firstTools: string[] = [];
  const actions = [
    { name: "execute", input: { code: 'return await tools.legalwork_assistant_react({emoji:"👀"});' } },
    { name: "execute", input: { code: 'await tools.legalwork_assistant_share_file({path:"briefing.md",title:"Morning briefing"}); await tools.legalwork_assistant_set_name({name:"Maya"}); return "done";' } },
  ];
  const provider = Bun.serve({ port: 0, async fetch(request) {
    const body = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })).default([]) }).parse(await request.json());
    if (turns === 0) firstTools = body.tools.map(tool => tool.function.name);
    return nativeChatResponse(actions[turns++], turns);
  } });
  const fixture = await nativeDomainEngine({ binary: binary!, plugins: [new URL("./opencode-plugins/legalwork-assistant-tools.ts", import.meta.url).pathname], modelURL: provider.url.origin + "/v1",
    directTools: false,
    setup: async (config, root) => { config.projectsDirectory = root; config.workspaces[0].preset = "main-assistant"; await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active" }) }); },
  });
  try {
    await writeFile(join(fixture.directory, "briefing.md"), "# Morning briefing\nCheck the agreement.");
    const client = assistantEngineClient(fixture.appClient, fixture.directory);
    const created = await client.session.create({ title: "Native Assistant smoke" }, { throwOnError: true });
    const sessionID = created.data!.id;
    const greeting = await fetch(fixture.serverURL + "/assistant/onboarding/view", { method: "POST", headers: { authorization: `Bearer ${fixture.config.token}` } });
    expect(greeting.ok).toBe(true);
    await client.session.promptAsync({ sessionID, messageID: "msg_native_assistant_smoke", agent: "build", model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Look into my request and reply." }] }, { throwOnError: true });
    let events: ReturnType<typeof channelLiveEvents> = [];
    for (let i = 0; i < 300; i++) {
      const rows = (await client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })).data!;
      events = channelLiveEvents(rows, "msg_native_assistant_smoke");
      if (events.some(row => row.event.type === "message.created")) break;
      await Bun.sleep(50);
    }
    const rows = (await client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })).data!;
    expect(firstTools).toContain("execute");
    for (const name of ["legalwork_assistant_share_file", "legalwork_assistant_delegate", "legalwork_assistant_set_name", "legalwork_assistant_attention_present", "legalwork_assistant_attention_answer"]) expect(firstTools).not.toContain(name);
    expect(firstTools).not.toContain("legalwork_assistant_projects");
    const reaction = rows.flatMap(row => row.parts).find(part => part.type === "tool" && part.tool === "execute");
    expect(reaction).toMatchObject({ type: "tool", state: { status: "completed" } });
    if (reaction?.type !== "tool" || reaction.state.status !== "completed") throw new Error("Native reaction did not complete.");
    expect(codeModeWidgetResults(reaction.callID, reaction.state.metadata, reaction.state.output)).toMatchObject([{ tool: "legalwork_assistant_react", output: { reaction: { messageId: "msg_native_assistant_smoke", emoji: "👀" } } }]);
    const widgets = rows.flatMap(row => row.parts).flatMap(part => part.type === "tool" && part.tool === "execute" && part.state.status === "completed"
      ? codeModeWidgetResults(part.callID, part.state.metadata, part.state.output) : []);
    expect(widgets).toMatchObject([
      { tool: "legalwork_assistant_react", output: { reaction: { emoji: "👀" } } },
      { tool: "legalwork_assistant_share_file", output: { ok: true, file: { path: "briefing.md", title: "Morning briefing" } } },
      { tool: "legalwork_assistant_set_name", output: { ok: true, showAvatarPicker: true, onboarding: { name: "Maya", step: "avatar" } } },
    ]);
    const profile = await fetch(fixture.serverURL + "/assistant", { headers: { authorization: `Bearer ${fixture.config.token}` } }).then(response => response.json());
    expect(profile).toMatchObject({ profile: { name: "Maya" } });
    expect(rows.flatMap(row => row.parts).filter(part => part.type === "tool").map(part => part.tool)).toEqual(actions.map(action => action.name));
    expect(rows.at(-1)?.parts).toMatchObject(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Fixture checked." })]));
    expect(turns).toBe(3);
    const foreign = await fixture.client.session.create({ location: { directory: join(fixture.root, "home") }, title: "Unrelated standalone chat" });
    const previousDB = process.env.OPENCODE_DB;
    const objects = await DirectoryObjects.open(join(fixture.root, "objects"));
    let restored: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
    try {
      process.env.OPENCODE_DB = join(fixture.root, "engine.db");
      const checkpoint = await exportCheckpoint(fixture.config, objects, { companionSeed: true });
      const copy = join(fixture.root, "cloud-engine.db"); await getBlob(objects, checkpoint.engine!, copy);
      const snapshot = new Database(copy, { readonly: true });
      try {
        expect(snapshot.query("SELECT id FROM session_v2 WHERE id = ?").get(sessionID)).toEqual({ id: sessionID });
        expect(snapshot.query("SELECT id FROM session_v2 WHERE id = ?").get(foreign.id)).toBeNull();
        expect(snapshot.query("SELECT id FROM credential").all()).toEqual([]);
        expect(snapshot.query("SELECT id FROM session_inbox").all()).toEqual([]);
      } finally { snapshot.close(); }
      restored = await createManagedOpencodeServer({ bin: binary!, cwd: fixture.directory, timeoutMs: 30000, env: {
        HOME: join(fixture.root, "home"), XDG_CONFIG_HOME: join(fixture.root, "config"), XDG_DATA_HOME: join(fixture.root, "data"), XDG_STATE_HOME: join(fixture.root, "state"), XDG_CACHE_HOME: join(fixture.root, "cache"),
        OPENCODE_DB: copy, OPENCODE_CONFIG_DIR: join(fixture.root, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false }),
      } });
      const reader = assistantEngineClient(OpenCode.make({ baseUrl: restored.url, headers: { authorization: `Basic ${Buffer.from(`${restored.username}:${restored.password}`).toString("base64")}` } }), fixture.directory);
      const restoredHistory = (await reader.session.messages({ sessionID }, { throwOnError: true })).data!;
      expect(channelLiveEvents(restoredHistory, "msg_native_assistant_smoke").map(row => row.event.type)).toContain("reaction.changed");
      expect(restoredHistory.at(-1)?.parts).toMatchObject(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Fixture checked." })]));
    } finally { await restored?.close(); objects.close(); if (previousDB === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previousDB; }

  } finally { await fixture.close(); provider.stop(true); }
}, 45_000);

test.skipIf(!binary)("released v2 admits delegated work and delivers a busy follow-up once with its original identity", async () => {
  let turns = 0;
  let releaseFirst: () => void = () => {};
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  const provider = Bun.serve({ port: 0, async fetch() {
    const turn = ++turns;
    if (turn === 1) await firstResponse;
    return nativeChatResponse(undefined, turn);
  } });
  const fixture = await nativeDomainEngine({ binary: binary!, plugins: [], modelURL: provider.url.origin + "/v1",
    configuration: { agents: { legalwork: {} } },
    setup: async (config, root) => {
      const directory = join(root, "assistant");
      await mkdir(directory);
      config.projectsDirectory = root;
      await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active" }) });
      config.authorizedRoots.push(directory);
      config.workspaces.push({ id: "assistant", name: "Assistant", path: directory, preset: "main-assistant", workspaceType: "local" });
    },
  });
  const call = (path: string, body: unknown) => fetch(fixture.serverURL + path, { method: "POST",
    headers: { authorization: `Bearer ${fixture.config.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const receiptSchema = z.object({ ok: z.literal(true), message: z.object({ id: z.string(), state: z.string() }) });
  try {
    const source = await fixture.client.session.create({ location: { directory: join(fixture.root, "assistant") }, title: "Delegation source" });
    const response = await call("/assistant/delegate", { sourceWorkspaceId: "assistant", sourceSessionId: source.id, workspaceId: "matter",
      title: "Check the fixture", prompt: "Check the fixture and reply briefly.", scope: "Synthetic fixture only.", conversationLanguage: "en",
      model: { providerID: "fixture", modelID: "fixture" } });
    expect(response.status).toBe(200);
    const { delegation } = z.object({ ok: z.literal(true), delegation: z.object({ sessionId: z.string(), status: z.literal("started") }) }).parse(await response.json());
    for (let i = 0; turns === 0 && i < 100; i++) await Bun.sleep(50);
    expect(turns).toBe(1);
    const target = { workspaceId: "matter", sessionId: delegation.sessionId, sourceSessionId: source.id };
    const followUp = { ...target, prompt: "Also check the second fixture.", requestId: "native-follow-up-once" };
    const queued = receiptSchema.parse(await (await call("/assistant/follow-up", followUp)).json());
    expect(queued.message.state).toBe("queued");
    releaseFirst();
    let history = await fixture.client.message.list({ sessionID: delegation.sessionId, limit: 100 });
    for (let i = 0; i < 400; i++) {
      history = await fixture.client.message.list({ sessionID: delegation.sessionId, limit: 100 });
      if (history.data.filter(message => message.type === "assistant" && message.finish === "stop").length === 2) break;
      await Bun.sleep(50);
    }
    expect(history.data.filter(message => message.type === "assistant" && message.finish === "stop")).toHaveLength(2);
    const humans = history.data.filter(message => message.type === "user");
    expect(humans).toHaveLength(2);
    expect(humans.find(message => message.id === queued.message.id)?.text).toBe(followUp.prompt);
    const replay = receiptSchema.parse(await (await call("/assistant/follow-up", followUp)).json());
    expect(replay.message).toMatchObject({ id: queued.message.id, state: "sent" });
    const finalHistory = await fixture.client.message.list({ sessionID: delegation.sessionId, limit: 100 });
    expect(finalHistory.data.filter(message => message.type === "user")).toHaveLength(2);
  } finally { releaseFirst(); await fixture.close(); provider.stop(true); }
}, 60_000);
