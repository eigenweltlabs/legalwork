import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { assistantEngineClient } from "./assistant-engine.js";
import type { AssistantSubmission } from "@legalwork/types/launcher";
import { enqueueAssistantSubmission, sendAssistantSubmission } from "./assistant-submission-send.js";
import { SessionMessageQueue } from "./session-message-queue.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
