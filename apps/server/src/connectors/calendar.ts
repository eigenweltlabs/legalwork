import { z } from "zod";
import { connectorCalendarColorSchema } from "./schema.js";
import { ApiError } from "../errors.js";
import type { ConnectorRequest } from "./request.js";
import { accountInput, nativeId, nativePagePath, parseNative } from "./native.js";

export const calendarListInput = accountInput.extend({ maxResults: z.number().int().min(1).max(50).default(25), pageToken: z.string().max(8192).optional() }).strict();
const calendarAccount = accountInput.extend({ calendarId: nativeId.default("primary") });
const eventFields = {
  title: z.string().trim().min(1).max(500), description: z.string().max(20_000).optional(), location: z.string().max(1000).optional(),
  start: z.union([z.iso.date(), z.iso.datetime({ offset: true })]), end: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
  allDay: z.boolean().default(false), timeZone: z.string().max(100).optional(), reminders: z.array(z.number().int().min(0).max(40320)).max(20).optional(),
};
export const calendarEventsInput = calendarAccount.extend({
  timeMin: z.iso.datetime({ offset: true }), timeMax: z.iso.datetime({ offset: true }),
  maxResults: z.number().int().min(1).max(100).default(25), pageToken: z.string().max(8192).optional(),
}).strict().refine((value) => Date.parse(value.timeMax) > Date.parse(value.timeMin), "The end must be after the start.");
export const calendarEventInput = calendarAccount.extend({ eventId: nativeId }).strict();
export const calendarCreateInput = calendarAccount.extend({
  ...eventFields,
}).strict().refine((value) => {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  return dateOnly.test(value.start) === value.allDay && dateOnly.test(value.end) === value.allDay && Date.parse(value.end) > Date.parse(value.start);
}, "Use dates for all-day events, offset timestamps for timed events, and an end after the start.");
export const googleCalendarUpdateInput = calendarEventInput.extend(z.object(eventFields).partial().shape).extend({ googleMeet: z.boolean().default(false) }).strict();

const googleDate = z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() });
const googleEvent = z.object({ id: z.string(), summary: z.string().optional(), description: z.string().optional(), location: z.string().optional(),
  start: googleDate.optional(), end: googleDate.optional(), status: z.string().optional(), htmlLink: z.string().optional(),
  etag: z.string().optional(), recurrence: z.array(z.string()).optional(), recurringEventId: z.string().optional(), originalStartTime: googleDate.optional(), eventType: z.string().optional(),
  attendees: z.array(z.object({ email: z.string().optional(), displayName: z.string().optional(), responseStatus: z.string().optional(), optional: z.boolean().optional() })).optional(), organizer: z.object({ email: z.string().optional(), displayName: z.string().optional(), self: z.boolean().optional() }).optional(),
  attachments: z.array(z.object({ title: z.string().optional(), fileUrl: z.string().optional() })).optional(), source: z.object({ title: z.string().optional(), url: z.string().optional() }).optional(),
  reminders: z.object({ useDefault: z.boolean().optional(), overrides: z.array(z.object({ method: z.string(), minutes: z.number() })).optional() }).optional(),
  hangoutLink: z.string().optional(), conferenceData: z.object({ conferenceSolution: z.object({ key: z.object({ type: z.string() }) }).optional(), entryPoints: z.array(z.object({ entryPointType: z.string(), uri: z.string() })).optional(), createRequest: z.object({ status: z.object({ statusCode: z.enum(["pending", "success", "failure"]) }).optional() }).optional() }).optional(),
});
const outlookDate = z.object({ dateTime: z.string(), timeZone: z.string() });
const outlookPerson = z.object({ emailAddress: z.object({ name: z.string().optional(), address: z.string().optional() }) });
const outlookEvent = z.object({ id: z.string(), subject: z.string().nullish(), body: z.object({ content: z.string(), contentType: z.string() }).nullish(),
  start: outlookDate, end: outlookDate, isAllDay: z.boolean().optional(), isCancelled: z.boolean().optional(),
  type: z.enum(["singleInstance", "occurrence", "exception", "seriesMaster"]).optional(),
  originalStartTimeZone: z.string().max(255).optional(),
  location: z.object({ displayName: z.string().optional() }).nullish(), webLink: z.string().optional(),
  organizer: outlookPerson.nullish(), attendees: z.array(outlookPerson.extend({ type: z.string().optional(), status: z.object({ response: z.string().optional() }).optional() })).optional(),
  onlineMeeting: z.object({ joinUrl: z.string().nullish() }).nullish(), onlineMeetingUrl: z.string().nullish(),
  isReminderOn: z.boolean().optional(), reminderMinutesBeforeStart: z.number().optional(), hasAttachments: z.boolean().optional(),
});

function googleSummary(event: z.infer<typeof googleEvent>) {
  const conferenceUrl = event.conferenceData?.entryPoints?.find(entry => entry.entryPointType === "video")?.uri ?? event.hangoutLink;
  const conference = { status: event.conferenceData?.createRequest?.status?.statusCode ?? (conferenceUrl || event.conferenceData ? "success" : "none"), ...(event.conferenceData?.conferenceSolution?.key.type ? { type: event.conferenceData.conferenceSolution.key.type } : event.hangoutLink ? { type: "hangoutsMeet" } : {}), ...(conferenceUrl ? { url: conferenceLink(conferenceUrl) } : {}) };
  return { id: event.id, title: event.summary ?? "", description: event.description ?? "", descriptionType: "html", location: event.location ?? "",
    start: event.start?.dateTime ?? event.start?.date ?? null, end: event.end?.dateTime ?? event.end?.date ?? null,
    timeZone: event.start?.timeZone ?? null, allDay: Boolean(event.start?.date), status: event.status ?? "confirmed", webUrl: event.htmlLink ?? null,
    etag: event.etag ?? null, recurrence: event.recurrence ?? [], recurringEventId: event.recurringEventId ?? null, originalStartTime: event.originalStartTime ?? null, eventType: event.eventType ?? "default", attendees: event.attendees ?? [], organizer: event.organizer ?? null, reminders: event.reminders ?? null, conference, attachments: event.attachments ?? [], source: event.source ?? null };
}
function conferenceLink(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new ApiError(502, "connector_api_invalid", "Google Calendar returned an invalid conference link.");
  return url.href;
}
function googleDateValue(value: string, allDay: boolean, timeZone?: string) { return allDay ? { date: value } : { dateTime: value, ...(timeZone ? { timeZone } : {}) }; }
function googleMeetRequest(requestId?: string) { return requestId ? { conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}; }
function outlookSummary(event: z.infer<typeof outlookEvent>) {
  return { id: event.id, title: event.subject ?? "", description: event.body?.content ?? "", descriptionType: event.body?.contentType ?? "text",
    location: event.location?.displayName ?? "", start: event.start.dateTime, end: event.end.dateTime,
    timeZone: event.start.timeZone, endTimeZone: event.end.timeZone, allDay: event.isAllDay ?? false,
    status: event.isCancelled ? "cancelled" : "confirmed", webUrl: event.webLink ?? null, recurring: event.type !== undefined && event.type !== "singleInstance",
    organizer: event.organizer ? { displayName: event.organizer.emailAddress.name, email: event.organizer.emailAddress.address } : null,
    attendees: (event.attendees ?? []).map(person => ({ displayName: person.emailAddress.name, email: person.emailAddress.address, responseStatus: person.status?.response, optional: person.type === "optional" })),
    conference: { status: event.onlineMeeting?.joinUrl || event.onlineMeetingUrl ? "success" : "none", url: event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? null },
    reminders: event.isReminderOn === undefined ? null : { useDefault: false, overrides: event.isReminderOn && event.reminderMinutesBeforeStart !== undefined ? [{ method: "popup", minutes: event.reminderMinutesBeforeStart }] : [] },
    hasAttachments: event.hasAttachments,
  };
}
async function outlookDisplayEvent(request: ConnectorRequest, path: string, event: z.infer<typeof outlookEvent>, calendarOwner?: string) {
  const zone = event.originalStartTimeZone;
  // UTC conversion can move an all-day event onto the previous date. Ask Graph
  // for its original zone (including Windows zone names) to retain calendar days.
  const midnight = /T00:00:00(?:\.0+)?Z?$/;
  if (event.isAllDay && zone && zone !== event.start.timeZone && (!midnight.test(event.start.dateTime) || !midnight.test(event.end.dateTime))) {
    if (/["\r\n]/.test(zone)) throw new ApiError(502, "connector_api_invalid", "Microsoft returned an invalid calendar time zone.");
    const original = parseNative(outlookEvent, await request(path, { headers: { Prefer: `outlook.timezone="${zone}", outlook.body-content-type="text"` }, ...(calendarOwner?{calendarOwner}:{}) }));
    return outlookSummary(original);
  }
  return outlookSummary(event);
}
function googleEventsPath(calendarId: string) { return `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`; }
function outlookCalendarPath(calendarId: string) { return calendarId === "primary" ? "/v1.0/me/calendar" : `/v1.0/me/calendars/${encodeURIComponent(calendarId)}`; }

async function outlookCalendarTarget(request: ConnectorRequest, calendarId: string, writing=false) {
  const path=outlookCalendarPath(calendarId);
  // Primary is the signed-in user's endpoint. Other IDs need provider ownership
  // metadata before personal or explicitly shared access can be determined.
  if(calendarId==='primary'||!request.calendarAccess)return {path,calendarOwner:undefined};
  const calendar=parseNative(z.object({id:z.string(),owner:z.object({address:z.email().max(320)})}),await request(`${path}?$select=id,owner`));
  if(calendar.id!==calendarId)throw new ApiError(409,'connector_calendar_changed','This calendar changed.');
  if(!await request.calendarAccess(calendar.owner.address,writing))throw new ApiError(403,'connector_calendar_permission_required','This calendar permission is unavailable.');
  return {path,calendarOwner:calendar.owner.address};
}

export const googleCalendarAdapter = {
  async capabilities(request: ConnectorRequest, input: { calendarId: string }) {
    const calendar = parseNative(z.object({ timeZone: z.string().optional(), accessRole: z.string(), conferenceProperties: z.object({ allowedConferenceSolutionTypes: z.array(z.string()).default([]) }).optional() }), await request(`/calendar/v3/users/me/calendarList/${encodeURIComponent(input.calendarId)}`));
    if (!["owner", "writer"].includes(calendar.accessRole)) throw new ApiError(403, "connector_calendar_read_only", "This calendar does not allow event changes.");
    return { timeZone: calendar.timeZone ?? "UTC", canAddMeet: calendar.conferenceProperties?.allowedConferenceSolutionTypes.includes("hangoutsMeet") ?? false };
  },
  async test(request: ConnectorRequest) {
    parseNative(z.object({ items: z.array(z.object({ id: z.string() })).default([]) }), await request("/calendar/v3/users/me/calendarList?maxResults=1&fields=items(id)"));
    return { ok: true };
  },
  async calendars(request: ConnectorRequest, input: z.infer<typeof calendarListInput>) {
    const query = new URLSearchParams({ maxResults: String(input.maxResults) });
    if (input.pageToken) query.set("pageToken", input.pageToken);
    const page = parseNative(z.object({ items: z.array(z.object({ id: z.string(), summary: z.string().optional(), backgroundColor: connectorCalendarColorSchema, timeZone: z.string().optional(), accessRole: z.string().optional(), primary: z.boolean().optional(), conferenceProperties: z.object({ allowedConferenceSolutionTypes: z.array(z.string()).default([]) }).optional() })).default([]), nextPageToken: z.string().optional() }),
      await request(`/calendar/v3/users/me/calendarList?${query}`));
    return { calendars: page.items.map((item) => ({ id: item.id, name: item.summary ?? "", color: item.backgroundColor, timeZone: item.timeZone ?? null, canWrite: item.accessRole === "owner" || item.accessRole === "writer", primary: item.primary ?? false, canAddMeet: item.conferenceProperties?.allowedConferenceSolutionTypes.includes("hangoutsMeet") ?? false })), nextPageToken: page.nextPageToken ?? null };
  },
  async events(request: ConnectorRequest, input: z.infer<typeof calendarEventsInput>) {
    const query = new URLSearchParams({ timeMin: input.timeMin, timeMax: input.timeMax, maxResults: String(input.maxResults), singleEvents: "true", orderBy: "startTime" });
    if (input.pageToken) query.set("pageToken", input.pageToken);
    const page = parseNative(z.object({ items: z.array(googleEvent).default([]), nextPageToken: z.string().optional(), timeZone: z.string().optional() }),
      await request(`${googleEventsPath(input.calendarId)}?${query}`));
    return { events: page.items.map(googleSummary), timeZone: page.timeZone ?? null, nextPageToken: page.nextPageToken ?? null };
  },
  async get(request: ConnectorRequest, input: z.infer<typeof calendarEventInput>) {
    return googleSummary(parseNative(googleEvent, await request(`${googleEventsPath(input.calendarId)}/${encodeURIComponent(input.eventId)}`)));
  },
  async create(request: ConnectorRequest, input: z.infer<typeof calendarCreateInput>, requestId?: string) {
    return googleSummary(parseNative(googleEvent, await request(`${googleEventsPath(input.calendarId)}?sendUpdates=none&conferenceDataVersion=1`, { method: "POST", body: {
      summary: input.title, description: input.description, location: input.location, start: googleDateValue(input.start, input.allDay, input.timeZone), end: googleDateValue(input.end, input.allDay, input.timeZone), ...googleMeetRequest(requestId),
      ...(input.reminders ? { reminders: { useDefault: false, overrides: input.reminders.map(minutes => ({ method: "popup", minutes })) } } : {}),
    } })));
  },
  async update(request: ConnectorRequest, input: z.infer<typeof calendarEventInput>, etag: string, changes: Record<string, unknown>, requestId?: string) {
    if (!etag || /[\r\n]/.test(etag)) throw new ApiError(409, "connector_calendar_version", "Read this event again before preparing changes.");
    return googleSummary(parseNative(googleEvent, await request(`${googleEventsPath(input.calendarId)}/${encodeURIComponent(input.eventId)}?sendUpdates=none&conferenceDataVersion=1`, { method: "PATCH", headers: { "If-Match": etag }, body: { ...changes, ...googleMeetRequest(requestId) } })));
  },
};

export const outlookCalendarAdapter = {
  async test(request: ConnectorRequest) {
    parseNative(z.object({ value: z.array(z.object({ id: z.string() })) }), await request("/v1.0/me/calendars?$top=1&$select=id"));
    return { ok: true };
  },
  async calendars(request: ConnectorRequest, input: z.infer<typeof calendarListInput>) {
    const path = "/v1.0/me/calendars";
    const query = new URLSearchParams({ "$top": String(input.maxResults), "$select": "id,name,canEdit,isDefaultCalendar,hexColor,owner" });
    const page = parseNative(z.object({ value: z.array(z.object({ id: z.string(), name: z.string(), hexColor: connectorCalendarColorSchema, canEdit: z.boolean().optional(), isDefaultCalendar: z.boolean().optional(), owner:z.object({address:z.email().max(320)}).optional() })), "@odata.nextLink": z.string().optional() }),
      await request(input.pageToken ? nativePagePath(input.pageToken, "https://graph.microsoft.com", path) : `${path}?${query}`));
    if (page["@odata.nextLink"]) nativePagePath(page["@odata.nextLink"], "https://graph.microsoft.com", path);
    const calendars=[];
    const permissions=new Map<string,Promise<boolean>>();
    const calendarAccess=request.calendarAccess;
    const allowed=(owner:string,writing:boolean)=>{const key=JSON.stringify([owner.toLowerCase(),writing]);let pending=permissions.get(key);if(!pending){if(!calendarAccess)throw new ApiError(403,'connector_calendar_permission_required','This calendar permission is unavailable.');pending=calendarAccess(owner,writing);permissions.set(key,pending);}return pending;};
    for(const item of page.value){
      let canWrite=item.canEdit??false;
      if(request.calendarAccess){
        if(!item.owner)throw new ApiError(502,'connector_api_invalid','The provider returned an invalid calendar owner.');
        if(!await allowed(item.owner.address,false))continue;
        canWrite=canWrite&&await allowed(item.owner.address,true);
      }
      calendars.push({id:item.id,name:item.name,color:item.hexColor,canWrite,primary:item.isDefaultCalendar??false});
    }
    return { calendars, nextPageToken: page["@odata.nextLink"] ?? null };
  },
  async events(request: ConnectorRequest, input: z.infer<typeof calendarEventsInput>) {
    const target=await outlookCalendarTarget(request,input.calendarId);
    const path = `${target.path}/calendarView`;
    const query = new URLSearchParams({ startDateTime: input.timeMin, endDateTime: input.timeMax, "$top": String(input.maxResults), "$orderby": "start/dateTime" });
    const page = parseNative(z.object({ value: z.array(outlookEvent), "@odata.nextLink": z.string().optional() }),
      await request(input.pageToken ? nativePagePath(input.pageToken, "https://graph.microsoft.com", path) : `${path}?${query}`, { headers: { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' }, ...(target.calendarOwner?{calendarOwner:target.calendarOwner}:{}) }));
    if (page["@odata.nextLink"]) nativePagePath(page["@odata.nextLink"], "https://graph.microsoft.com", path);
    const events = [];
    for (const event of page.value) events.push(await outlookDisplayEvent(request, `${target.path}/events/${encodeURIComponent(event.id)}`, event,target.calendarOwner));
    return { events, nextPageToken: page["@odata.nextLink"] ?? null };
  },
  async get(request: ConnectorRequest, input: z.infer<typeof calendarEventInput>) {
    const target=await outlookCalendarTarget(request,input.calendarId);
    const path = `${target.path}/events/${encodeURIComponent(input.eventId)}`;
    return outlookDisplayEvent(request, path, parseNative(outlookEvent, await request(path, { headers: { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' }, ...(target.calendarOwner?{calendarOwner:target.calendarOwner}:{}) })),target.calendarOwner);
  },
  async create(request: ConnectorRequest, input: z.infer<typeof calendarCreateInput>) {
    if (input.reminders && input.reminders.length > 1) throw new ApiError(400, "connector_calendar_reminders", "Outlook supports one reminder per event.");
    const target=await outlookCalendarTarget(request,input.calendarId,true);
    const date = (value: string) => ({ dateTime: input.allDay ? `${value}T00:00:00` : new Date(value).toISOString().replace(/Z$/, ""), timeZone: input.allDay ? input.timeZone ?? "UTC" : "UTC" });
    return outlookSummary(parseNative(outlookEvent, await request(`${target.path}/events`, { method: "POST", ...(target.calendarOwner?{calendarOwner:target.calendarOwner}:{}), body: {
      subject: input.title, body: { contentType: "Text", content: input.description ?? "" }, location: { displayName: input.location ?? "" },
      start: date(input.start), end: date(input.end), isAllDay: input.allDay, attendees: [],
      ...(input.reminders ? { isReminderOn: input.reminders.length > 0, reminderMinutesBeforeStart: input.reminders[0] ?? 0 } : {}),
    } })));
  },
};
