import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServerConfig } from "../../types.js";
import { createConnectorRequest, type StreamingConnectorRequest, type ConnectorRequestOptions } from "../../connectors/request.js";
import { savedConnectorConnections } from "../../connectors/broker.js";
import { connectorWriteSetting } from "../../connectors/settings.js";
import { googleCalendarAdapter, outlookCalendarAdapter } from "../../connectors/calendar.js";
import { nativePagePath } from "../../connectors/native.js";
import type { MailInvitation, MailInvitationTime } from "../invitation-view.js";
import { InvitationReplyError, invitationReplyEventSchema, type InvitationCalendar, type InvitationReplySelection, type InvitationReplyEvent, type InvitationResponse } from "../invitation-reply-view.js";

const id = z.string().min(1).max(4096).refine(value => value !== "." && value !== "..");
const email = z.email().max(320);
const stamp = z.object({ date: z.iso.date().optional(), dateTime: z.string().max(100).optional(), timeZone: z.string().max(255).optional() });
const googleEvent = z.object({
  id, iCalUID: id.optional(), etag: z.string().max(1024).optional(), sequence: z.number().int().optional(), status: z.string().optional(),
  summary: z.string().max(1000).default(""), description: z.string().max(20000).default(""), location: z.string().max(2000).default(""),
  start: stamp.optional(), end: stamp.optional(), originalStartTime: stamp.optional(), recurringEventId: id.optional(), recurrence: z.array(z.string().max(2000)).max(100).optional(), htmlLink: z.string().max(8192).optional(),
  organizer: z.object({ email: z.string().optional(), self: z.boolean().optional() }).optional(),
  attendees: z.array(z.object({ email: z.string().optional(), self: z.boolean().optional(), responseStatus: z.string().optional() })).max(2000).default([]),
});
const graphPerson = z.object({ emailAddress: z.object({ address: z.string().optional() }) });
const graphEvent = z.object({
  id, iCalUId: id.optional(), changeKey: z.string().max(1024).optional(), "@odata.etag": z.string().max(1024).optional(),
  subject: z.string().max(1000).default(""), body: z.object({ content: z.string().max(20000), contentType: z.string() }).optional(),
  location: z.object({ displayName: z.string().max(2000).optional() }).optional(),
  start: z.object({ dateTime: z.string().max(100), timeZone: z.string().max(255) }).optional(), end: z.object({ dateTime: z.string().max(100), timeZone: z.string().max(255) }).optional(),
  isAllDay: z.boolean().default(false), isCancelled: z.boolean().default(false), isOrganizer: z.boolean().optional(), type: z.enum(["singleInstance", "seriesMaster", "occurrence", "exception"]).optional(),
  originalStart: z.string().max(100).optional(), originalStartTimeZone: z.string().max(255).optional(), seriesMasterId: id.optional(),
  organizer: graphPerson.optional(), attendees: z.array(graphPerson).max(2000).default([]),
  responseStatus: z.object({ response: z.string() }).optional(), webLink: z.string().max(8192).optional(),
});
const graphHeaders = { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text", IdType="ImmutableId"' };
const graphSelect = "id,iCalUId,changeKey,subject,body,location,start,end,isAllDay,isCancelled,isOrganizer,type,originalStart,originalStartTimeZone,seriesMasterId,organizer,attendees,responseStatus,webLink";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const response = (value?: string): InvitationResponse | null => value === "accepted" ? "accepted" : value === "tentative" || value === "tentativelyAccepted" ? "tentative" : value === "declined" ? "declined" : null;
const googlePath = (calendarId: string) => `/calendar/v3/calendars/${encodeURIComponent(id.parse(calendarId))}/events`;
const graphPath = (calendarId: string) => calendarId === "primary" ? "/v1.0/me/calendar" : `/v1.0/me/calendars/${encodeURIComponent(id.parse(calendarId))}`;
function webUrl(value?: string) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function dateTime(value: z.infer<typeof stamp>): MailInvitationTime {
  if (value.date) return { value: value.date, kind: "date", timeZone: null, instant: null };
  const parsed = z.iso.datetime({ offset: true }).safeParse(value.dateTime);
  if (!parsed.success) throw new InvitationReplyError("unsupported_time");
  return { value: parsed.data, kind: "utc", timeZone: value.timeZone ?? "UTC", instant: new Date(parsed.data).toISOString() };
}
function occurrenceMatches(source: MailInvitationTime, target?: z.infer<typeof stamp>) {
  if (!target) return false;
  const time = dateTime(target);
  return source.kind === "date" ? time.kind === "date" && source.value === time.value : source.instant !== null && source.instant === time.instant;
}

export type InvitationCalendarIdentity = { id: string; email: string };
export type InvitationCalendarDependencies = {
  request: typeof createConnectorRequest;
  proof: (url: string, init: RequestInit) => Promise<Response>;
  permission: typeof connectorWriteSetting;
};
function scopedRequest(native: StreamingConnectorRequest, signal: AbortSignal): StreamingConnectorRequest {
  return Object.assign((path: string, options: ConnectorRequestOptions = {}) => native(path, { ...options, signal }), { response: (path: string, options: ConnectorRequestOptions = {}) => native.response(path, { ...options, signal }), assertWrite: native.assertWrite });
}
export type InvitationCalendarEvent = { view: InvitationReplyEvent; etag: string | null };
export interface InvitationCalendarAccess {
  identity: InvitationCalendarIdentity;
  calendar: InvitationCalendar;
  find(invitation: MailInvitation): Promise<InvitationCalendarEvent>;
  get(eventId: string): Promise<InvitationCalendarEvent>;
  assertWrite(): Promise<void>;
  respond(event: InvitationCalendarEvent, desired: InvitationResponse): Promise<Response>;
}

/** Provider adapter over the same authenticated Calendar transport used elsewhere. */
export function invitationCalendarAccess(request: StreamingConnectorRequest, calendar: InvitationCalendar, identity: InvitationCalendarIdentity, owner: string): InvitationCalendarAccess {
  const google = calendar.connectorId === "google-calendar";
  const eventPath = (eventId: string) => `${google ? googlePath(calendar.calendarId) : graphPath(calendar.calendarId) + "/events"}/${encodeURIComponent(id.parse(eventId))}`;
  function normalizeGoogle(event: z.infer<typeof googleEvent>): InvitationCalendarEvent {
    if (event.status === "cancelled") throw new InvitationReplyError("cancelled");
    const self = event.attendees.filter(attendee => attendee.self);
    if (self.length !== 1 || event.organizer?.self || !event.start || !event.end || !event.iCalUID || !event.etag || /[\r\n]/.test(event.etag)) throw new InvitationReplyError("not_invitation");
    const replyAs = email.parse(self[0].email), organizer = email.parse(event.organizer?.email);
    if (organizer.toLowerCase() === replyAs.toLowerCase()) throw new InvitationReplyError("not_invitation");
    const view = invitationReplyEventSchema.parse({ id: event.id, uid: event.iCalUID, revision: digest(event), title: event.summary, description: event.description, descriptionType: "html", location: event.location, organizer, replyAs,
      start: dateTime(event.start), end: dateTime(event.end), scope: event.recurringEventId ? "occurrence" : event.recurrence?.length ? "series" : "event", currentResponse: response(self[0].responseStatus), webUrl: webUrl(event.htmlLink) });
    return { view, etag: event.etag };
  }
  async function normalizeGraph(event: z.infer<typeof graphEvent>): Promise<InvitationCalendarEvent> {
    if (event.isCancelled) throw new InvitationReplyError("cancelled");
    if (event.isOrganizer !== false || !event.iCalUId || !event.changeKey || !event.start || !event.end || !event.attendees.some(attendee => attendee.emailAddress.address?.toLowerCase() === owner.toLowerCase())) throw new InvitationReplyError("not_invitation");
    let start = event.start, end = event.end;
    if (event.isAllDay && (!/T00:00:00(?:\.0+)?Z?$/.test(start.dateTime) || !/T00:00:00(?:\.0+)?Z?$/.test(end.dateTime))) {
      const zone = event.originalStartTimeZone;
      if (!zone || /["\r\n]/.test(zone)) throw new InvitationReplyError("unsupported_time");
      const original = graphEvent.parse(await request(eventPath(event.id), { headers: { Prefer: `outlook.timezone="${zone}", outlook.body-content-type="text", IdType="ImmutableId"` } }));
      if (original.changeKey !== event.changeKey || !original.start || !original.end) throw new InvitationReplyError("changed");
      start = original.start; end = original.end;
    }
    const convert = (value: typeof start) => event.isAllDay ? dateTime({ date: value.dateTime.slice(0, 10) }) : value.timeZone === "UTC" ? dateTime({ dateTime: /(?:Z|[+-]\d\d:\d\d)$/i.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z` }) : (() => { throw new InvitationReplyError("unsupported_time"); })();
    const organizer = email.parse(event.organizer?.emailAddress.address);
    if (organizer.toLowerCase() === owner.toLowerCase()) throw new InvitationReplyError("not_invitation");
    const view = invitationReplyEventSchema.parse({ id: event.id, uid: event.iCalUId, revision: digest(event), title: event.subject, description: event.body?.content ?? "", descriptionType: event.body?.contentType.toLowerCase() === "html" ? "html" : "text", location: event.location?.displayName ?? "", organizer, replyAs: owner,
      start: convert(start), end: convert(end), scope: event.type === "seriesMaster" ? "series" : event.type === "occurrence" || event.type === "exception" ? "occurrence" : "event", currentResponse: response(event.responseStatus?.response), webUrl: webUrl(event.webLink) });
    const etag = event["@odata.etag"];
    return { view, etag: etag && !/[\r\n]/.test(etag) ? etag : null };
  }
  async function get(eventId: string) {
    const raw = await request(eventPath(eventId), google ? {} : { headers: graphHeaders });
    const event = google ? normalizeGoogle(googleEvent.parse(raw)) : await normalizeGraph(graphEvent.parse(raw));
    if (event.view.id !== eventId) throw new InvitationReplyError("changed");
    return event;
  }
  return {
    identity, calendar, get,
    async assertWrite() { if (!calendar.canWrite) throw new InvitationReplyError("permission"); await request.assertWrite(); },
    async find(invitation) {
      const query = new URLSearchParams(google ? { iCalUID: invitation.uid, showDeleted: "true", singleEvents: "false", maxResults: "100" } : { "$filter": `iCalUId eq '${invitation.uid.replaceAll("'", "''")}'`, "$top": "100", "$select": graphSelect });
      const rootPath = google ? googlePath(calendar.calendarId) : `${graphPath(calendar.calendarId)}/events`;
      const raw = await request(`${rootPath}?${query}`, google ? {} : { headers: graphHeaders });
      const candidates = google ? (() => { const page = z.object({ items: z.array(googleEvent).max(100).default([]), nextPageToken: z.string().optional() }).parse(raw); if (page.nextPageToken) throw new InvitationReplyError("ambiguous"); return page.items.filter(event => event.iCalUID === invitation.uid && !event.recurringEventId); })()
        : (() => { const page = z.object({ value: z.array(graphEvent).max(100), "@odata.nextLink": z.string().optional() }).parse(raw); if (page["@odata.nextLink"]) throw new InvitationReplyError("ambiguous"); return page.value.filter(event => event.iCalUId === invitation.uid); })();
      if (!candidates.length) throw new InvitationReplyError("not_found");
      if (candidates.length !== 1) throw new InvitationReplyError("ambiguous");
      const candidate = candidates[0];
      if (!invitation.recurrenceId) return get(candidate.id);
      const original = invitation.recurrenceId;
      if (!google && original.kind === "date" || original.kind !== "date" && !original.instant) throw new InvitationReplyError("unsupported_time");
      const anchor = Date.parse(original.instant ?? `${original.value}T12:00:00Z`);
      if (!google && 'type' in candidate && (candidate.type === 'occurrence' || candidate.type === 'exception')) {
        if (!('originalStart' in candidate) || !candidate.originalStart || Date.parse(candidate.originalStart) !== anchor) throw new InvitationReplyError('not_found');
        return get(candidate.id);
      }
      const min = new Date(anchor - 2 * 86400000).toISOString(), max = new Date(anchor + 2 * 86400000).toISOString();
      const instancesPath = `${eventPath(candidate.id)}/instances`;
      const parameters = new URLSearchParams(google ? { originalStart: original.instant ?? original.value, maxResults: "100", showDeleted: "true" } : { startDateTime: min, endDateTime: max, "$top": "100", "$select": graphSelect });
      let next: string | undefined, found: string | undefined;
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const path = google ? `${instancesPath}?${parameters}${next ? `&pageToken=${encodeURIComponent(next)}` : ""}` : next ? nativePagePath(next, "https://graph.microsoft.com", instancesPath) : `${instancesPath}?${parameters}`;
        const page = await request(path, google ? {} : { headers: graphHeaders });
        const matches: string[] = [];
        if (google) {
          const result = z.object({ items: z.array(googleEvent).max(100).default([]), nextPageToken: z.string().max(8192).optional() }).parse(page);
          matches.push(...result.items.filter(event => event.recurringEventId === candidate.id && (!event.iCalUID || event.iCalUID === invitation.uid) && occurrenceMatches(original, event.originalStartTime)).map(event => event.id)); next = result.nextPageToken;
        } else {
          const result = z.object({ value: z.array(graphEvent).max(100), "@odata.nextLink": z.string().max(8192).optional() }).parse(page);
          matches.push(...result.value.filter(event => event.seriesMasterId === candidate.id && event.originalStart && Date.parse(event.originalStart) === anchor).map(event => event.id)); next = result["@odata.nextLink"];
        }
        for (const match of matches) { if (found && found !== match) throw new InvitationReplyError("ambiguous"); found = match; }
        if (!next) { if (!found) throw new InvitationReplyError("not_found"); return get(found); }
      }
      throw new InvitationReplyError("ambiguous");
    },
    async respond(event, desired) {
      if (google) return request.response(`${eventPath(event.view.id)}?sendUpdates=all`, { method: "PATCH", headers: { "If-Match": event.etag ?? "" }, body: { attendeesOmitted: true, attendees: [{ email: event.view.replyAs, responseStatus: desired }] }, providerStatus: true });
      const action = desired === "accepted" ? "accept" : desired === "tentative" ? "tentativelyAccept" : "decline";
      return request.response(`${eventPath(event.view.id)}/${action}`, { method: "POST", headers: graphHeaders, body: { sendResponse: true }, providerStatus: true });
    },
  };
}

const profilePath = (connectorId: InvitationReplySelection["connectorId"]) => connectorId === "google-calendar" ? "/calendar/v3/users/me/calendarList/primary" : "/v1.0/me?$select=id,mail,userPrincipalName";
function profile(connectorId: InvitationReplySelection["connectorId"], value: unknown): InvitationCalendarIdentity {
  if (connectorId === "google-calendar") { const result = z.object({ id: email, primary: z.literal(true) }).parse(value); return { id: result.id, email: result.id }; }
  const result = z.object({ id, mail: z.string().nullish(), userPrincipalName: z.string().optional() }).parse(value);
  return { id: result.id, email: email.parse(result.mail || result.userPrincipalName) };
}
export async function openInvitationCalendar(config: ServerConfig, selection: InvitationReplySelection, signal: AbortSignal, expected?: InvitationCalendarIdentity, dependencies: InvitationCalendarDependencies = { request: createConnectorRequest, proof: fetch, permission: connectorWriteSetting }): Promise<InvitationCalendarAccess> {
  const initial = await dependencies.request(config, selection.connectorId, selection.connectionId);
  const identity = expected ?? profile(selection.connectorId, await initial(profilePath(selection.connectorId), { signal }));
  const native = await dependencies.request(config, selection.connectorId, selection.connectionId, { verifyAccess: async token => {
    const origin = selection.connectorId === "google-calendar" ? "https://www.googleapis.com" : "https://graph.microsoft.com";
    const result = await dependencies.proof(origin + profilePath(selection.connectorId), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    if (result.status === 401) { await result.body?.cancel(); return false; }
    if (!result.ok) { await result.body?.cancel(); throw new InvitationReplyError("unavailable"); }
    const current = profile(selection.connectorId, await result.json());
    if (current.id !== identity.id || current.email.toLowerCase() !== identity.email.toLowerCase()) throw new InvitationReplyError("account_changed");
    return true;
  } });
  const request = scopedRequest(native, signal);
  const writing = await dependencies.permission(config, selection.connectorId);
  let name: string, owner: string, canWrite: boolean, calendarId: string;
  if (selection.connectorId === "google-calendar") {
    const item = z.object({ id, summary: z.string().max(1024).default(""), accessRole: z.string() }).parse(await request(`/calendar/v3/users/me/calendarList/${encodeURIComponent(id.parse(selection.calendarId))}`));
    if (item.id !== selection.calendarId && selection.calendarId !== "primary") throw new InvitationReplyError("changed");
    name = item.summary; owner = identity.email; canWrite = item.accessRole === "owner" || item.accessRole === "writer"; calendarId = item.id;
  } else {
    const item = z.object({ id, name: z.string().max(1024), canEdit: z.boolean().default(false), owner: z.object({ address: email }).optional(), isDefaultCalendar: z.boolean().default(false) }).parse(await request(graphPath(selection.calendarId)));
    if (item.id !== selection.calendarId && selection.calendarId !== "primary") throw new InvitationReplyError("changed");
    name = item.name; owner = item.owner?.address ?? (item.isDefaultCalendar ? identity.email : ""); canWrite = item.canEdit; calendarId = item.id;
    if (!owner) throw new InvitationReplyError("not_invitation");
  }
  return invitationCalendarAccess(request, { ...selection, calendarId, name, account: identity.email, canWrite: canWrite && writing.writeAccess && !writing.readOnly }, identity, owner);
}

export async function invitationCalendars(config: ServerConfig, signal: AbortSignal) {
  const calendars: InvitationCalendar[] = [], unavailable: InvitationReplySelection["connectorId"][] = [];
  for (const connectorId of ["google-calendar", "outlook-calendar"] satisfies InvitationReplySelection["connectorId"][]) {
    try {
      const connections = await savedConnectorConnections(config, connectorId);
      if (!connections.length) continue;
      if (connections.length !== 1 || connections[0].needsReconnect) throw new InvitationReplyError("unavailable");
      const connectionId = connections[0].id, request = scopedRequest(await createConnectorRequest(config, connectorId, connectionId), signal);
      const identity = profile(connectorId, await request(profilePath(connectorId), { signal }));
      const permission = await connectorWriteSetting(config, connectorId);
      const found: InvitationCalendar[] = [];
      let pageToken: string | undefined;
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const page = await (connectorId === "google-calendar" ? googleCalendarAdapter : outlookCalendarAdapter).calendars(request, { connectionId, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
        found.push(...page.calendars.map(calendar => ({ connectorId, connectionId, calendarId: calendar.id, name: calendar.name, account: identity.email, canWrite: calendar.canWrite && permission.writeAccess && !permission.readOnly })));
        pageToken = page.nextPageToken ?? undefined;
        if (!pageToken) break;
        if (pageIndex === 9) throw new InvitationReplyError("unavailable");
      }
      const current = profile(connectorId, await request(profilePath(connectorId)));
      if (identity.id !== current.id || identity.email.toLowerCase() !== current.email.toLowerCase()) throw new InvitationReplyError('account_changed');
      calendars.push(...found);
    } catch { unavailable.push(connectorId); }
  }
  if (signal.aborted) throw new InvitationReplyError("unavailable");
  return { calendars: [...new Map(calendars.map(calendar => [JSON.stringify([calendar.connectorId, calendar.connectionId, calendar.calendarId]), calendar])).values()], unavailable };
}
