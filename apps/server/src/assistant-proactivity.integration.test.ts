import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { nativeChatResponse, nativeDomainEngine } from "./opencode-plugins/native-domain-engine.test-support.js";
import { projectMessage } from "@legalwork/types/opencode-view";
import { assistantProactivityStore } from "./assistant-proactivity-store.js";
import { prepareAssistantEventSession, processAssistantEvents } from "./assistant-proactivity.js";
import { AssistantSessionAccess } from "./assistant-session-access.js";
import { runtimeDbPath } from "./runtime-db.js";
import { currentWikiAgentSession } from "./wiki/agent-access.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { assistantLanguageContext } from "./assistant-language-context.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("released engine: Assistant owns its scratchpad, offers one briefing, and handles combined events with its normal tools", async () => {
  if (!binary) throw new Error("A released engine is required");
  const previousDB = process.env.OPENCODE_DB;
  let sequence = 0, toolStep = 0;
  const calls = [
    { name: "legalwork_assistant_scratchpad", input: {} },
    { name: "legalwork_assistant_scratchpad", input: { text: "Tell the user when Alex sends the Aster signature page. Remove once received.", revision: 0 } },
    { name: "legalwork_assistant_briefing", input: { action: "status" } },
    { name: "legalwork_assistant_briefing", input: { action: "offer" } },
    { name: "legalwork_assistant_briefing", input: { action: "offer" } },
    { name: "legalwork_assistant_briefing", input: { action: "decline" } },
  ];
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = z.object({ stream: z.boolean().optional(), tools: z.array(z.unknown()).optional(), messages: z.array(z.unknown()) }).parse(await request.json());
    return nativeChatResponse(body.tools?.length ? calls[toolStep++] : undefined, sequence++);
  } });
  let engine: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    engine = await nativeDomainEngine({ binary, scopedRuntime: true, plugins: [join(import.meta.dir, "opencode-plugins/legalwork-assistant-tools.ts")], modelURL: model.url.origin + "/v1",
      configuration: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
      async setup(config, root) {
        await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active" }) });
        config.workspaces[0].preset = "main-assistant";
        config.projectsDirectory = join(root, "projects");
        config.managedEngineStorageDirectory = join(root, "isolated-engine");
        process.env.OPENCODE_DB = join(root, "engine.db");
      },
    });
    const { appClient, client, location, config, serverURL } = engine;
    const session = await appClient.session.create({ location, agent: "build" });
    await appClient.session.prompt({ sessionID: session.id, text: "Let me know when Alex sends the signature page. No morning briefing, thanks." });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(45_000) });
    const history = await client.session.context({ sessionID: session.id });
    const tools = history.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool") : []);
    expect(tools.map(tool => tool.state.status), JSON.stringify(history)).toEqual(calls.map(() => "completed"));
    const outputs = tools.map(tool => tool.state.status === "completed" ? JSON.parse(tool.state.content.flatMap(part => part.type === "text" && part.text.startsWith("{") ? [part.text] : []).join("\n")) : null);
    expect(outputs[0].scratchpad.text).toBe("");
    expect(outputs[1].scratchpad.revision).toBe(1);
    expect(outputs[2].task).toBeNull();
    expect(outputs[3].mayOffer).toBe(true);
    expect(outputs[4].mayOffer).toBe(false);
    const call = (path: string, body: unknown) => fetch(serverURL + path, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const origin = { workspaceId: "matter", sessionId: session.id, sourceSessionId: session.id };
    expect((await (await call("/assistant/briefing", { ...origin, action: "status" })).json()).offer.state).toBe("declined");
    expect((await call("/assistant/briefing", { ...origin, action: "create", time: "08:30", weekdaysOnly: true })).status).toBe(400);
    const created = await (await call("/assistant/briefing", { ...origin, action: "create", time: "08:30", weekdaysOnly: true, userAccepted: true })).json();
    const duplicate = await (await call("/assistant/briefing", { ...origin, action: "create", time: "08:30", weekdaysOnly: true, userAccepted: true })).json();
    expect(created.task.id).toBe(duplicate.task.id);
    expect(created.task.schedule.rrule).toContain("BYDAY=MO,TU,WE,TH,FR");
    const child = await client.session.create({ location, parentID: session.id, agent: "build" });
    expect((await call("/assistant/scratchpad", { workspaceId: "matter", sessionId: child.id, sourceSessionId: child.id, text: "worker overwrite", revision: 1 })).status).toBe(403);
    // Use a cold daily destination created directly in the engine. It has no
    // authenticated proxy grant, just like a heartbeat after an app restart.
    const destination = await client.session.create({ location, agent: "build" });
    expect(currentWikiAgentSession(config, destination.id)).toBeUndefined();
    const before = await client.session.context({ sessionID: destination.id });
    // The event turn must retain native tool access, including finishing its own
    // one-time condition. The source text itself never writes the scratchpad.
    calls.splice(0, calls.length,
      { name: "legalwork_assistant_scratchpad", input: {} },
      { name: "legalwork_assistant_scratchpad", input: { text: "", revision: 1 } },
    );
    toolStep = 0;
    const store = await assistantProactivityStore(config);
    expect(store.scratchpadSource()).toMatchObject({ sessionId: session.id, directory: location.directory, authority: { scope: "collaborator" } });
    const access = await AssistantSessionAccess.open(runtimeDbPath(config), config);
    const events = Array.from({ length: 45 }, (_, index) => ({ id: `arrival-${index}`, source: "gmail", projectId: null, at: index, text: `Signature page ${index} arrived.` }));
    store.ingest("gmail", "45", events);
    const scored: string[] = [];
    let deliveries = 0;
    let deliveredText = "";
    await processAssistantEvents(store, {
      allowed: async () => true,
      classify: async (_, batch) => {
        scored.push(...batch.map(event => event.id));
        return Object.fromEntries(batch.map(event => [event.id, 0.9]));
      },
      deliver: async (combined, message, revision) => {
        deliveries++;
        deliveredText = message + await assistantLanguageContext(client.message, [destination.id, session.id]);
        expect(deliveredText).toContain('"text":"Let me know when Alex sends the signature page. No morning briefing, thanks."');
        expect(scored).toEqual(events.map(event => event.id));
        expect(combined).toEqual(events.map(event => ({ ...event, relevanceProbability: 0.9 })));
        expect(message).toContain("use your normal tools");
        expect(await prepareAssistantEventSession(store, access, { sessionId: destination.id, directory: location.directory }, revision)).toBe(true);
        const receipt = store.prepareDelivery(combined.map(event => event.id), "msg_combined_fixture", destination.id, deliveredText, revision);
        await client.session.synthetic({ sessionID: receipt.sessionId, id: receipt.id, text: deliveredText, description: "Assistant update", metadata: { legalworkSystemReminder: true } });
        return true;
      },
    });
    await client.session.wait({ sessionID: destination.id }, { signal: AbortSignal.timeout(30_000) });
    expect(deliveries).toBe(1);
    expect(store.pending()).toEqual([]);
    const combinedHistory = await client.session.context({ sessionID: destination.id });
    expect(combinedHistory.filter(message => message.id === "msg_combined_fixture")).toHaveLength(1);
    const eventTools = combinedHistory.slice(before.length).flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool") : []);
    expect(eventTools.map(tool => tool.state.status), JSON.stringify(combinedHistory)).toEqual(["completed", "completed"]);
    expect(store.scratchpad().text).toBe("");
    const synthetic = combinedHistory.find(message => message.id === "msg_combined_fixture");
    if (!synthetic) throw new Error("Missing event turn");
    expect(projectMessage(destination.id, synthetic)).toEqual([]);
    await client.session.synthetic({ sessionID: destination.id, id: "msg_combined_fixture", text: deliveredText, description: "Assistant update", metadata: { legalworkSystemReminder: true } });
    await client.session.wait({ sessionID: destination.id }, { signal: AbortSignal.timeout(30_000) });
    const replayed = await client.session.context({ sessionID: destination.id });
    expect(replayed.filter(message => message.type !== "idle")).toEqual(combinedHistory.filter(message => message.type !== "idle"));
    expect(store.scratchpad().revision).toBe(2);
  } finally {
    await engine?.close(); model.stop(true);
    if (previousDB === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previousDB;
  }
}, 120_000);
