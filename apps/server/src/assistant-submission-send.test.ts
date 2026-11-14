import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { assistantEngineClient } from "./assistant-engine.js";
import type { AssistantSubmission } from "@legalwork/types/launcher";
import { enqueueAssistantSubmission, sendAssistantSubmission, stageAssistantSubmission } from "./assistant-submission-send.js";
import { SessionMessageQueue } from "./session-message-queue.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "./types.js";
import { nativeQueueTransport } from "./native-queue-transport.js";
import { AssistantSubmissions, type SubmissionExecutor } from "./assistant-submissions.js";


test("commands use the engine command endpoint with arguments, preferences and stable message identity", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const engine = Bun.serve({ port: 0, async fetch(request) { const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      if (path === "/api/session/project-chat") return Response.json({ data: { id: "project-chat", location: { directory: "/matter" } } });
      if (path === "/api/plugin") return Response.json({ data: [{ id: "legalwork.commands", state: { status: "active" } }] });
      if (path === "/api/command") return Response.json({ data: [{ name: "compare" }] });
    }
    calls.push({ path, body: await request.json() }); return path.includes("/rpc/") ? Response.json({ output: { accepted: true } }) : new Response(null, { status: 204 }); } });
  const entry: AssistantSubmission = { requestId: "request", messageId: "msg_1234567890abc", workspaceId: "matter", conversationId: "origin", sessionId: "project-chat", target: { kind: "project", workspaceId: "matter" }, state: "sending", preview: "/compare a b", createdAt: 1, updatedAt: 1, error: null };
  try {
    await sendAssistantSubmission(assistantEngineClient(OpenCode.make({ baseUrl: engine.url.origin }), "/matter"), entry, { parts: [{ type: "text", text: "/compare a b" }], command: { name: "compare", arguments: "a b" }, model: { providerID: "provider", modelID: "model" }, agent: "reviewer", variant: "deep" });
    expect(calls).toEqual([
      { path: "/api/session/project-chat/agent", body: { agent: "reviewer" } },
      { path: "/api/session/project-chat/model", body: { model: { providerID: "provider", id: "model", variant: "deep" } } },
      { path: "/api/rpc/legalwork.commands/invoke", body: { input: { sessionID: "project-chat", messageID: entry.messageId, name: "compare", prompt: { text: "a b", files: [], agents: [], skills: [] }, delivery: "queue" } } },
    ]);
  } finally { engine.stop(true); }
});

test("Home's durable queue retains the shared message identity, context and edits across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-queue-"));
  const transport = { idle: async () => false, send: async () => {} };
  let queue = new SessionMessageQueue(root, transport);
  const entry: AssistantSubmission = { requestId: "request", messageId: "msg_1234567890abc", workspaceId: "assistant", conversationId: "origin", sessionId: "chat", target: { kind: "project", workspaceId: "matter" }, state: "sending", preview: "Review", createdAt: 1, updatedAt: 1, error: null };
  const queued = { id: crypto.randomUUID(), draft: { mode: "prompt", text: "Review", parts: [{ type: "text", text: "Review" }], attachments: [], editor: { mentions: {}, pasteParts: [] } } } satisfies NonNullable<Parameters<typeof enqueueAssistantSubmission>[2]["queue"]>;
  const payload = { queue: queued, model: { providerID: "test", modelID: "model" }, parts: [{ type: "text", text: "Bound to matter", synthetic: true }], command: { name: "review", arguments: "contract" } } satisfies Parameters<typeof enqueueAssistantSubmission>[2];
  try {
    await enqueueAssistantSubmission(queue, entry, payload);
    await enqueueAssistantSubmission(queue, entry, payload);
    queue.stop(); queue = new SessionMessageQueue(root, transport);
    const restored = await queue.read("assistant", "chat");
    expect(restored.entries).toHaveLength(1);
    expect(restored.entries[0]).toMatchObject({ id: queued.id, messageId: entry.messageId, execution: { kind: "command", command: "review", args: "contract\n\nBound to matter", model: { providerID: "test", id: "model" } } });
    const token = crypto.randomUUID();
    await queue.act("assistant", "chat", { type: "edit", id: queued.id, token, revision: restored.revision });
    await enqueueAssistantSubmission(queue, { ...entry, messageId: "msg_edited123456789" }, { ...payload, queue: { ...queued, editToken: token }, command: { name: "review", arguments: "edited" } });
    expect((await queue.read("assistant", "chat")).entries[0]).toMatchObject({ messageId: "msg_edited123456789", execution: { args: "edited\n\nBound to matter" } });
  } finally { queue.stop(); await rm(root, { recursive: true, force: true }); }
});

test("queued native prompts keep the operation ID, hidden context, attachments and skill references", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-native-queue-"));
  const queue = new SessionMessageQueue(root, { idle: async () => false, send: async () => {} });
  const entry: AssistantSubmission = { requestId: "request", messageId: "msg_stable123456789", workspaceId: "assistant", conversationId: "origin", sessionId: "chat", target: { kind: "assistant" }, state: "sending", preview: "Review", createdAt: 1, updatedAt: 1, error: null };
  try {
    await enqueueAssistantSubmission(queue, entry, {
      queue: { id: crypto.randomUUID(), draft: { mode: "prompt", text: "Review", parts: [{ type: "text", text: "Review" }], attachments: [], editor: { mentions: {}, pasteParts: [] } } },
      model: { providerID: "test", modelID: "model" }, variant: "deep", parts: [
        { type: "text", text: "Review", metadata: { legalworkLauncherRequest: { requestId: entry.requestId } } },
        { type: "text", text: "Project context", synthetic: true },
        { type: "file", url: "file:///matter/contract.pdf", filename: "contract.pdf", mime: "application/pdf" },
        { type: "skill", id: "legal-research" }, { type: "agent", name: "reviewer" },
      ],
    });
    const saved = (await queue.read(entry.workspaceId, entry.sessionId)).entries[0];
    expect(saved.execution).toMatchObject({ kind: "prompt", id: entry.messageId, text: "Review\n\nProject context",
      model: { providerID: "test", id: "model", variant: "deep" }, files: [{ uri: "file:///matter/contract.pdf", name: "contract.pdf" }],
      skills: [{ id: "legal-research" }], agents: [{ name: "reviewer" }],
      metadata: { legalworkLauncherRequest: { requestId: entry.requestId }, legalworkPrompt: { visibleText: "Review", reminders: ["Project context"] } },
    });
  } finally { queue.stop(); await rm(root, { recursive: true, force: true }); }
});


test("popup submissions freeze complete drafts and defer each model and agent until its own idle turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-popup-staging-"));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: join(root, "config.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  let active = true, selectedAgent = "original", selectedModel = "original";
  const sends: { id: string; model: string; agent: string }[] = [];
  const selections: string[] = [];
  const client = OpenCode.make({ baseUrl: "http://popup-staging.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    if (url.pathname === "/api/session/active") return Response.json({ data: active ? { chat: { id: "chat" } } : {} });
    if (url.pathname.endsWith("/inbox")) return Response.json({ data: [] });
    if (url.pathname.endsWith("/agent")) {
      selectedAgent = z.object({ agent: z.string() }).parse(JSON.parse(String(init?.body))).agent;
      selections.push(selectedAgent); return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/model")) {
      selectedModel = z.object({ model: z.object({ id: z.string() }) }).parse(JSON.parse(String(init?.body))).model.id;
      selections.push(selectedModel); return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/prompt")) {
      const { id } = z.object({ id: z.string() }).parse(JSON.parse(String(init?.body)));
      sends.push({ id, model: selectedModel, agent: selectedAgent }); active = true;
      return Response.json({ data: { id, type: "user", delivery: "queue" } });
    }
    if (url.pathname === "/api/session/chat") return init?.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json({ data: { outcome: "completed" } });
    throw new Error(`Unexpected engine request: ${url.pathname}`);
  }, { preconnect: fetch.preconnect }) });
  const transport = nativeQueueTransport(config, { client: async () => client, prepare: async () => {} });
  let queue = new SessionMessageQueue(root, transport);
  const entry: AssistantSubmission = { requestId: "request", messageId: "msg_popupfirst123456", workspaceId: "matter", conversationId: "origin", sessionId: "chat", target: { kind: "project", workspaceId: "matter" }, state: "sending", preview: "Review", createdAt: 1, updatedAt: 1, error: null };
  const first = stageAssistantSubmission(entry.messageId, { parts: [
    { type: "text", text: "Review this" }, { type: "text", text: "Frozen project context", synthetic: true },
    { type: "file", url: "data:application/pdf;base64,aGk=", filename: "contract.pdf", mime: "application/pdf" },
    { type: "file", url: "file:///matter/notes.txt", filename: "notes.txt", mime: "text/plain" },
    { type: "skill", id: "review" }, { type: "agent", name: "helper" },
  ], model: { providerID: "test", modelID: "first-model" }, agent: "first-agent", variant: "deep" });
  const secondEntry = { ...entry, requestId: "second", messageId: "msg_popupsecond12345" };
  const second = stageAssistantSubmission(secondEntry.messageId, { parts: [{ type: "text", text: "Second" }], model: { providerID: "test", modelID: "second-model" }, agent: "second-agent" });
  const cancelledEntry = { ...entry, requestId: "cancelled", messageId: "msg_popupcancelled123" };
  const cancelled = stageAssistantSubmission(cancelledEntry.messageId, { parts: [{ type: "text", text: "Cancelled" }] });
  const firstId = first.queue?.id, secondId = second.queue?.id, cancelledId = cancelled.queue?.id;
  if (!firstId || !secondId || !cancelledId) throw new Error("Popup drafts must have durable queue identities");
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    expect(await check()).toBe(true);
  };
  try {
    expect(stageAssistantSubmission(entry.messageId, { parts: [] }).queue?.id).toBe(firstId);
    expect(first.queue?.draft).toMatchObject({ text: "Review this", modelContext: "Frozen project context", attachments: [{ name: "contract.pdf", data: "data:application/pdf;base64,aGk=" }],
      parts: [{ type: "text", text: "Review this" }, { type: "file", path: "file:///matter/notes.txt", label: "notes.txt" }, { type: "agent", name: "helper" }, { type: "skill", name: "review" }] });
    await enqueueAssistantSubmission(queue, entry, first);
    await enqueueAssistantSubmission(queue, secondEntry, second);
    await enqueueAssistantSubmission(queue, cancelledEntry, cancelled);
    expect(selections).toEqual([]); expect(sends).toEqual([]);
    await queue.act("matter", "chat", { type: "pause", paused: true, reason: "stop" });
    await enqueueAssistantSubmission(queue, entry, first);
    expect((await queue.read("matter", "chat")).paused).toBe(true);
    const beforeCancel = await queue.read("matter", "chat");
    await queue.act("matter", "chat", { type: "remove", id: cancelledId, revision: beforeCancel.revision });
    queue.stop(); queue = new SessionMessageQueue(root, transport);
    await enqueueAssistantSubmission(queue, cancelledEntry, cancelled);
    await enqueueAssistantSubmission(queue, entry, first);
    const restored = await queue.read("matter", "chat");
    expect(restored.paused).toBe(true);
    expect(restored.entries.map(item => item.id)).toEqual([firstId, secondId]);
    expect(restored.completedIds).toContain(cancelledId);
    expect(restored.entries.map(item => item.execution)).toMatchObject([{ model: { id: "first-model", variant: "deep" }, agent: "first-agent" }, { model: { id: "second-model" }, agent: "second-agent" }]);
    active = false;
    await queue.act("matter", "chat", { type: "pause", paused: false });
    await until(async () => { await queue.tick(); return sends.length === 1; });
    expect(sends).toEqual([{ id: entry.messageId, model: "first-model", agent: "first-agent" }]);
    await queue.tick();
    expect(sends).toHaveLength(1);
    active = false; await until(async () => { await queue.tick(); return sends.length === 2; });
    expect(sends[1]).toEqual({ id: secondEntry.messageId, model: "second-model", agent: "second-agent" });
    active = false; await until(async () => { await queue.tick(); return (await queue.read("matter", "chat")).entries.length === 0; });
    await enqueueAssistantSubmission(queue, entry, first);
    expect(sends).toHaveLength(2);
    expect((await queue.read("matter", "chat")).completedIds).toEqual(expect.arrayContaining([firstId, secondId, cancelledId]));
  } finally { queue.stop(); await rm(root, { recursive: true, force: true }); }
});

test("popup command drafts retain authored arguments and context with a stable shared message identity", async () => {
  const messageId = "msg_popupcommand12345";
  const payload = stageAssistantSubmission(messageId, { parts: [{ type: "text", text: "/review contract" }, { type: "text", text: "Frozen context", synthetic: true }], command: { name: "review", arguments: "contract" } });
  expect(payload.queue?.draft).toMatchObject({ text: "/review contract", command: { name: "review", arguments: "contract" }, modelContext: "Frozen context" });
  const root = await mkdtemp(join(tmpdir(), "assistant-popup-command-"));
  const queue = new SessionMessageQueue(root, { idle: async () => false, send: async () => {} });
  const entry: AssistantSubmission = { requestId: "request", messageId, workspaceId: "matter", conversationId: "origin", sessionId: "chat", target: { kind: "project", workspaceId: "matter" }, state: "sending", preview: "/review contract", createdAt: 1, updatedAt: 1, error: null };
  try {
    await enqueueAssistantSubmission(queue, entry, payload);
    const saved = (await queue.read("matter", "chat")).entries[0];
    expect(saved.messageId).toBe(messageId);
    expect(saved.execution).toMatchObject({ kind: "command", args: "contract\n\nFrozen context" });
    expect("model" in saved.execution).toBe(false);
    expect("agent" in saved.execution).toBe(false);
  } finally { queue.stop(); await rm(root, { recursive: true, force: true }); }
});


test("popup submission receipts survive restart and cancellation without replacing or replaying the saved draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-popup-receipt-"));
  const queue = new SessionMessageQueue(join(root, "queue"), { idle: async () => false, send: async () => { throw new Error("Chat is busy"); } });
  const identity = { requestId: "request_popup_receipt", messageId: "msg_popupreceipt12345", workspaceId: "matter", sessionId: "chat", conversationId: "conversation", preview: "Original", target: { kind: "project", workspaceId: "matter" } } satisfies Omit<AssistantSubmission, "state" | "createdAt" | "updatedAt" | "error">;
  const payload = stageAssistantSubmission(identity.messageId, { parts: [{ type: "text", text: "Original" }], model: { providerID: "test", modelID: "original" } });
  let offline = true, sends = 0;
  const executor: SubmissionExecutor = {
    hasMessage: async (entry, messageId, saved) => {
      const state = await queue.read(entry.workspaceId, entry.sessionId);
      return state.entries.some(item => item.id === saved.queue?.id && item.messageId === messageId) || Boolean(saved.queue && state.completedIds.includes(saved.queue.id));
    },
    send: async (entry, saved) => { sends++; if (offline) throw new Error("Connection lost before admission"); await enqueueAssistantSubmission(queue, entry, saved); },
    outcome: async (entry, _messageId, saved) => (await queue.read(entry.workspaceId, entry.sessionId)).entries.some(item => item.id === saved.queue?.id) ? "accepted" : "failed",
  };
  try {
    let store = await AssistantSubmissions.open(join(root, "runtime.sqlite"), executor);
    expect((await store.submit({ ...identity, payload })).state).toBe("unconfirmed");
    store = await AssistantSubmissions.open(join(root, "runtime.sqlite"), executor);
    offline = false;
    expect((await store.submit({ ...identity, payload: stageAssistantSubmission(identity.messageId, { parts: [{ type: "text", text: "Changed retry" }], model: { providerID: "test", modelID: "changed" } }) })).state).toBe("accepted");
    const admitted = await queue.read(identity.workspaceId, identity.sessionId);
    expect(admitted.entries).toHaveLength(1);
    expect(admitted.entries[0]).toMatchObject({ id: payload.queue?.id, messageId: identity.messageId, draft: { text: "Original" }, execution: { model: { id: "original" } } });
    await queue.act(identity.workspaceId, identity.sessionId, { type: "remove", id: admitted.entries[0].id, revision: admitted.revision });
    store = await AssistantSubmissions.open(join(root, "runtime.sqlite"), executor);
    expect((await store.retry(identity.requestId)).state).toBe("failed");
    expect((await queue.read(identity.workspaceId, identity.sessionId)).entries).toEqual([]);
    expect(sends).toBe(2);
  } finally { queue.stop(); await rm(root, { recursive: true, force: true }); }
});
