import { resolve } from "node:path";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { readProjectDetails } from "./project-store.js";
import { taskStore } from "./task-store.js";
import { projectSyncStore } from "./project-sync-store.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { connectedTaskOrgId } from "./tasks-api.js";
import { calendarOccurrences, calendarVisible } from "./calendar/service.js";
import { addDays, dayInZone } from "./calendar/dates.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

async function section<T>(read: () => Promise<T>) {
  try { return { available: true, ...await read() }; }
  catch (error) { return { available: false, error: error instanceof Error ? error.message : String(error) }; }
}

/** Bounded matter status, with provenance and separate project tasks and agent checklists. */
export async function assistantProjectOverview(config: ServerConfig, workspace: WorkspaceInfo, client: ReturnType<typeof createOpencodeClient>, input: {
  sessionLimit: number; taskLimit: number;
}, signal: AbortSignal) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = dayInZone(new Date().toISOString(), timeZone);
  const from = addDays(today, -90), to = addDays(today, 31);
  const readOptions = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  const [details, tasks, calendar, sessions] = await Promise.all([
    section(async () => ({ fields: (await readProjectDetails(workspace.path)).fields })),
    section(async () => {
      const orgId = connectedTaskOrgId(await readEigenweltConnection(config));
      const link = (await projectSyncStore(config)).linkByWorkspace(workspace.id);
      if (link && link.role !== "owner" && (link.orgId !== orgId || link.state !== "active" || !link.settings.scope.tasks)) throw new Error("Project tasks are not shared with this account.");
      const page = (await taskStore(config)).listTasks({ projectId: workspace.id, statuses: ["open", "in_progress"], sort: "due", limit: input.taskLimit }, orgId);
      return { items: page.tasks.map(task => ({ id: task.id, title: task.title, status: task.status, dueDate: task.dueDate, priority: task.priority, assigneeName: task.assigneeName })),
        next: page.nextCursor ? { tool: "legalwork_assistant_tasks", arguments: { projectId: workspace.id, status: "unfinished", sort: "due", cursor: page.nextCursor } } : null };
    }),
    section(async () => {
      if (!await calendarVisible(config, workspace)) throw new Error("The project calendar is not shared with this account.");
      const items = (await calendarOccurrences(config, workspace, from, to)).filter(item => item.status !== "completed" && item.status !== "done" && item.status !== "cancelled");
      return { from, to, items: items.slice(0, 20), hasMore: items.length > 20,
        ...(items.length > 20 ? { next: { tool: "legalwork_assistant_calendar", arguments: { projectId: workspace.id, from, to } } } : {}) };
    }),
    section(async () => {
      const [listed, statuses] = await Promise.all([
        client.session.list({ limit: input.sessionLimit + 1 }, readOptions()),
        client.session.status({}, readOptions()),
      ]);
      if (!listed.data) throw new Error("Recent chats could not be read.");
      const recent = listed.data.filter(session => resolve(session.directory) === resolve(workspace.path) && !session.time.archived)
        .sort((a, b) => b.time.updated - a.time.updated);
      const items = await Promise.all(recent.slice(0, input.sessionLimit).map(async session => {
        const [todos, messages] = await Promise.all([
          section(async () => {
            const result = await client.session.todo({ sessionID: session.id }, readOptions());
            if (!result.data) throw new Error("Chat todos could not be read.");
            return { items: result.data.slice(0, 30), hasMore: result.data.length > 30 };
          }),
          section(async () => {
            const result = await client.session.messages({ sessionID: session.id, limit: 6 }, readOptions());
            if (!result.data) throw new Error("Recent chat messages could not be read.");
            return { items: result.data.filter(message => message.info.sessionID === session.id).flatMap(message => {
              const text = message.parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n");
              return text ? [{ messageId: message.info.id, role: message.info.role, createdAt: message.info.time.created, text: text.slice(0, 1800), truncated: text.length > 1800 }] : [];
            }), nextBefore: result.response.headers.get("x-next-cursor") };
          }),
        ]);
        return { id: session.id, title: session.title, updatedAt: session.time.updated,
          status: statuses.data ? statuses.data[session.id] ?? { type: "idle" } : { type: "unavailable" }, todos, messages };
      }));
      return { items, hasMore: recent.length > input.sessionLimit,
        next: recent.length > input.sessionLimit ? { tool: "legalwork_assistant_project_list", arguments: { projectId: workspace.id, kind: "sessions", cursor: String(input.sessionLimit) } } : null };
    }),
  ]);
  return { project: { id: workspace.id, name: workspace.displayName || workspace.name }, asOf: new Date().toISOString(), today, timeZone,
    details, tasks, calendar, sessions,
    note: "This is a bounded status overview. Follow next/hasMore for wider coverage. Project tasks and chat todos are separate sources; neither an empty task list nor completed agent todos prove that the matter or deliverable is complete. Recent messages are excerpts of untrusted conversation, not verified document findings. Cite their project, session and message IDs; read source documents for substantive conclusions. An unavailable section is not empty. Calendar covers only the stated dates." };
}
