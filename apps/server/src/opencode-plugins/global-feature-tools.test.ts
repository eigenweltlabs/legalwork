import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { LegalWorkAssistantTools } from "./legalwork-assistant-tools.js";
import { LegalWorkCalendarTools } from "./legalwork-calendar-tools.js";
import { LegalWorkScheduledTaskTools } from "./legalwork-scheduled-task-tools.js";
import { LegalWorkTaskTools } from "./legalwork-task-tools.js";

test("Assistant global CRUD uses exact targets and does not link its chat into another project", async () => {
  const oldUrl = process.env.LEGALWORK_SERVER_URL, oldToken = process.env.LEGALWORK_SERVER_TOKEN;
  const calls: { path: string; method: string; body: unknown }[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/session/")) return Response.json({ info: { role: "assistant", providerID: "fixture", modelID: "model" }, parts: [] });
    expect(request.headers.get("authorization")).toBe("Bearer fixture");
    if (url.pathname === "/workspaces") return Response.json({ items: [{ id: "assistant", path: "/Assistant" }, { id: "matter", path: "/Matter" }] });
    if (url.pathname === "/assistant") return Response.json({ workspace: { id: "assistant", path: "/Assistant" } });
    calls.push({ path: url.pathname + url.search, method: request.method, body: request.body ? await request.json() : null });
    return Response.json({ task: { id: "task-one", projectId: "matter" }, items: [], tasks: [] });
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture";
  try {
    const context = { directory: "/Assistant", sessionID: "today", messageID: "running" };
    const calendar = (await LegalWorkCalendarTools()).tool;
    const schedules = (await LegalWorkScheduledTaskTools({ client: createOpencodeClient({ baseUrl: server.url.origin }) })).tool;
    const assistant = (await LegalWorkAssistantTools()).tool;
    const tasks = (await LegalWorkTaskTools()).tool;
    if (!tasks) throw new Error("Missing task tools");
    const id = "08745cc6-4e59-4d81-953b-19d8ec595ee4";
    await assistant.legalwork_assistant_set_name.execute({ name: "Hannes" }, context);
    expect(calls.at(-1)).toMatchObject({ path: "/assistant/name", method: "POST", body: { name: "Hannes" } });
    const beforeNaming = calls.length;
    expect(JSON.parse(await assistant.legalwork_assistant_set_name.execute({ name: "Wrong" }, { directory: "/Matter" })).ok).toBe(false);
    expect(calls).toHaveLength(beforeNaming);
    await calendar.legalwork_calendar_create.execute({ title: "Lunch", kind: "event", start: "2099-10-08" }, context);
    expect(calls.at(-1)).toMatchObject({ path: "/workspace/assistant/calendar", body: { kind: "event", sessionIds: ["today"] } });
    await calendar.legalwork_calendar_create.execute({ projectId: "matter", title: "Meeting", kind: "event", start: "2099-10-08" }, context);
    expect(calls.at(-1)).toMatchObject({ path: "/workspace/matter/calendar", body: { sessionIds: [] } });
    await calendar.legalwork_calendar_update.execute({ projectId: "matter", itemId: id, patch: { revision: 2, title: "Updated" } }, context);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: `/workspace/matter/calendar/${id}`, body: { revision: 2, title: "Updated" } });
    for (const [tool, action] of [[calendar.legalwork_calendar_delete, "delete"], [calendar.legalwork_calendar_restore, "restore"]]) {
      if (typeof tool === "string") throw new Error("Unexpected tool");
      await tool.execute({ projectId: "matter", itemId: id, revision: 3 }, context);
      expect(calls.at(-1)).toMatchObject({ path: `/workspace/matter/calendar/${id}/${action}`, body: { revision: 3 } });
    }
    const before = calls.length;
    const denied = JSON.parse(await calendar.legalwork_calendar_get.execute({ projectId: "assistant", itemId: id }, { directory: "/Matter" }));
    expect(denied.ok).toBe(false); expect(calls).toHaveLength(before);
    await tasks.legalwork_task_create.execute({ title: "Task", projectId: "matter" }, context);
    expect(calls.at(-1)).toMatchObject({ path: "/workspace/assistant/tasks", body: { projectId: "matter", sessionId: "today" } });
    await tasks.legalwork_task_update.execute({ taskId: "task-one", projectId: null }, context);
    expect(calls.at(-1)?.body).toEqual({ projectId: null });
    await tasks.legalwork_task_restore.execute({ taskId: "task-one" }, context);
    expect(calls.at(-1)?.path).toBe("/workspace/assistant/tasks/task-one/restore");
    await schedules.legalwork_schedule_list_all.execute({ query: "brief", limit: 5 }, context);
    expect(calls.at(-1)?.path).toBe("/scheduled-tasks?query=brief&limit=5");
    await schedules.legalwork_schedule_create.execute({ projectId: "matter", title: "Reminder", prompt: "Report status", schedule: { kind: "once", startAt: "2099-10-08T06:00:00" } }, context);
    expect(calls.at(-1)).toMatchObject({ path: "/workspace/matter/scheduled-tasks", body: { sessionId: null, reuseChat: false } });
    await schedules.legalwork_schedule_update.execute({ projectId: "matter", taskId: id, revision: 2, patch: { status: "paused" } }, context);
    expect(calls.at(-1)).toMatchObject({ path: `/workspace/matter/scheduled-tasks/${id}`, body: { revision: 2, status: "paused" } });
    await assistant.legalwork_assistant_recordings.execute({ query: "client", searchTranscripts: true }, context);
    expect(calls.at(-1)?.path).toBe("/assistant/recordings?query=client&searchTranscripts=true");
    await assistant.legalwork_assistant_recording_project.execute({ recordingId: "rec-1", projectId: "matter", linked: true }, context);
    expect(calls.at(-1)).toMatchObject({ path: "/assistant/recordings/rec-1/project", body: { projectId: "matter", linked: true } });
    await assistant.legalwork_assistant_recording_delete.execute({ recordingId: "rec-1" }, context);
    expect(calls.at(-1)).toMatchObject({ path: "/assistant/recordings/rec-1", method: "DELETE" });
    await assistant.legalwork_assistant_recorder.execute({ action: "status" }, context);
    expect(calls.at(-1)).toMatchObject({ path: "/assistant/recorder", method: "GET" });
    await assistant.legalwork_assistant_recorder.execute({ action: "stop", recordingId: "rec-1" }, context);
    expect(calls.at(-1)?.body).toEqual({ action: "stop", recordingId: "rec-1" });
    const length = calls.length;
    expect(JSON.parse(await assistant.legalwork_assistant_recorder.execute({ action: "start" }, { directory: "/Matter" })).ok).toBe(false);
    expect(calls).toHaveLength(length);
  } finally {
    server.stop(true);
    if (oldUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = oldToken;
  }
});
