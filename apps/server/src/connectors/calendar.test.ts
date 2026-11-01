import { expect, test } from "bun:test";
import { calendarEventsInput, calendarCreateInput, googleCalendarAdapter, outlookCalendarAdapter } from "./calendar.js";
import type { ConnectorRequest } from "./request.js";

const input = calendarEventsInput.parse({ calendarId: "personal", timeMin: "2026-10-26T00:00:00Z", timeMax: "2026-11-02T00:00:00Z" });

test('Outlook owner checks cover secondary reads, creates and time-zone fallback reads',async()=>{
  const calls:{path:string;owner?:string}[]=[],checks:{owner:string;writing:boolean}[]=[];
  let allowed=true;
  const utc={id:'event',subject:'Shared all-day',isAllDay:true,originalStartTimeZone:'W. Europe Standard Time',start:{dateTime:'2026-10-25T23:00:00',timeZone:'UTC'},end:{dateTime:'2026-10-26T23:00:00',timeZone:'UTC'}};
  const native:ConnectorRequest=Object.assign(async(path:string,options?:import('./request.js').ConnectorRequestOptions)=>{
    calls.push({path,owner:options?.calendarOwner});
    if(path.includes('$select=id,owner'))return {id:'personal',owner:{address:'owner@example.test'}};
    if(path.includes('/calendarView'))return {value:[utc]};
    return {...utc,start:{dateTime:'2026-10-26T00:00:00',timeZone:'W. Europe Standard Time'},end:{dateTime:'2026-10-27T00:00:00',timeZone:'W. Europe Standard Time'}};
  },{calendarAccess:async(owner:string,writing=false)=>{checks.push({owner,writing});return allowed;}});
  await outlookCalendarAdapter.events(native,input);
  const eventCalls=()=>calls.filter(call=>call.path.includes('calendarView')||call.path.includes('/events'));
  expect(eventCalls()).toHaveLength(2);expect(eventCalls().every(call=>call.owner==='owner@example.test')).toBe(true);
  await outlookCalendarAdapter.create(native,calendarCreateInput.parse({calendarId:'personal',title:'New event',start:'2026-10-26',end:'2026-10-27',allDay:true}));
  expect(checks).toContainEqual({owner:'owner@example.test',writing:true});expect(eventCalls().at(-1)?.owner).toBe('owner@example.test');
  const count=eventCalls().length;allowed=false;
  await expect(outlookCalendarAdapter.get(native,{calendarId:'personal',eventId:'event'})).rejects.toMatchObject({code:'connector_calendar_permission_required'});expect(eventCalls()).toHaveLength(count);
});
test("Outlook all-day dates retain their original Windows time zone after UTC conversion", async () => {
  const calls: { path: string; prefer?: string }[] = [];
  const request: ConnectorRequest = async (path, options) => {
    calls.push({ path, prefer: options?.headers?.Prefer });
    const event = { id: "all-day", subject: "All day", isAllDay: true, originalStartTimeZone: "W. Europe Standard Time", type: "occurrence", start: { dateTime: "2026-10-25T23:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-27T23:00:00", timeZone: "UTC" } };
    if (path.includes("calendarView")) return { value: [event] };
    return { ...event, start: { dateTime: "2026-10-26T00:00:00", timeZone: "W. Europe Standard Time" }, end: { dateTime: "2026-10-28T00:00:00", timeZone: "W. Europe Standard Time" } };
  };
  const page = await outlookCalendarAdapter.events(request, input);
  expect(page.events[0]).toMatchObject({ start: "2026-10-26T00:00:00", end: "2026-10-28T00:00:00", timeZone: "W. Europe Standard Time", allDay: true, recurring: true });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ path: "/v1.0/me/calendars/personal/events/all-day", prefer: 'outlook.timezone="W. Europe Standard Time", outlook.body-content-type="text"' });
});
test("timed Outlook occurrences stay in UTC without additional provider calls", async () => {
  let calls = 0;
  const request: ConnectorRequest = async () => { calls++; return { value: [{ id: "timed", subject: "Meeting", originalStartTimeZone: "W. Europe Standard Time", type: "exception", start: { dateTime: "2026-10-26T23:30:00", timeZone: "UTC" }, end: { dateTime: "2026-10-27T00:30:00", timeZone: "UTC" } }] }; };
  const page = await outlookCalendarAdapter.events(request, input);
  expect(page.events[0]).toMatchObject({ start: "2026-10-26T23:30:00", timeZone: "UTC", recurring: true });
  expect(calls).toBe(1);
});
test("UTC-midnight all-day events need no additional fetch when their original zone currently uses UTC", async () => {
  let calls = 0;
  const request: ConnectorRequest = async () => { calls++; return { value: [{ id: "holiday", isAllDay: true, originalStartTimeZone: "GMT Standard Time", start: { dateTime: "2026-12-25T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-12-26T00:00:00.0000000", timeZone: "UTC" } }] }; };
  expect((await outlookCalendarAdapter.events(request, input)).events[0]).toMatchObject({ start: "2026-12-25T00:00:00.0000000", allDay: true });
  expect(calls).toBe(1);
});

test("Outlook event summaries preserve meeting, attendee, reminder and attachment metadata", async () => {
  const request: ConnectorRequest = async () => ({ value: [{
    id: "rich", subject: "Client meeting", body: { content: "Full description", contentType: "text" },
    start: { dateTime: "2026-10-27T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-27T10:00:00", timeZone: "UTC" },
    organizer: { emailAddress: { name: "Partner", address: "partner@example.invalid" } },
    attendees: [{ emailAddress: { name: "Client", address: "client@example.invalid" }, type: "optional", status: { response: "tentativelyAccepted" } }],
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/example" }, isReminderOn: true, reminderMinutesBeforeStart: 15, hasAttachments: true,
  }] });
  expect((await outlookCalendarAdapter.events(request, input)).events[0]).toMatchObject({
    organizer: { displayName: "Partner", email: "partner@example.invalid" },
    attendees: [{ displayName: "Client", email: "client@example.invalid", optional: true, responseStatus: "tentativelyAccepted" }],
    conference: { url: "https://teams.microsoft.com/example" }, reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] }, hasAttachments: true,
  });
});


test("Google event summaries preserve supplied attachments and source links", async () => {
  const request: ConnectorRequest = async () => ({ id: "rich", summary: "Review", description: "<p>Context</p>", start: { dateTime: "2026-10-27T09:00:00Z", timeZone: "Europe/Berlin" },
    recurrence: ["RRULE:FREQ=WEEKLY"], attendees: [{ email: "client@example.invalid", responseStatus: "accepted", optional: true }],
    attachments: [{ title: "Agenda", fileUrl: "https://docs.google.com/example" }], source: { title: "Matter", url: "https://example.invalid/matter" } });
  expect(await googleCalendarAdapter.get(request, { calendarId: "personal", eventId: "rich" })).toMatchObject({
    description: "<p>Context</p>", descriptionType: "html", timeZone: "Europe/Berlin", recurrence: ["RRULE:FREQ=WEEKLY"],
    attendees: [{ email: "client@example.invalid", responseStatus: "accepted", optional: true }],
    attachments: [{ title: "Agenda", fileUrl: "https://docs.google.com/example" }], source: { title: "Matter", url: "https://example.invalid/matter" },
  });
});
