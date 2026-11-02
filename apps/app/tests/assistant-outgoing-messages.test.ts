import { afterEach, expect, test } from "bun:test";
import type { SessionQueue } from "@legalwork/types/session-queue";
import type { UIMessage } from "ai";
import type { ComposerDraft } from "../src/app/types";
import { assistantBubbleMessages } from "../src/react-app/domains/session/surface/assistant-bubbles";
import {
  canPreviewAssistantSend, assistantOutgoingIsQueued, addAssistantOutgoingMessage, assistantOutgoingScope, isLocalOutgoingMessage,
  mergeAssistantOutgoingMessages, moveAssistantOutgoingMessage, outgoingMessageId,
  rememberAcceptedSteeringMessages, removeAssistantOutgoingMessage, useAssistantOutgoingMessages,
} from "../src/react-app/domains/session/surface/assistant-outgoing-messages";

const scope = assistantOutgoingScope("http://server", "assistant", "today");
const draft: ComposerDraft = { mode: "prompt", text: "Hello", parts: [{ type: "text", text: "Hello" }], attachments: [], modelContext: "Private instructions" };
const entries = () => useAssistantOutgoingMessages.getState().entries;
afterEach(() => entries().forEach(entry => removeAssistantOutgoingMessage(entry.queueId)));

test("a local bubble is available synchronously, then the canonical ID replaces it exactly once", () => {
  addAssistantOutgoingMessage(scope, "abc-def", draft);
  const visible = mergeAssistantOutgoingMessages([], entries(), scope);
  expect(visible).toHaveLength(1);
  expect(visible[0].id).toBe("msg_abcdef");
  expect(isLocalOutgoingMessage(visible[0])).toBe(true);
  expect(visible[0].parts).toEqual([{ type: "text", text: "Hello" }]);
  const canonical: UIMessage = { id: outgoingMessageId("abc-def"), role: "user", parts: [{ type: "text", text: "Hello" }] };
  const confirmed = mergeAssistantOutgoingMessages([canonical], entries(), scope);
  expect(confirmed).toEqual([canonical]);
  expect(isLocalOutgoingMessage(confirmed[0])).toBe(false);
});

test("accepted steering renders from the shared queue before history, including after a window reload", () => {
  const queue: SessionQueue = { ...emptyQueue, paused: true, entries: [{
    id: "steered", delivery: "steer", status: "accepted",
    draft: { ...draft, attachments: [{ id: "file", name: "source.txt", mimeType: "text/plain", size: 3, kind: "file", data: "data:text/plain;base64,YWJj" }], editor: { mentions: {}, pasteParts: [] } },
    execution: { kind: "prompt", id: "msg_native_identity", text: "Hello\nPrivate execution context" },
  }] };
  // No local submit state is required in this window. Render immediately.
  const visible = mergeAssistantOutgoingMessages([], [], scope, queue);
  expect(visible).toHaveLength(1);
  expect(visible[0].parts).toEqual([
    { type: "file", filename: "source.txt", mediaType: "text/plain", url: "data:text/plain;base64,YWJj" },
    { type: "text", text: "Hello" },
  ]);
  expect(JSON.stringify(visible)).not.toContain("Private");
  rememberAcceptedSteeringMessages(scope, queue, new Set());
  rememberAcceptedSteeringMessages(scope, queue, new Set());
  expect(entries()).toHaveLength(1);
  // The queue can observe delivery before this window receives history.
  const settled = { ...queue, entries: [], completedIds: ["steered"] };
  expect(mergeAssistantOutgoingMessages([], entries(), scope, settled)).toHaveLength(1);
  const confirmed: UIMessage = { id: "msg_native_identity", role: "user", parts: [{ type: "text", text: "Hello" }] };
  expect(mergeAssistantOutgoingMessages([confirmed], entries(), scope, queue)).toEqual([confirmed]);
  removeAssistantOutgoingMessage("steered");
  rememberAcceptedSteeringMessages(scope, queue, new Set([confirmed.id]));
  expect(entries()).toHaveLength(0);
});

test("steering is not shown as sent before acceptance or on failure", () => {
  for (const status of ["queued", "sending", "uncertain", "failed"] satisfies SessionQueue["entries"][number]["status"][]) {
    const queue: SessionQueue = { ...emptyQueue, entries: [{
      id: "steered", delivery: "steer", status,
      draft: { ...draft, attachments: [], editor: { mentions: {}, pasteParts: [] } },
      execution: { kind: "prompt", text: "Hello" },
    }] };
    expect(mergeAssistantOutgoingMessages([], [], scope, queue)).toEqual([]);
    rememberAcceptedSteeringMessages(scope, queue, new Set());
    expect(entries()).toEqual([]);
  }
});

test("retry replaces the same bubble, while intentionally repeated messages remain distinct", () => {
  addAssistantOutgoingMessage(scope, "first", draft);
  addAssistantOutgoingMessage(scope, "first", draft);
  expect(entries()).toHaveLength(1);
  addAssistantOutgoingMessage(scope, "second", draft);
  expect(mergeAssistantOutgoingMessages([], entries(), scope)).toHaveLength(2);
  removeAssistantOutgoingMessage("first");
  expect(entries().map(entry => entry.queueId)).toEqual(["second"]);
});

test("pending messages stay in their own server/workspace/day and follow a day rollover", () => {
  addAssistantOutgoingMessage(scope, "pending", draft);
  const tomorrow = assistantOutgoingScope("http://server", "assistant", "tomorrow");
  for (const other of [tomorrow, assistantOutgoingScope("http://other", "assistant", "today"), assistantOutgoingScope("http://server", "other", "today")]) {
    expect(mergeAssistantOutgoingMessages([], entries(), other)).toEqual([]);
  }
  moveAssistantOutgoingMessage("pending", tomorrow);
  expect(mergeAssistantOutgoingMessages([], entries(), scope)).toEqual([]);
  expect(mergeAssistantOutgoingMessages([], entries(), tomorrow)).toHaveLength(1);
});

test("a queued user bubble does not reveal an unfinished reply or hide earlier replies", () => {
  const old: UIMessage = { id: "old", role: "assistant", parts: [{ type: "text", text: "Earlier reply" }] };
  const user: UIMessage = { id: "user", role: "user", parts: [{ type: "text", text: "First question" }] };
  const streaming: UIMessage = { id: "stream", role: "assistant", parts: [{ type: "text", text: "Unfinished answer" }] };
  addAssistantOutgoingMessage(scope, "next", draft);
  const visible = mergeAssistantOutgoingMessages(assistantBubbleMessages([old, user, streaming], null, true), entries(), scope);
  expect(visible.map(message => message.id)).toEqual(["old", "user", outgoingMessageId("next")]);
});

test("attachments display without reading their bytes or leaking model instructions", async () => {
  const file = new File(["pdf"], "agreement.pdf", { type: "application/pdf" });
  addAssistantOutgoingMessage(scope, "file", { ...draft, attachments: [{ id: "file", name: file.name, mimeType: file.type, size: file.size, kind: "file", file }] });
  const part = entries()[0].message.parts[0];
  expect(part.type).toBe("file");
  if (part.type !== "file") throw new Error("Missing attachment");
  expect(part.filename).toBe("agreement.pdf");
  expect(await (await fetch(part.url)).text()).toBe("pdf");
  expect(JSON.stringify(entries()[0].message)).not.toContain("Private instructions");
  removeAssistantOutgoingMessage("file");
  expect(fetch(part.url)).rejects.toThrow();
});

const emptyQueue: SessionQueue = { workspaceId: "assistant", sessionId: "today", revision: 1, paused: false, completedIds: [], entries: [] };

test("only immediate sends appear as bubbles, not queued messages, edits or paused work", () => {
  expect(canPreviewAssistantSend(emptyQueue, false, false, false, draft)).toBe(true);
  expect(canPreviewAssistantSend(undefined, false, false, false, draft)).toBe(false);
  expect(canPreviewAssistantSend(emptyQueue, true, false, false, draft)).toBe(false);
  expect(canPreviewAssistantSend(emptyQueue, false, true, false, draft)).toBe(false);
  expect(canPreviewAssistantSend(emptyQueue, false, false, true, draft)).toBe(false);
  expect(canPreviewAssistantSend({ ...emptyQueue, paused: true }, false, false, false, draft)).toBe(false);
  expect(canPreviewAssistantSend(emptyQueue, false, false, false, { mode: "shell" })).toBe(false);
  expect(canPreviewAssistantSend(emptyQueue, false, false, false, { mode: "prompt", command: { name: "compact", arguments: "" } })).toBe(false);
});

test("project and wiki sends stay visible across admission until canonical history confirms their ID", () => {
  for (const workspaceId of ["project", "wiki"]) {
    const scope = assistantOutgoingScope("http://server", workspaceId, "chat");
    const queue = { ...emptyQueue, workspaceId, sessionId: "chat" };
    expect(canPreviewAssistantSend(queue, false, false, false, draft)).toBe(true);
    addAssistantOutgoingMessage(scope, workspaceId, draft);
    const local = mergeAssistantOutgoingMessages([], entries(), scope, queue);
    expect(local.map(message => message.id)).toEqual([outgoingMessageId(workspaceId)]);
    const accepted = { ...queue, completedIds: [workspaceId] };
    expect(mergeAssistantOutgoingMessages([], entries(), scope, accepted)).toEqual(local);
    const canonical: UIMessage = { id: local[0].id, role: "user", parts: [{ type: "text", text: "Hello" }] };
    expect(mergeAssistantOutgoingMessages([canonical], entries(), scope, accepted)).toEqual([canonical]);
    removeAssistantOutgoingMessage(workspaceId);
  }
});

test("a server-side queue decision removes an optimistic bubble, including edits and delivery failures", () => {
  addAssistantOutgoingMessage(scope, "pending", draft);
  const entry: SessionQueue["entries"][number] = {
    id: "pending", status: "queued",
    draft: { ...draft, attachments: [], editor: { mentions: {}, pasteParts: [] } },
    execution: { kind: "prompt", text: "Hello" },
  };
  for (const status of ["queued", "failed", "uncertain"] satisfies SessionQueue["entries"][number]["status"][]) {
    const queue = { ...emptyQueue, entries: [{ ...entry, status }] };
    expect(canPreviewAssistantSend(queue, false, false, false, draft)).toBe(false);
    expect(assistantOutgoingIsQueued("pending", queue)).toBe(true);
    expect(mergeAssistantOutgoingMessages([], entries(), scope, queue)).toEqual([]);
  }
  for (const status of ["sending", "accepted"] satisfies SessionQueue["entries"][number]["status"][]) {
    const queue = { ...emptyQueue, entries: [{ ...entry, status }] };
    expect(canPreviewAssistantSend(queue, false, false, false, draft)).toBe(false);
    expect(mergeAssistantOutgoingMessages([], entries(), scope, queue)).toHaveLength(1);
  }
});
