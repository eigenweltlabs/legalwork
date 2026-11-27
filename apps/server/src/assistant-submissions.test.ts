import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "./errors.js";
import { AssistantSubmissions, type SubmissionExecutor } from "./assistant-submissions.js";

const base = { conversationId: "conv_1", workspaceId: "assistant", sessionId: "ses_1", preview: "Was ist offen?", target: { kind: "assistant" as const }, payload: { parts: [{ type: "text" as const, text: "Was ist offen?" }] } };
test("async engine acceptance waits for visibility without a false error or duplicate dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-delayed-"));
  let stored = false, sends = 0;
  const executor: SubmissionExecutor = { hasMessage: async () => stored, send: async () => { sends++; }, outcome: async () => "running" };
  try {
    const store = await AssistantSubmissions.open(join(root, "runtime.sqlite"), executor);
    const input = { ...base, requestId: "req_aaaaaaaa", messageId: "msg_0123456789abcdef" };
    expect(await store.submit(input)).toMatchObject({ state: "sending", error: null });
    expect(await store.status(input.requestId)).toMatchObject({ state: "sending", error: null });
    expect(await store.submit(input)).toMatchObject({ state: "sending", error: null });
    expect(await store.retry(input.requestId)).toMatchObject({ state: "sending", error: null });
    expect(sends).toBe(1);
    stored = true;
    expect(await store.status(input.requestId)).toMatchObject({ state: "running", error: null });
    expect(sends).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("a lost acknowledgement is retried with the same identity and never duplicates the message", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-submissions-"));
  const stored = new Set<string>();
  let sends = 0, lose = true, answered = false;
  const executor: SubmissionExecutor = {
    hasMessage: async (_target, id) => stored.has(id),
    send: async entry => { sends++; stored.add(entry.messageId); if (lose) throw new Error("socket closed"); },
    outcome: async () => answered ? "completed" : "running",
  };
  try {
    const store = await AssistantSubmissions.open(join(root, "runtime.sqlite"), executor);
    const first = await store.submit({ ...base, requestId: "req_aaaaaaaa", messageId: "msg_0123456789abcdef" });
    // The engine stored the message before the response was lost, so the retry sees it.
    expect(first.state).toBe("accepted");
    expect(sends).toBe(1);
    const retry = await store.submit({ ...base, requestId: "req_aaaaaaaa", messageId: "msg_0123456789abcdef" });
    expect(retry.state).toBe("running");
    expect(sends).toBe(1);
    answered = true;
    expect((await store.status("req_aaaaaaaa")).state).toBe("completed");
    expect(store.constraint("ses_1")).toEqual({ kind: "assistant" });
    // A finished request binds nothing any more; a later message from Home is free to choose.
    expect(await store.activeConstraint("ses_1")).toBeNull();
    expect(await store.activeConstraint("ses_unknown")).toBeNull();
    await expect(store.submit({ ...base, requestId: "req_aaaaaaaa", messageId: "msg_fedcba9876543210" })).rejects.toThrow("another message");
    await expect(store.submit({ ...base, requestId: "req_bbbbbbbb", messageId: "msg_0123456789abcdef" })).rejects.toThrow("another request");
    // A send that fails before the engine stored anything stays unconfirmed, and the retry really sends.
    lose = false;
    const failing: SubmissionExecutor = { ...executor, send: async () => { sends++; throw new Error("network down"); } };
    const second = await AssistantSubmissions.open(join(root, "runtime.sqlite"), failing);
    const unconfirmed = await second.submit({ ...base, requestId: "req_cccccccc", messageId: "msg_aaaaaaaaaaaaaaaa", target: { kind: "project", workspaceId: "matter" } });
    expect(unconfirmed.state).toBe("unconfirmed");
    expect(second.constraint("ses_1")).toEqual({ kind: "project", workspaceId: "matter" });
    expect(await second.activeConstraint("ses_1")).toEqual({ kind: "project", workspaceId: "matter" });
    const third = await AssistantSubmissions.open(join(root, "runtime.sqlite"), executor);
    expect((await third.submit({ ...base, requestId: "req_cccccccc", messageId: "msg_aaaaaaaaaaaaaaaa", target: { kind: "project", workspaceId: "matter" } })).state).toBe("accepted");
    expect(sends).toBe(3);
    expect((await third.status("req_cccccccc")).state).toBe("completed");
    const refusing: SubmissionExecutor = { ...executor, send: async () => { throw new ApiError(404, "gone", "This chat is archived."); } };
    const fourth = await AssistantSubmissions.open(join(root, "runtime.sqlite"), refusing);
    expect((await fourth.submit({ ...base, requestId: "req_dddddddd", messageId: "msg_bbbbbbbbbbbbbbbb" })).state).toBe("failed");
    await expect(fourth.status("req_missing")).rejects.toThrow("unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});
