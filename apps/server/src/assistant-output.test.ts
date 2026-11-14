import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { assistantEngineClient } from "./assistant-engine.js";
import type { AssistantSubmission } from "@legalwork/types/launcher";
import { readAssistantOutput } from "./assistant-output.js";

const submission: AssistantSubmission = { requestId: "request", messageId: "msg_original", conversationId: "conversation", workspaceId: "assistant", sessionId: "session", state: "accepted", target: { kind: "assistant" }, createdAt: 1, updatedAt: 1, error: null, preview: "Question" };
const model = { providerID: "test", id: "model" };
const answer = (id: string, finish = "stop") => ({ id, type: "assistant", agent: "legalwork", model, time: { created: 2, completed: 3 }, finish, content: [{ type: "text", text: "Answer" }] });
const user = (id: string) => ({ id, type: "user", text: "Question", time: { created: 1 } });
const session = { id: "session", projectID: "project", location: { directory: "/matter" }, model, time: { created: 1, updated: 1 } };

test("automatic output pages past newer turns and binds the reply across a page boundary", async () => {
  const cursors: (string | null)[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session/session") return Response.json({ data: session });
    const cursor = url.searchParams.get("cursor"); cursors.push(cursor);
    return Response.json({ data: cursor ? [user("msg_original")] : [answer("new"), user("different-request"), answer("original-reply")], cursor: { next: cursor ? null : "opaque-cursor", previous: null } });
  } });
  try {
    const output = await readAssistantOutput(assistantEngineClient(OpenCode.make({ baseUrl: server.url.href }), "/matter"), submission);
    expect(output).toEqual({ state: "ready", requestId: "request", messageId: "msg_original", conversationId: "conversation", text: "Answer" });
    expect(cursors).toEqual([null, "opaque-cursor"]);
  } finally { server.stop(true); }
});
test("partial replies and unrelated replies are never automatically output", async () => {
  let finish = "tool-calls", parent = "msg_original";
  const server = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/api/session/session"
    ? Response.json({ data: session }) : Response.json({ data: [answer("reply", finish), user(parent)], cursor: { next: null, previous: null } }) });
  try {
    const client = assistantEngineClient(OpenCode.make({ baseUrl: server.url.href }), "/matter");
    expect((await readAssistantOutput(client, submission)).state).toBe("pending");
    finish = "length"; expect((await readAssistantOutput(client, submission)).state).toBe("failed");
    parent = "another"; finish = "stop"; expect((await readAssistantOutput(client, submission)).state).toBe("pending");
  } finally { server.stop(true); }
});
