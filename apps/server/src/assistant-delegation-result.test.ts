import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { readDelegationResult } from "./assistant-delegation-result.js";

test("reads pending questions and approvals while busy, then the final reply; never confuses idle or tools with completion", async () => {
  let busy = true, completed = false, finish = "tool-calls", failReads = false;
  let error: { name: string; data: { message: string } } | undefined;
  let questions: { id: string; sessionID: string; questions: { question: string }[] }[] = [];
  let permissions: { id: string; sessionID: string; action: string; resources: string[] }[] = [];
  const engine = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/session/status") return failReads ? new Response(null, { status: 503 }) : Response.json(busy ? { child: { type: "busy" } } : {});
    if (path === "/session/child/message") return Response.json([{ info: { id: "reply", sessionID: "child", role: "assistant", time: { created: 1, ...(completed ? { completed: 2 } : {}) }, finish, error }, parts: [{ type: "text", text: "Report ready: review.md" }, { type: "text", synthetic: true, text: "secret reminder" }, { type: "text", ignored: true, text: "ignored text" }] }]);
    if (path === "/question") return Response.json(questions);
    if (path === "/api/session/child/question") return Response.json({ data: questions });
    // Verify the newer permission API still works when the older one is absent.
    if (path === "/api/session/child/permission") return Response.json({ data: permissions });
    return new Response(null, { status: 404 });
  } });
  const client = createOpencodeClient({ baseUrl: engine.url.origin });
  try {
    expect(await readDelegationResult(client, "child")).toBeNull();
    questions = [{ id: "q1", sessionID: "child", questions: [{ question: "Which agreement?" }] }, { id: "other", sessionID: "another-chat", questions: [{ question: "Private question" }] }];
    const question = await readDelegationResult(client, "child");
    expect(question?.outcome).toBe("input-required");
    expect(question?.messageId).toBe("question:q1");
    expect(question?.text).toContain("Which agreement?");
    expect(question?.text).not.toContain("Private question");
    questions = [];
    permissions = [{ id: "p1", sessionID: "child", action: "write", resources: ["review.md"] }];
    const approval = await readDelegationResult(client, "child");
    expect(approval?.outcome).toBe("input-required");
    expect(approval?.messageId).toBe("approval:p1");
    permissions = [];
    busy = false;
    expect(await readDelegationResult(client, "child")).toBeNull();
    completed = true;
    expect(await readDelegationResult(client, "child")).toBeNull();
    finish = "stop";
    expect(await readDelegationResult(client, "child")).toEqual({ messageId: "reply", outcome: "reply", text: "Report ready: review.md" });
    busy = true;
    expect(await readDelegationResult(client, "child")).toBeNull();
    busy = false; completed = false;
    error = { name: "MessageAbortedError", data: { message: "Stopped by user" } };
    expect((await readDelegationResult(client, "child"))?.outcome).toBe("interrupted");
    error = { name: "APIError", data: { message: "Provider failed" } };
    expect((await readDelegationResult(client, "child"))?.outcome).toBe("failed");
    failReads = true;
    await expect(readDelegationResult(client, "child")).rejects.toThrow("Could not read delegated chat progress");
  } finally { engine.stop(true); }
});
