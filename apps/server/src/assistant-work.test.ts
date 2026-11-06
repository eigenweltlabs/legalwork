import { expect, test } from "bun:test";
import { listAssistantWork, workStatus } from "./assistant-work.js";
import type { TrackedDelegation } from "./assistant-delegations.js";

const base = { sourceWorkspaceId: "assistant", sourceSessionId: "conv-session", title: "Compare leases", scope: "Compare v1 and v2", model: null };
test("work items keep their origin, derive one status per job, and survive an unreadable project", async () => {
  const delegations: TrackedDelegation[] = [
    { ...base, workspaceId: "mueller", sessionId: "running" }, { ...base, workspaceId: "mueller", sessionId: "question" },
    { ...base, workspaceId: "schmidt", sessionId: "done", sourceSessionId: "other-session" }, { ...base, workspaceId: "gone", sessionId: "gone" },
    { ...base, workspaceId: "mueller", sessionId: "child", inputOnly: true },
  ];
  const items = await listAssistantWork(delegations, {
    originConversationId: id => id === "conv-session" ? "conv_1" : null,
    inspect: async delegation => {
      if (delegation.sessionId === "gone") throw new Error("Project folder is unavailable");
      const common = { available: true, title: delegation.title, projectName: delegation.workspaceId, createdAt: 1, pendingAttention: 0, queuedMessages: 0 };
      if (delegation.sessionId === "running") return { ...common, busy: true, updatedAt: 3, result: null };
      if (delegation.sessionId === "question") return { ...common, busy: true, updatedAt: 4, result: { messageId: "q", outcome: "input-required", text: "Which party?" }, pendingAttention: 1 };
      return { ...common, busy: false, updatedAt: 2, result: { messageId: "m", outcome: "reply", text: "Done: the comparison is saved." } };
    },
  });
  expect(items.map(item => [item.sessionId, item.status, item.originConversationId])).toEqual([["question", "input-required", "conv_1"], ["running", "running", "conv_1"], ["done", "returned", null], ["gone", "unavailable", "conv_1"]]);
  expect(items[2].result).toMatchObject({ outcome: "reply", preview: "Done: the comparison is saved." });
  expect((await listAssistantWork(delegations, { originConversationId: () => null, inspect: async () => ({ available: true, busy: false, title: "t", projectName: "p", createdAt: 1, updatedAt: 1, result: null, pendingAttention: 0, queuedMessages: 2 }) }, { projectId: "schmidt" })).map(item => item.status)).toEqual(["queued"]);
  expect(workStatus({ available: true, busy: false, title: "", projectName: "", createdAt: null, updatedAt: null, result: { messageId: "x", outcome: "interrupted", text: "" }, pendingAttention: 0, queuedMessages: 0 })).toBe("stopped");
  expect(workStatus({ available: true, busy: false, title: "", projectName: "", createdAt: null, updatedAt: null, result: { messageId: "x", outcome: "failed", text: "" }, pendingAttention: 0, queuedMessages: 0 })).toBe("failed");
});
