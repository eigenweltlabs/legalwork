import { randomUUID } from "node:crypto";
import { realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { EmailDraftInputSchema, EmailDraftSchema, emailAddressSpecs, type EmailDraft } from "../email-drafts/schema.js";
import { CalendarEventDraftInputSchema, CalendarEventDraftSchema, type CalendarEventDraft } from "../calendar-event-drafts/schema.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import { withFileWriteLocks } from "../file-write-lock.js";
import { draftPaths, readDraft, saveDraftFiles, saveEmailDraft, readEmailDraftMime, prepareEmailDraftReload } from "../email-drafts/store.js";
import { eventDraftTimes, renderEventDraft } from "../calendar-event-drafts/ics.js";
import { savedConnectorConnections } from "./broker.js";
import { requireConnectorConnectSlot } from "./single-connection.js";
import { ensureConnectorWritesAllowed, requireConnectorActivated } from "./settings.js";
import { requireLocalOAuthSendAccess } from "./local-oauth.js";
import { createConnectorRequest } from "./request.js";
import { calendarCreateInput, calendarEventInput, googleCalendarUpdateInput, googleCalendarAdapter, outlookCalendarAdapter } from "./calendar.js";
import { mailDraftInput } from "./mail.js";
import { parseNative } from "./native.js";

export const connectorEmailDraftInput = mailDraftInput.extend({
  html: EmailDraftInputSchema.shape.html, from: EmailDraftInputSchema.shape.from, replyTo: EmailDraftInputSchema.shape.replyTo,
  attachments: EmailDraftInputSchema.shape.attachments,
});
export const connectorCalendarDraftInput = calendarCreateInput.safeExtend({ timeZone: CalendarEventDraftInputSchema.shape.timeZone, reminders: CalendarEventDraftInputSchema.shape.reminders });
export const connectorGoogleCalendarDraftInput = connectorCalendarDraftInput.safeExtend({ googleMeet: z.boolean().default(false) });
export const connectorSendDraftInput = z.object({ draftId: z.uuid(), revision: z.uuid() }).strict();

async function connectedAccount(config: ServerConfig, id: string, requested?: string) {
  await ensureConnectorWritesAllowed(config, id);
  const connections = await savedConnectorConnections(config, id);
  const selected = requested ?? connections[0]?.id;
  requireConnectorConnectSlot(connections, selected);
  if (!selected) throw new ApiError(409, "connector_not_connected", "Connect this account in Integrations first.");
  await requireConnectorActivated(config, id, selected);
  return selected;
}

export async function connectorDraftWorkspace(config: ServerConfig, context: Record<string, unknown>) {
  if (typeof context.directory !== "string" || !context.directory.trim()) throw new ApiError(400, "connector_draft_workspace", "Prepare this draft from a project chat.");
  const directory = await realpath(resolve(context.directory));
  const candidates = [...config.workspaces].sort((a, b) => b.path.length - a.path.length);
  for (const workspace of candidates) {
    const root = await realpath(resolve(workspace.path));
    const child = relative(root, directory);
    if (child !== "" && (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))) continue;
    for (const allowed of config.authorizedRoots) {
      const relation = relative(await realpath(resolve(allowed)), root);
      if (relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))) return { ...workspace, path: root };
    }
    throw new ApiError(403, "workspace_unauthorized", "This project folder is not authorized.");
  }
  throw new ApiError(404, "workspace_not_found", "No project matches this chat.");
}

export async function prepareConnectorEmailDraft(config: ServerConfig, id: string, args: Record<string, unknown>, context: Record<string, unknown>) {
  if (id !== "gmail" && id !== "outlook") throw new ApiError(400, "connector_draft_provider", "Choose an email connector.");
  const input = connectorEmailDraftInput.parse(args);
  const connectionId = await connectedAccount(config, id, input.connectionId);
  const workspace = await connectorDraftWorkspace(config, context);
  const draft = await saveEmailDraft(workspace.path, workspace.id, EmailDraftInputSchema.parse({ ...input, to: input.to.join(", "), cc: input.cc.join(", "), bcc: input.bcc.join(", ") }), undefined, { connectorId: id, connectionId });
  return { draft, instruction: "This is an editable local preview. No email was sent or saved in the provider. The user can save it to the connected mailbox or send it from the card." };
}

export async function prepareConnectorCalendarDraft(config: ServerConfig, id: string, args: Record<string, unknown>, context: Record<string, unknown>) {
  if (id !== "google-calendar" && id !== "outlook-calendar") throw new ApiError(400, "connector_draft_provider", "Choose a calendar connector.");
  const input = (id === "google-calendar" ? connectorGoogleCalendarDraftInput : connectorCalendarDraftInput).parse(args);
  const connectionId = await connectedAccount(config, id, input.connectionId);
  const workspace = await connectorDraftWorkspace(config, context);
  const event = CalendarEventDraftInputSchema.parse(input);
  const wantsMeet = "googleMeet" in input && input.googleMeet;
  const capabilities = wantsMeet ? await googleCalendarAdapter.capabilities(await createConnectorRequest(config, id, connectionId), input) : undefined;
  if (wantsMeet && !capabilities?.canAddMeet) throw new ApiError(400, "connector_meet_unavailable", "Google Meet is not available for this calendar.");
  const draft = CalendarEventDraftSchema.parse(await saveDraftFiles(workspace.path, workspace.id, "calendar", async (draftId) => ({
    input: { ...event, ...eventDraftTimes(event), sequence: 0, connectorTarget: { connectorId: id, connectionId, calendarId: input.calendarId }, ...(id === "google-calendar" ? { googleCalendar: { requestId: randomUUID(), ...(capabilities ? { canAddMeet: capabilities.canAddMeet } : {}), conference: { status: "none" } } } : {}) }, content: renderEventDraft(event, draftId, 0),
  })));
  return { draft, instruction: "This is an editable local preview. No calendar entry or invitation was created. The user adds it to the connected calendar from the card." };
}

export async function prepareConnectorCalendarUpdate(config: ServerConfig, args: Record<string, unknown>, context: Record<string, unknown>) {
  const input = googleCalendarUpdateInput.parse(args);
  const connectionId = await connectedAccount(config, "google-calendar", input.connectionId);
  const workspace = await connectorDraftWorkspace(config, context);
  const request = await createConnectorRequest(config, "google-calendar", connectionId);
  const current = await googleCalendarAdapter.get(request, input);
  if (!current.etag || !current.start || !current.end || current.status === "cancelled") throw new ApiError(409, "connector_calendar_version", "This event cannot be edited. Read its current details again.");
  if (current.recurrence.length) throw new ApiError(400, "connector_calendar_series", "Choose a specific occurrence from list_events. Editing an entire recurring series is not supported.");
  if (current.eventType !== "default") throw new ApiError(400, "connector_calendar_event_type", "Edit this special event in Google Calendar.");
  const capabilities = await googleCalendarAdapter.capabilities(request, input);
  if (input.googleMeet && !capabilities.canAddMeet && current.conference.status === "none") throw new ApiError(400, "connector_meet_unavailable", "Google Meet is not available for this calendar.");
  if (input.googleMeet && current.conference.type && current.conference.type !== "hangoutsMeet") throw new ApiError(400, "connector_calendar_conference", "This event already has a conference. Open Google Calendar to change it.");
  const original = CalendarEventDraftInputSchema.parse({ title: current.title || "Untitled event", description: current.description, location: current.location, start: current.start, end: current.end, timeZone: current.timeZone ?? capabilities.timeZone, reminders: current.reminders?.overrides?.filter(reminder => reminder.method === "popup").map(reminder => reminder.minutes) ?? [], attendees: current.attendees.flatMap(guest => guest.email ? [guest.email] : []).join(", "), organizer: current.organizer?.email ?? "" });
  const event = CalendarEventDraftInputSchema.parse({ ...original, ...Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined && ["title", "description", "location", "start", "end", "timeZone", "reminders", "googleMeet"].includes(key))) });
  if (input.allDay !== undefined && input.allDay !== (event.start.length === 10)) throw new ApiError(400, "connector_calendar_dates", "Use dates for all-day events and timestamps for timed events.");
  const draft = CalendarEventDraftSchema.parse(await saveDraftFiles(workspace.path, workspace.id, "calendar", async (draftId) => ({
    input: { ...event, ...eventDraftTimes(event), sequence: 0, connectorTarget: { connectorId: "google-calendar", connectionId, calendarId: input.calendarId }, googleCalendar: { requestId: randomUUID(), canAddMeet: capabilities.canAddMeet, conference: current.conference, update: { eventId: current.id, etag: current.etag, original, ...(current.recurringEventId ? { recurringEventId: current.recurringEventId } : {}), ...(current.webUrl ? { webUrl: providerLink(current.webUrl, ["calendar.google.com", "www.google.com"], "https://calendar.google.com") } : {}) } } }, content: renderEventDraft(event, draftId, 0),
  })));
  return { draft, instruction: "This card reviews changes to the existing event, or this recurring occurrence only. No provider change has been made. The user applies the update from the card; guests are preserved and notifications are disabled." };
}

function providerLink(value: string | undefined, hosts: string[], fallback: string) {
  if (!value) return fallback;
  const url = new URL(value);
  if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.username || url.password) throw new ApiError(502, "connector_api_invalid", "The provider returned an invalid app link.");
  return url.href;
}

async function draftOperation<T extends EmailDraft | CalendarEventDraft>(workspace: WorkspaceInfo, id: string, revision: string, kind: "email" | "calendar", schema: z.ZodType<T>, run: (draft: T, persist: (draft: T) => Promise<void>) => Promise<T>) {
  const paths = await draftPaths(workspace.path, id, kind);
  return withFileWriteLocks([paths.metadata, paths.artifact], async () => {
    const draft = schema.parse(await readDraft(workspace.path, id, kind));
    if (draft.workspaceId !== workspace.id) throw new ApiError(404, "connector_draft_missing", "Draft not found in this project.");
    if (draft.revision !== revision) throw new ApiError(409, "draft_conflict", "This draft changed. Reload it before continuing.");
    if (["saving", "sending", "uncertain"].includes(draft.delivery?.state ?? "")) throw new ApiError(409, "connector_delivery_uncertain", "The previous request may have completed. Check the connected app before creating or sending another item.");
    const persist = async (value: T) => {
      await draftPaths(workspace.path, id, kind);
      const temp = `${paths.metadata}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, paths.metadata); }
      finally { await rm(temp, { force: true }); }
    };
    return { draft: await run(draft, persist) };
  });
}

async function attempt<T extends EmailDraft | CalendarEventDraft>(draft: T, state: "saving" | "sending", persist: (draft: T) => Promise<void>, perform: () => Promise<T>) {
  await persist({ ...draft, delivery: { ...draft.delivery, state } });
  try { const result = await perform(); await persist(result); return result; }
  catch (error) {
    // An ambiguous provider response must never lead to an automatic duplicate or send retry.
    await persist(error instanceof ApiError && error.status < 500 ? draft : { ...draft, delivery: { ...draft.delivery, state: "uncertain" } });
    throw error;
  }
}

export async function deliverConnectorEmailDraft(config: ServerConfig, workspace: WorkspaceInfo, id: string, revision: string, operation: "save" | "send", expectedConnectorId?: string) {
  return draftOperation(workspace, id, revision, "email", EmailDraftSchema, async (initial, persist) => {
    const target = initial.connectorTarget;
    if (!target) throw new ApiError(400, "connector_draft_provider", "This draft does not use a connected email account.");
    if (expectedConnectorId && target.connectorId !== expectedConnectorId) throw new ApiError(400, "connector_draft_provider", "Choose this draft's email connector.");
    await connectedAccount(config, target.connectorId, target.connectionId);
    if (initial.delivery?.state === "sent") throw new ApiError(409, "connector_draft_sent", "This email has already been sent.");
    if (operation === "send") {
      const recipients = [initial.to, initial.cc, initial.bcc].flatMap(emailAddressSpecs);
      if (!recipients.length || recipients.some((value) => !z.email().safeParse(value).success)) throw new ApiError(400, "connector_email_recipients", "Enter valid recipients before sending.");
      await requireLocalOAuthSendAccess(config, target.connectorId, target.connectionId);
    }
    const request = await createConnectorRequest(config, target.connectorId, target.connectionId);
    let draft = initial;
    if (!draft.delivery) {
      const limit = target.connectorId === "outlook" ? 3 * 1024 * 1024 : 25 * 1024 * 1024;
      const mime = await readEmailDraftMime(workspace.path, draft, limit);
      const gmailAccount = target.connectorId === "gmail" ? parseNative(z.object({ emailAddress: z.string() }), await request("/gmail/v1/users/me/profile?fields=emailAddress")).emailAddress : null;
      draft = await attempt(draft, "saving", persist, async () => {
        if (target.connectorId === "gmail") {
          if (!gmailAccount) throw new ApiError(502, "connector_api_invalid", "Gmail did not identify the connected account.");
          const saved = parseNative(z.object({ id: z.string(), message: z.object({ id: z.string(), threadId: z.string().optional() }) }), await request("/gmail/v1/users/me/drafts", { method: "POST", body: { message: { raw: mime.toString("base64url") } } }));
          return { ...draft, revision: randomUUID(), delivery: { state: "saved", id: saved.id, messageId: saved.message.id, webUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(gmailAccount)}#drafts/${encodeURIComponent(saved.message.threadId ?? saved.message.id)}` } };
        }
        const saved = parseNative(z.object({ id: z.string(), changeKey: z.string(), webLink: z.string().optional() }), await request("/v1.0/me/messages", { method: "POST", rawBody: new Blob([mime.toString("base64")]), headers: { "Content-Type": "text/plain", Prefer: 'IdType="ImmutableId"' } }));
        return { ...draft, revision: randomUUID(), delivery: { state: "saved", id: saved.id, version: saved.changeKey, webUrl: providerLink(saved.webLink, ["outlook.office.com", "outlook.office365.com", "outlook.live.com"], "https://outlook.office.com/mail/drafts") } };
      });
    }
    if (operation === "save") return draft;
    const delivery = draft.delivery;
    if (!delivery?.id || delivery.state !== "saved") throw new ApiError(409, "connector_draft_not_saved", "Save this draft to its connected mailbox before sending.");
    const providerId = delivery.id;
    if (target.connectorId === "gmail") {
      const current = parseNative(z.object({ message: z.object({ id: z.string() }) }), await request(`/gmail/v1/users/me/drafts/${encodeURIComponent(delivery.id)}?fields=message(id)`));
      if (current.message.id !== delivery.messageId) throw new ApiError(409, "connector_draft_changed", "This draft was edited in Gmail. Review and send it there, or prepare a new draft.");
    } else {
      const current = parseNative(z.object({ isDraft: z.boolean(), changeKey: z.string() }), await request(`/v1.0/me/messages/${encodeURIComponent(delivery.id)}?$select=isDraft,changeKey`, { headers: { Prefer: 'IdType="ImmutableId"' } }));
      if (!current.isDraft || current.changeKey !== delivery.version) throw new ApiError(409, "connector_draft_changed", "This draft changed in Outlook. Review and send it there, or prepare a new draft.");
    }
    return attempt(draft, "sending", persist, async () => {
      if (target.connectorId === "gmail") {
        const sent = parseNative(z.object({ id: z.string(), threadId: z.string().optional() }), await request("/gmail/v1/users/me/drafts/send", { method: "POST", send: true, body: { id: delivery.id } }));
        const link = new URL(providerLink(delivery.webUrl, ["mail.google.com"], "https://mail.google.com/mail/"));
        link.hash = `sent/${encodeURIComponent(sent.threadId ?? sent.id)}`;
        return { ...draft, revision: randomUUID(), delivery: { ...delivery, state: "sent", messageId: sent.id, webUrl: link.href } };
      }
      await request(`/v1.0/me/messages/${encodeURIComponent(providerId)}/send`, { method: "POST", send: true, empty: true, headers: { Prefer: 'IdType="ImmutableId"' } });
      return { ...draft, revision: randomUUID(), delivery: { ...delivery, state: "sent" } };
    });
  });
}

export async function reloadConnectorEmailDraft(config: ServerConfig, workspace: WorkspaceInfo, id: string, revision: string) {
  const draft = await saveDraftFiles(workspace.path, workspace.id, "email", async (_id, previous) => {
    const initial = EmailDraftSchema.parse(previous);
    const target = initial.connectorTarget, delivery = initial.delivery;
    if (!target || !delivery?.id || delivery.state !== "saved") throw new ApiError(409, "connector_draft_not_saved", "Only a saved mailbox draft can be reloaded. Check the mail app for this email's status.");
    await connectedAccount(config, target.connectorId, target.connectionId);
    const request = await createConnectorRequest(config, target.connectorId, target.connectionId);
    if (target.connectorId === "gmail") {
      const current = parseNative(z.object({ message: z.object({ id: z.string().min(1), raw: z.string().min(1).max(35 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+={0,2}$/) }) }),
        await request(`/gmail/v1/users/me/drafts/${encodeURIComponent(delivery.id)}?format=raw&fields=message(id,raw)`));
      return prepareEmailDraftReload(workspace.path, { ...initial, delivery: { ...delivery, messageId: current.message.id } }, Buffer.from(current.message.raw, "base64url"));
    }
    const path = `/v1.0/me/messages/${encodeURIComponent(delivery.id)}`;
    const headers = { Prefer: 'IdType="ImmutableId"' };
    const versionSchema = z.object({ isDraft: z.boolean(), changeKey: z.string().min(1) });
    const before = parseNative(versionSchema, await request(`${path}?$select=isDraft,changeKey`, { headers }));
    if (!before.isDraft) throw new ApiError(409, "connector_draft_changed", "This email is no longer an Outlook draft. Check the mail app before continuing.");
    const mime = parseNative(z.object({ dataBase64: z.string() }), await request(`${path}/$value`, { headers, bytes: true }));
    const after = parseNative(versionSchema, await request(`${path}?$select=isDraft,changeKey`, { headers }));
    if (!after.isDraft || before.changeKey !== after.changeKey) throw new ApiError(409, "connector_draft_changed", "This draft changed while reloading from Outlook. Try reloading again.");
    return prepareEmailDraftReload(workspace.path, { ...initial, delivery: { ...delivery, version: after.changeKey } }, Buffer.from(mime.dataBase64, "base64"));
  }, { id, revision });
  return { draft: EmailDraftSchema.parse(draft) };
}

export async function deliverConnectorCalendarDraft(config: ServerConfig, workspace: WorkspaceInfo, id: string, revision: string) {
  return draftOperation(workspace, id, revision, "calendar", CalendarEventDraftSchema, async (draft, persist) => {
    const target = draft.connectorTarget;
    if (!target) throw new ApiError(400, "connector_draft_provider", "This draft does not use a connected calendar.");
    await connectedAccount(config, target.connectorId, target.connectionId);
    if (draft.delivery?.state === "saved") return draft;
    const update = draft.googleCalendar?.update;
    if ((update && (draft.attendees !== update.original.attendees || draft.organizer !== update.original.organizer)) || (!update && (draft.attendees.trim() || draft.organizer.trim()))) throw new ApiError(400, "connector_calendar_guests", "Guests and organizer cannot be changed here. Edit them in the calendar app.");
    if (target.connectorId !== "google-calendar" && (draft.googleMeet || draft.googleCalendar)) throw new ApiError(400, "connector_meet_unavailable", "Google Meet is only available with Google Calendar.");
    const times = eventDraftTimes(draft);
    const input = calendarCreateInput.parse({ title: draft.title, location: draft.location, calendarId: target.calendarId, connectionId: target.connectionId, start: draft.start.length === 10 ? draft.start : times.startInstant, end: draft.end.length === 10 ? draft.end : times.endInstant, allDay: draft.start.length === 10, timeZone: draft.timeZone, reminders: draft.reminders, description: [draft.description, draft.url].filter(Boolean).join("\n\n") });
    const request = await createConnectorRequest(config, target.connectorId, target.connectionId);
    const addMeet = draft.googleMeet && draft.googleCalendar?.conference.status === "none";
    if (addMeet) {
      const capabilities = await googleCalendarAdapter.capabilities(request, input);
      if (!capabilities.canAddMeet) throw new ApiError(400, "connector_meet_unavailable", "Google Meet is not available for this calendar.");
    }
    if (draft.googleMeet && !draft.googleCalendar) throw new ApiError(409, "connector_calendar_version", "Prepare a new review card to add Google Meet.");
    return attempt(draft, "saving", persist, async () => {
      const changes: Record<string, unknown> = {};
      if (update) {
        const originalTimes = eventDraftTimes(update.original);
        if (draft.title !== update.original.title) changes.summary = draft.title;
        if (draft.description !== update.original.description || draft.url !== update.original.url) changes.description = input.description;
        if (draft.location !== update.original.location) changes.location = draft.location;
        const modeChanged = (draft.start.length === 10) !== (update.original.start.length === 10);
        const zoneChanged = draft.timeZone !== update.original.timeZone;
        if (modeChanged || zoneChanged || times.startInstant !== originalTimes.startInstant) changes.start = input.allDay ? { date: input.start, dateTime: null, timeZone: null } : { date: null, dateTime: input.start, timeZone: input.timeZone };
        if (modeChanged || zoneChanged || times.endInstant !== originalTimes.endInstant) changes.end = input.allDay ? { date: input.end, dateTime: null, timeZone: null } : { date: null, dateTime: input.end, timeZone: input.timeZone };
        if (JSON.stringify(draft.reminders) !== JSON.stringify(update.original.reminders)) changes.reminders = { useDefault: false, overrides: draft.reminders.map(minutes => ({ method: "popup", minutes })) };
        if (!Object.keys(changes).length && !addMeet) throw new ApiError(400, "connector_calendar_no_changes", "Make a change before updating this event.");
      }
      const result = target.connectorId === "google-calendar"
        ? update ? await googleCalendarAdapter.update(request, calendarEventInput.parse({ calendarId: target.calendarId, connectionId: target.connectionId, eventId: update.eventId }), update.etag, changes, addMeet ? draft.googleCalendar?.requestId : undefined)
          : await googleCalendarAdapter.create(request, input, addMeet ? draft.googleCalendar?.requestId : undefined)
        : await outlookCalendarAdapter.create(request, input);
      return CalendarEventDraftSchema.parse({ ...draft, revision: randomUUID(), ...(draft.googleCalendar && "conference" in result ? { googleCalendar: { ...draft.googleCalendar, conference: { ...result.conference, status: addMeet && result.conference.status === "none" ? "pending" : result.conference.status } } } : {}), delivery: { state: "saved", id: result.id, webUrl: providerLink(result.webUrl ?? undefined, target.connectorId === "google-calendar" ? ["calendar.google.com", "www.google.com"] : ["outlook.office.com", "outlook.office365.com", "outlook.live.com"], target.connectorId === "google-calendar" ? "https://calendar.google.com" : "https://outlook.office.com/calendar") } });
    });
  });
}

export async function refreshConnectorCalendarDraft(config: ServerConfig, workspace: WorkspaceInfo, id: string, revision: string) {
  return draftOperation(workspace, id, revision, "calendar", CalendarEventDraftSchema, async (draft, persist) => {
    const target = draft.connectorTarget;
    if (target?.connectorId !== "google-calendar" || draft.delivery?.state !== "saved" || !draft.delivery.id || !draft.googleCalendar) throw new ApiError(400, "connector_calendar_not_saved", "Only a saved Google Calendar event can be refreshed.");
    await connectedAccount(config, target.connectorId, target.connectionId);
    const current = await googleCalendarAdapter.get(await createConnectorRequest(config, target.connectorId, target.connectionId), calendarEventInput.parse({ calendarId: target.calendarId, connectionId: target.connectionId, eventId: draft.delivery.id }));
    const refreshed = CalendarEventDraftSchema.parse({ ...draft, revision: randomUUID(), googleCalendar: { ...draft.googleCalendar, conference: { ...current.conference, status: draft.googleMeet && current.conference.status === "none" ? "pending" : current.conference.status } } });
    await persist(refreshed);
    return refreshed;
  });
}
