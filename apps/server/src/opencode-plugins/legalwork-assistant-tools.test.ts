import { expect, test } from "bun:test";
import { LegalWorkAssistantTools } from "./legalwork-assistant-tools.js";

test("overview and unfinished task tools carry exact scope, and live assistant identity never changes the system prompt", async () => {
  const previousUrl = process.env.LEGALWORK_SERVER_URL, previousToken = process.env.LEGALWORK_SERVER_TOKEN;
  const calls: string[] = [];
  let name = "Maya";
  const writes: { path: string; method: string; body: unknown }[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer fixture");
    const url = new URL(request.url); calls.push(url.pathname + url.search);
    if (request.method !== "GET") writes.push({ path: url.pathname, method: request.method, body: await request.json() });
    if (url.pathname === "/workspaces") return Response.json({ items: [{ id: "assistant", path: "/Assistant" }] });
    if (url.pathname === "/assistant") return Response.json({ workspace: { id: "assistant", path: "/Assistant" }, profile: { name } });
    return Response.json({ ok: true });
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture";
  try {
    const plugin = await LegalWorkAssistantTools({ directory: "/Assistant" });
    await plugin.tool.legalwork_assistant_project_overview.execute({ projectId: "matter/id", sessionLimit: 3 });
    await plugin.tool.legalwork_assistant_tasks.execute({ projectId: "matter/id", status: "unfinished", sort: "due" });
    expect(calls).toEqual(["/assistant/projects/matter%2Fid/overview?sessionLimit=3", "/assistant/tasks?projectId=matter%2Fid&status=unfinished&sort=due"]);
    const before: { system: string[] } = { system: [] }, after: { system: string[] } = { system: [] };
    await plugin["experimental.chat.system.transform"]({}, before);
    const turn: { message: { id: string }; parts: object[] } = { message: { id: "msg_1" }, parts: [] };
    await plugin["chat.message"]({ sessionID: "today" }, turn);
    expect(JSON.stringify(turn.parts)).toContain("Maya");
    name = "Momo";
    await plugin["experimental.chat.system.transform"]({}, after);
    expect(after).toEqual(before); expect(before.system.join(" ")).not.toContain("Maya");
    const next: typeof turn = { message: { id: "msg_2" }, parts: [] };
    await plugin["chat.message"]({ sessionID: "today" }, next);
    expect(JSON.stringify(next.parts)).toContain("Momo");
    const project = await LegalWorkAssistantTools({ directory: "/Aster" });
    const other: typeof turn = { message: { id: "msg_3" }, parts: [] };
    await project["chat.message"]({ sessionID: "other" }, other);
    expect(other.parts).toEqual([]);
    await plugin.tool.legalwork_assistant_project_set_metadata.execute({ projectId: "matter/id", revision: 4, values: { client: "Nordstern" } });
    await plugin.tool.legalwork_assistant_delegate.execute({ projectId: "matter/id", title: "Review agreement", conversationLanguage: "en", prompt: "Review the uploaded agreement", scope: "Save review notes", files: ["uploads/agreement.pdf"], initializeProject: true }, { directory: "/Assistant", sessionID: "today" });
    expect(writes).toEqual([
      { path: "/workspace/matter%2Fid/project/metadata", method: "PATCH", body: { revision: 4, values: { client: "Nordstern" } } },
      { path: "/assistant/delegate", method: "POST", body: { workspaceId: "matter/id", sourceWorkspaceId: "assistant", sourceSessionId: "today", title: "Review agreement", conversationLanguage: "en", prompt: "Review the uploaded agreement", scope: "Save review notes", files: ["uploads/agreement.pdf"], initializeProject: true } },
    ]);
    const card = { workspaceId: "matter/id", sessionId: "child", id: "request", revision: "current", title: "Approve report edits?", description: "Allow the project to save the proposed edits." };
    await plugin.tool.legalwork_assistant_attention_present.execute(card, { directory: "/Assistant", sessionID: "today" });
    expect(writes.at(-1)).toEqual({ path: "/assistant/attention/present", method: "POST", body: card });
    const count = writes.length;
    expect(JSON.parse(await plugin.tool.legalwork_assistant_attention_present.execute({ ...card, description: "" }, { directory: "/Assistant", sessionID: "today" })).ok).toBe(false);
    expect(writes).toHaveLength(count);
    expect(before.system.join(" ")).toContain("Reading these items never shows cards");
    const context = { directory: "/Assistant", sessionID: "today", messageID: "reply" };
    await plugin.tool.legalwork_assistant_react.execute({ emoji: "👍" }, context);
    expect(writes.at(-1)).toEqual({ path: "/assistant/react", method: "POST", body: { workspaceId: "assistant", sessionId: "today", assistantMessageId: "reply", emoji: "👍" } });
    await plugin.tool.legalwork_assistant_share_file.execute({ path: "briefings/today.md", title: "Morning briefing" }, context);
    expect(writes.at(-1)).toEqual({ path: "/assistant/share-file", method: "POST", body: { workspaceId: "assistant", sessionId: "today", path: "briefings/today.md", title: "Morning briefing" } });
    await plugin.tool.legalwork_assistant_share_file.execute({ projectId: "matter/id", path: "reports/review.md", title: "Provider-side review" }, context);
    expect(writes.at(-1)).toEqual({ path: "/assistant/share-file", method: "POST", body: { workspaceId: "assistant", sessionId: "today", projectId: "matter/id", path: "reports/review.md", title: "Provider-side review" } });
    expect(before.system.join(" ")).toContain("BOTH the project-chat link and a file card");
  } finally {
    server.stop(true);
    if (previousUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = previousToken;
  }
});
