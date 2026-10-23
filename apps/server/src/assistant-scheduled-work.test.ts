import { expect, test } from "bun:test";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2/client";
import { ScheduledTaskSchema } from "./scheduled-tasks/schema.js";
import type { TrackedDelegation } from "./assistant-delegations.js";
import type { WorkspaceInfo } from "./types.js";
import { createAssistantScheduledSession, prepareAssistantScheduledWork } from "./assistant-scheduled-work.js";
import { z } from "zod";

test("Assistant schedules create fresh workers linked to the current day and never copy its history", async () => {
  const workspace: WorkspaceInfo = { id: "assistant", name: "Assistant", path: "/assistant", preset: "main-assistant", workspaceType: "local" };
  const task = ScheduledTaskSchema.parse({ id: "00000000-0000-4000-8000-000000000001", workspaceId: workspace.id,
    title: "Morning briefing", prompt: "Read the source records and save briefings/today.md.", sessionId: "legacy-daily", reuseChat: true, model: null,
    schedule: { kind: "once", startAt: "2026-10-20T06:00:00Z", timeZone: "UTC" }, revision: 1, status: "active", nextRunAt: null, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" });
  const session = (id: string, parentID?: string, directory = workspace.path): Session => ({ id, parentID, directory, title: id, slug: id, projectID: "assistant", version: "1", time: { created: 1, updated: 1 } });
  const sessions = new Map([session("day-one"), session("day-two")].map(item => [item.id, item]));
  const creates: { title: string; parentID: string }[] = [];
  const limits: string[] = [];
  let malformed = false;
  const engine = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/session" && request.method === "POST") {
      const input = z.object({ title: z.string(), parentID: z.string() }).parse(await request.json()); creates.push(input);
      const child = session(`worker-${creates.length}`, malformed ? undefined : input.parentID);
      sessions.set(child.id, child); return Response.json(child);
    }
    if (url.pathname.endsWith("/message")) {
      limits.push(url.searchParams.get("limit") ?? "");
      return Response.json([{ info: { id: "last", sessionID: url.pathname.split("/")[2], role: "user", agent: "legalwork", time: { created: 1 }, model: { providerID: "chosen", modelID: "fast" } }, parts: [{ type: "text", text: "PRIVATE_PARENT_HISTORY".repeat(10000) }] }]);
    }
    const item = sessions.get(url.pathname.split("/")[2]);
    return item ? Response.json(item) : new Response(null, { status: 404 });
  } });
  const client = createOpencodeClient({ baseUrl: engine.url.origin, directory: workspace.path });
  let date = "one";
  const assistant = { current: async () => ({ workspace, day: { date, sessionId: `day-${date}` } }) };
  const tracked: TrackedDelegation[] = [];
  const delegations = { track: (work: TrackedDelegation) => { tracked.push(work); } };
  try {
    for (const next of ["one", "one", "two"]) {
      date = next;
      const id = await createAssistantScheduledSession(task, assistant, client);
      const child = sessions.get(id); if (!child) throw new Error("Missing worker");
      const work = await prepareAssistantScheduledWork(task, workspace, child, client, delegations);
      expect(id).not.toBe(`day-${next}`); expect(id).not.toBe(task.sessionId);
      expect(work.model).toEqual({ providerID: "chosen", modelID: "fast" });
      expect(work.prompt).toContain(task.prompt);
      expect(work.prompt).not.toContain("PRIVATE_PARENT_HISTORY");
      expect(tracked.at(-1)).toMatchObject({ sourceSessionId: `day-${next}`, sessionId: id, scheduledTaskId: task.id });
    }
    expect(creates.map(item => item.parentID)).toEqual(["day-one", "day-one", "day-two"]);
    expect(new Set(tracked.map(item => item.sessionId)).size).toBe(3);
    expect(limits).toEqual(["1", "1", "1"]);
    const child = session("explicit", "day-two");
    expect((await prepareAssistantScheduledWork({ ...task, model: { providerID: "explicit", modelID: "model" } }, workspace, child, client, delegations)).model).toEqual({ providerID: "explicit", modelID: "model" });
    await expect(prepareAssistantScheduledWork(task, workspace, session("daily"), client, delegations)).rejects.toThrow("isolated worker");
    sessions.set("outside", session("outside", undefined, "/other-project"));
    await expect(prepareAssistantScheduledWork(task, workspace, session("wrong-parent", "outside"), client, delegations)).rejects.toThrow("source chat");
    malformed = true;
    await expect(createAssistantScheduledSession(task, assistant, client)).rejects.toThrow("isolated Assistant worker");
  } finally { engine.stop(true); }
});
