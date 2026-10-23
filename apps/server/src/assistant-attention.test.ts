import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { assistantWidget, readAssistantAttention, replyToAssistantAttention } from "./assistant-attention.js";

test("attention preserves original approval details and question choices, isolates sessions and rejects stale replies", async () => {
  const sent: { path: string; body: unknown }[] = [];
  let fail = false;
  const engine = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") { sent.push({ path, body: await request.json() }); return Response.json(true); }
    if (fail) return new Response(null, { status: 503 });
    if (path === "/permission") return Response.json([{ id: "p", sessionID: "child", permission: "bash", patterns: ["rm report.docx"], metadata: { command: "rm report.docx" } }, { id: "private", sessionID: "other", permission: "bash", patterns: ["private command"], metadata: {} }]);
    if (path === "/api/session/child/permission") return Response.json({ data: [{ id: "p", sessionID: "child", action: "execute", resources: ["rm report.docx"], metadata: { command: "rm report.docx" } }] });
    if (path === "/question") return Response.json([{ id: "q", sessionID: "child", questions: [{ header: "Scope", question: "Which agreement?", custom: false, options: [{ label: "A", description: "First agreement" }, { label: "B", description: "Second agreement" }] }] }]);
    if (path === "/session/child/message") return Response.json([{ info: { id: "m", role: "assistant", sessionID: "child" }, parts: [{ id: "part", type: "tool", callID: "call", tool: "legalwork_calculation_present", state: { status: "completed", input: {}, output: JSON.stringify({ presentation: { id: "56f829b1-7bba-451c-84df-f310abf1e542", workspaceId: "matter", title: "Review dates" } }) } }, { id: "bash", type: "tool", callID: "bash", tool: "bash", state: { status: "completed", input: {}, output: "internal log" } }] }]);
    return new Response(null, { status: 404 });
  } });
  const client = createOpencodeClient({ baseUrl: engine.url.origin });
  const source = { workspaceId: "matter", sessionId: "child", projectName: "Aster", sessionTitle: "Review agreement" };
  try {
    const items = await readAssistantAttention(client, source);
    expect(items).toHaveLength(3);
    expect(items.every(item => !item.visible && !item.presentation)).toBe(true);
    expect(JSON.stringify(items)).not.toContain("private command");
    const approval = items.find(item => item.kind === "approval")!;
    expect(approval.kind === "approval" && approval.protocol).toBe("v2");
    expect(approval.kind === "approval" && approval.metadata).toEqual({ command: "rm report.docx" });
    const ref = { id: approval.id, revision: approval.revision, workspaceId: source.workspaceId, sessionId: source.sessionId };
    await expect(replyToAssistantAttention(client, approval, { ...ref, revision: "stale", kind: "approval", reply: "once" })).rejects.toThrow("changed");
    expect(sent).toEqual([]);
    await replyToAssistantAttention(client, approval, { ...ref, kind: "approval", reply: "once" });
    expect(sent).toEqual([{ path: "/api/session/child/permission/p/reply", body: { reply: "once" } }]);
    const question = items.find(item => item.kind === "question")!;
    const answer = { id: question.id, revision: question.revision, workspaceId: source.workspaceId, sessionId: source.sessionId };
    await expect(replyToAssistantAttention(client, question, { ...answer, kind: "question", answers: [["Invented"]] })).rejects.toThrow("available choices");
    await replyToAssistantAttention(client, question, { ...answer, kind: "question", answers: [["B"]] });
    expect(sent[1]).toEqual({ path: "/question/q/reply", body: { answers: [["B"]] } });
    expect(items.find(item => item.kind === "widget")?.visible).toBe(false);
    fail = true;
    await expect(readAssistantAttention(client, source)).rejects.toThrow("could not be read");
  } finally { engine.stop(true); }
});


test("raw reads and generic tool results cannot become attention widgets; rich cards reuse resource identity", () => {
  for (const tool of ["legalwork_review_files", "legalwork_review_results", "legalwork_review_list", "legalwork_assistant_project_list", "legalwork_project_list", "read", "widget", "render_ui"]) {
    expect(assistantWidget(tool, '{"title":"Read files"}')).toBeNull();
  }
  expect(assistantWidget("legalwork_calculation_present", '{"title":"Missing card identity"}')).toBeNull();
  const review = { ok: true, workspaceId: "matter", review: { id: "56f829b1-7bba-451c-84df-f310abf1e542", name: "DD", status: "draft", completed: 0, total: 5, documents: 5, columns: 1 } };
  const before = assistantWidget("legalwork_review_create", JSON.stringify(review));
  const after = assistantWidget("legalwork_review_start", JSON.stringify({ ...review, review: { ...review.review, status: "running", completed: 1 } }));
  expect(before?.key).toBeTruthy();
  expect(after?.key).toBe(before?.key);
});
