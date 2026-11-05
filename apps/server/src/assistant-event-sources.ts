import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import type { MainAssistant } from "./main-assistant.js";
import type { AssistantProactivityStore } from "./assistant-proactivity-store.js";
import type { ProactiveEvent } from "./assistant-proactivity-schema.js";
import { taskStore } from "./task-store.js";
import { calendarStore } from "./calendar/store.js";
import { calendarVisible } from "./calendar/service.js";
import { connectedTaskOrgId } from "./tasks-api.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { projectSyncStore } from "./project-sync-store.js";
import { savedConnectorConnections } from "./connectors/broker.js";
import { connectorIsActivated } from "./connectors/settings.js";
import { createConnectorRequest, type ConnectorRequest } from "./connectors/request.js";
import { nativePagePath } from "./connectors/native.js";
import { googleCalendarAdapter, outlookCalendarAdapter } from "./connectors/calendar.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const record = z.looseObject({ id: z.string() });
const googlePage = z.object({ items: z.array(record).default([]), nextPageToken: z.string().optional() });
const graphPage = z.object({ value: z.array(record), "@odata.nextLink": z.string().optional() });
const textField = (item: Record<string, unknown>, key: string) => typeof item[key] === "string" ? item[key] : "";
function event(source: string, id: string, revision: string, at: number, data: unknown, projectId: string | null = null): ProactiveEvent {
  return { id: hash(`${source}:${id}:${revision}`), source, projectId, at, text: JSON.stringify(data).slice(0, 12000) };
}

/** Only the interval after a checkpoint is eligible. Pagination completes before advancing it. */
export async function collectMail(request: ConnectorRequest, provider: "gmail" | "outlook", source: string, since: number, until: number): Promise<ProactiveEvent[]> {
  const events: ProactiveEvent[] = [];
  const sentFolder = provider === "outlook" ? record.parse(await request("/v1.0/me/mailFolders/sentitems?$select=id")).id : null;
  let next: string | undefined;
  const visited = new Set<string>();
  do {
    const pageKey = next ?? "first";
    if (visited.has(pageKey) || visited.size >= 100) throw new Error("Mail pagination did not finish; checkpoint retained.");
    visited.add(pageKey);
    if (provider === "gmail") {
      const query = new URLSearchParams({ maxResults: "100", q: `after:${Math.floor(since / 1000)} before:${Math.ceil(until / 1000)} -in:sent -in:drafts` });
      if (next) query.set("pageToken", next);
      const page = z.object({ messages: z.array(z.object({ id: z.string() })).default([]), nextPageToken: z.string().optional() }).parse(await request(`/gmail/v1/users/me/messages?${query}`));
      for (const { id } of page.messages) {
        const mail = z.object({ id: z.string(), internalDate: z.string(), snippet: z.string().optional(), threadId: z.string().optional(), labelIds: z.array(z.string()).default([]),
          payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) }).optional() })
          .parse(await request(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To`));
        const at = Number(mail.internalDate);
        if (at >= since && at < until && !mail.labelIds.some(label => label === "SENT" || label === "DRAFT"))
          events.push(event(source, mail.id, "received", at, { id: mail.id, threadId: mail.threadId, snippet: mail.snippet, headers: mail.payload?.headers }));
      }
      next = page.nextPageToken;
    } else {
      const path = "/v1.0/me/messages";
      const query = new URLSearchParams({ "$top": "100", "$filter": `receivedDateTime ge ${new Date(since).toISOString()} and receivedDateTime lt ${new Date(until).toISOString()} and isDraft eq false`,
        "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,conversationId,webLink,parentFolderId" });
      const page = graphPage.parse(await request(next ? nativePagePath(next, "https://graph.microsoft.com", path) : `${path}?${query}`, { headers: { Prefer: 'IdType="ImmutableId"' } }));
      for (const mail of page.value) {
        const at = Date.parse(textField(mail, "receivedDateTime"));
        if (at >= since && at < until && mail.parentFolderId !== sentFolder) events.push(event(source, mail.id, "received", at, mail));
      }
      next = page["@odata.nextLink"];
    }
  } while (next);
  return events;
}

export async function collectCalendar(request: ConnectorRequest, provider: "google-calendar" | "outlook-calendar", calendarId: string, source: string, since: number, until: number) {
  const events: ProactiveEvent[] = [];
  let next: string | undefined;
  const visited = new Set<string>();
  do {
    if (visited.has(next ?? "first") || visited.size >= 100) throw new Error("Calendar pagination did not finish; checkpoint retained.");
    visited.add(next ?? "first");
    if (provider === "google-calendar") {
      const query = new URLSearchParams({ maxResults: "100", updatedMin: new Date(since).toISOString(), showDeleted: "true", singleEvents: "false" });
      if (next) query.set("pageToken", next);
      const page = googlePage.parse(await request(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query}`));
      for (const item of page.items) {
        const updated = textField(item, "updated"), at = Date.parse(updated);
        if (at >= since && at < until) events.push(event(source, `${calendarId}:${item.id}`, updated, at, { calendarId, ...item }));
      }
      next = page.nextPageToken;
    } else {
      const path = `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`;
      const query = new URLSearchParams({ "$top": "100", "$filter": `lastModifiedDateTime ge ${new Date(since).toISOString()} and lastModifiedDateTime lt ${new Date(until).toISOString()}`,
        "$select": "id,subject,start,end,organizer,attendees,isCancelled,createdDateTime,lastModifiedDateTime,webLink" });
      const page = graphPage.parse(await request(next ? nativePagePath(next, "https://graph.microsoft.com", path) : `${path}?${query}`, { headers: { Prefer: 'IdType="ImmutableId"' } }));
      for (const item of page.value) {
        const updated = textField(item, "lastModifiedDateTime"), at = Date.parse(updated);
        if (at >= since && at < until) events.push(event(source, `${calendarId}:${item.id}`, updated, at, { calendarId, ...item }));
      }
      next = page["@odata.nextLink"];
    }
  } while (next);
  return events;
}

export function assistantEventSources(config: ServerConfig, assistant: MainAssistant, store: AssistantProactivityStore, resolveWorkspace: (id: string) => Promise<WorkspaceInfo>) {
  async function accessibleProjects(kind: "tasks" | "calendar" = "tasks") {
    const connection = await readEigenweltConnection(config), orgId = connectedTaskOrgId(connection), links = await projectSyncStore(config);
    const projects: WorkspaceInfo[] = [];
    for (const workspace of config.workspaces) {
      if (!assistant.canAccessProject(workspace.id)) continue;
      const link = links.linkByWorkspace(workspace.id);
      if (link && link.role !== "owner" && (link.orgId !== orgId || link.state !== "active" || !link.settings.scope[kind])) continue;
      try { projects.push(await resolveWorkspace(workspace.id)); } catch { /* Revoked/disconnected projects are not sources. */ }
    }
    return { projects, orgId };
  }
  async function allowed(item: ProactiveEvent) {
    if (item.source.startsWith("connector:")) {
      if (assistant.settings().projectAccess.mode !== "all") return false;
      const [provider, account] = z.tuple([z.string(), z.string()]).parse(JSON.parse(item.source.slice(10)));
      return (await savedConnectorConnections(config, provider)).some(connection => connection.id === account && !connection.needsReconnect)
        && await connectorIsActivated(config, provider, account);
    }
    const { projects, orgId } = await accessibleProjects(item.source.startsWith("calendar:") ? "calendar" : "tasks");
    if (item.source.startsWith("tasks:") && item.source !== `tasks:${orgId ?? "local"}`) return false;
    return item.source === `tasks:${orgId ?? "local"}` && !item.projectId || Boolean(item.projectId && projects.some(project => project.id === item.projectId));
  }
  async function collect(now = Date.now(), signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { projects, orgId } = await accessibleProjects(), visible = new Set(projects.map(project => project.id));
    const start = (source: string) => Number(store.cursor(source) ?? store.scratchpad().updatedAt);
    const source = `tasks:${orgId ?? "local"}`, since = start(source), tasks = await taskStore(config);
    const changes: ProactiveEvent[] = [];
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      signal?.throwIfAborted();
      if (visited.has(cursor ?? "first")) throw new Error("Task pagination did not advance.");
      visited.add(cursor ?? "first");
      const page = tasks.listTasks({ sort: "updated", order: "desc", limit: 200, cursor }, orgId);
      for (const task of page.tasks) {
        const at = Date.parse(task.updatedAt);
        if (at >= since && at < now && (!task.projectId || visible.has(task.projectId))) changes.push(event(source, task.id, task.updatedAt, at, {
          id: task.id, title: task.title, description: task.description.slice(0, 3000), status: task.status, assigneeName: task.assigneeName, assigneeUserId: task.assigneeUserId,
          createdByUserId: task.createdByUserId, dueDate: task.dueDate, projectId: task.projectId, createdAt: task.createdAt,
          change: Date.parse(task.createdAt) >= since ? "created" : "updated", assignmentNote: task.assignmentNote,
          evidence: "Assignment actor is unknown unless explicitly recorded in source data; creator does not prove who assigned it.",
        }, task.projectId ?? null));
      }
      cursor = page.tasks.some(task => Date.parse(task.updatedAt) < since) ? undefined : page.nextCursor ?? undefined;
    } while (cursor);
    store.ingest(source, String(now), changes);
    const calendar = await calendarStore(config);
    for (const project of (await accessibleProjects("calendar")).projects) {
      signal?.throwIfAborted();
      if (!await calendarVisible(config, project)) continue;
      const key = `calendar:${project.id}`, after = start(key);
      const events = calendar.list(project.id, true).flatMap(item => {
        const at = Date.parse(item.updatedAt);
        return at >= after && at < now ? [event(key, item.id, String(item.revision), at, item, project.id)] : [];
      });
      store.ingest(key, String(now), events);
    }
    if (assistant.settings().projectAccess.mode !== "all") return;
    for (const provider of ["gmail", "outlook", "google-calendar", "outlook-calendar"]) {
      for (const connection of await savedConnectorConnections(config, provider)) {
        signal?.throwIfAborted();
        if (connection.needsReconnect || !await connectorIsActivated(config, provider, connection.id)) continue;
        const key = `connector:${JSON.stringify([provider, connection.id])}`;
        try {
          const transport = await createConnectorRequest(config, provider, connection.id);
          const request: ConnectorRequest = (path, options) => {
            signal?.throwIfAborted();
            return transport(path, { ...options, signal });
          };
          if (provider === "gmail" || provider === "outlook") store.ingest(key, String(now), await collectMail(request, provider, key, start(key), now));
          else if (provider === "google-calendar" || provider === "outlook-calendar") {
            const api = provider === "google-calendar" ? googleCalendarAdapter : outlookCalendarAdapter;
            let pageToken: string | undefined;
            const seen = new Set<string>();
            do {
              if (seen.has(pageToken ?? "first") || seen.size >= 100) throw new Error("Calendar list did not finish.");
              seen.add(pageToken ?? "first");
              const page = await api.calendars(request, { maxResults: 50, pageToken });
              for (const calendar of page.calendars) {
                const checkpoint = `${key}:${calendar.id}`;
                store.ingest(checkpoint, String(now), await collectCalendar(request, provider, calendar.id, key, start(checkpoint), now));
              }
              pageToken = page.nextPageToken ?? undefined;
            } while (pageToken);
          }
        } catch (error) { console.warn("[assistant-events] Source check failed; checkpoint retained:", provider, error instanceof Error ? error.message : String(error)); }
      }
    }
  }
  return { collect, allowed };
}
