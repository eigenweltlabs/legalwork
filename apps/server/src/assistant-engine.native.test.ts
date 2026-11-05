import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
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
test.skipIf(!binary)("released v2 runs the native Assistant reaction tool and returns public chat output through the app proxy", async () => {
  let turns = 0;
  const provider = Bun.serve({ port: 0, fetch() {
    return nativeChatResponse(turns++ === 0 ? { name: "legalwork_assistant_react", input: { emoji: "👀" } } : undefined, turns);
  } });
  const fixture = await nativeDomainEngine({ binary: binary!, plugins: [new URL("./opencode-plugins/legalwork-assistant-tools.ts", import.meta.url).pathname], modelURL: provider.url.origin + "/v1",
    setup: async (config, root) => { config.projectsDirectory = root; config.workspaces[0].preset = "main-assistant"; },
  });
  try {
    const client = assistantEngineClient(fixture.appClient, fixture.directory);
    const created = await client.session.create({ title: "Native Assistant smoke" }, { throwOnError: true });
    const sessionID = created.data!.id;
    await client.session.promptAsync({ sessionID, messageID: "msg_native_assistant_smoke", agent: "build", model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Look into my request and reply." }] }, { throwOnError: true });
    let events: ReturnType<typeof channelLiveEvents> = [];
    for (let i = 0; i < 300; i++) {
      const rows = (await client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })).data!;
      events = channelLiveEvents(rows, "msg_native_assistant_smoke");
      if (events.some(row => row.event.type === "message.created")) break;
      await Bun.sleep(50);
    }
    expect(events.map(row => row.event.type)).toContain("reaction.changed");
    expect(events).toMatchObject(expect.arrayContaining([expect.objectContaining({ event: expect.objectContaining({ type: "message.created", text: "Fixture checked." }) })]));
    expect(turns).toBe(2);
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
