import { afterAll, beforeEach, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { recoverEmptyReviewResponse } from "./recover-empty-review-response.js";

let finish = "stop", error = false, text = "", hasTool = false, pending = true, busy = false, changed = false, summary = false, synthetic = false, longRun = false, savedReview = true, reminder = false;
const prompts: unknown[] = [];
const user = { id: "user", role: "user", agent: "legalwork", model: { providerID: "eigenwelt", modelID: "Gemini" } };
const server = Bun.serve({ port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/prompt_async")) { prompts.push(await request.json()); return new Response(null, { status: 204 }); }
  if (url.pathname.endsWith("/todo")) return Response.json([{ content: "Write DD report", status: pending ? "in_progress" : "completed", priority: "high", id: "todo" }]);
  if (url.pathname === "/session/status") return Response.json({ test: { type: busy ? "busy" : "idle" } });
  const parent = { info: user, parts: [{ type: "text", text: "Run DD", synthetic }, ...(reminder ? [{ type: "text", text: "<system-reminder>\nProject configuration\n</system-reminder>", synthetic: true }] : [])] };
  if (url.pathname.endsWith("/message/user")) return Response.json(parent);
  const last = { info: { id: "empty", role: "assistant", parentID: "user", finish, summary, ...(error ? { error: { name: "APIError", data: { message: "Budget has been exceeded" } } } : {}) },
    parts: [{ type: "reasoning", text: "Preparing the report" }, ...(text ? [{ type: "text", text }] : []), ...(hasTool ? [{ type: "tool", tool: "write" }] : [])] };
  const history = [parent, ...(savedReview ? [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "legalwork_review_results" }] }] : []),
    ...(longRun ? Array.from({ length: 30 }, (_, index) => ({ info: { id: `step-${index}`, role: "assistant" }, parts: [{ type: "tool", tool: "read" }] })) : []), last];
  return Response.json(url.searchParams.get("limit") === "1" && changed ? [{ info: { ...user, id: "new-input" }, parts: [] }] : history.slice(-Number(url.searchParams.get("limit") ?? 100)));
} });
const client = createOpencodeClient({ baseUrl: server.url.origin });
const idle = { event: { type: "session.idle", properties: { sessionID: "test" } } } satisfies Parameters<ReturnType<typeof recoverEmptyReviewResponse>>[0];
beforeEach(() => { finish = "stop"; error = false; text = ""; hasTool = false; pending = true; busy = false; changed = false; summary = false; synthetic = false; longRun = false; savedReview = true; reminder = false; prompts.length = 0; });
afterAll(() => server.stop(true));

test("recovers an empty normal stop once using the same model and saved work", async () => {
  const recover = recoverEmptyReviewResponse(client, "/project");
  await recover(idle); await recover(idle);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ agent: user.agent, model: user.model, parts: [{ type: "text", synthetic: true, text: expect.stringContaining("Reuse existing reviews") }] });
});
test("never continues real answers, tool calls, budget errors, compaction or finished tasks", async () => {
  for (const change of [() => { text = "Need approval"; }, () => { hasTool = true; }, () => { error = true; }, () => { finish = "length"; }, () => { summary = true; }, () => { pending = false; }, () => { synthetic = true; }]) {
    beforeCase(); change(); await recoverEmptyReviewResponse(client)(idle); expect(prompts).toHaveLength(0);
  }
});
test("an app-state reminder next to the user's own text does not block recovery", async () => {
  reminder = true;
  await recoverEmptyReviewResponse(client)(idle);
  expect(prompts).toHaveLength(1);
});
test("new human input and a concurrently running session cancel recovery", async () => {
  changed = true; await recoverEmptyReviewResponse(client)(idle); expect(prompts).toHaveLength(0);
  changed = false; busy = true; await recoverEmptyReviewResponse(client)(idle); expect(prompts).toHaveLength(0);
});
test("recovers the DD stop when its human request and review calls are outside the latest message page", async () => {
  longRun = true;
  await recoverEmptyReviewResponse(client)(idle);
  expect(prompts).toHaveLength(1);
});
test("live review events support arbitrarily long workflows, while unrelated stops do not recover", async () => {
  longRun = true; savedReview = false;
  await recoverEmptyReviewResponse(client)(idle);
  expect(prompts).toHaveLength(0);
  const recover = recoverEmptyReviewResponse(client);
  await recover({ event: { type: "message.part.updated", properties: { part: {
    type: "tool", id: "review-tool", messageID: "review-message", sessionID: "test", callID: "review-call", tool: "legalwork_review_start",
    state: { status: "completed", input: {}, output: "Started", title: "Start review", metadata: {}, time: { start: 1, end: 2 } },
  } } } });
  await recover(idle);
  expect(prompts).toHaveLength(1);
});
function beforeCase() { finish = "stop"; error = false; text = ""; hasTool = false; pending = true; summary = false; synthetic = false; }
