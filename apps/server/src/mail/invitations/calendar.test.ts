import { test, expect } from "bun:test";
import type { StreamingConnectorRequest, ConnectorRequestOptions } from "../../connectors/request.js";
import { invitationCalendarAccess, openInvitationCalendar, type InvitationCalendarDependencies } from "./calendar.js";
import type { ServerConfig } from '../../types.js';
import { parseMailInvitations } from "./parse.js";
import type { InvitationCalendar } from "../invitation-reply-view.js";

const google = { id: 'event', iCalUID: 'meeting@example.test', etag: '"v1"', summary: 'Review', start: { dateTime: '2026-11-03T10:00:00Z' }, end: { dateTime: '2026-11-03T11:00:00Z' }, organizer: { email: 'organizer@example.test' }, attendees: [{ email: 'self@example.test', self: true, responseStatus: 'needsAction' }, { email: 'other@example.test', responseStatus: 'accepted' }] };
const graph = { id: 'event', iCalUId: 'meeting@example.test', changeKey: 'v1', '@odata.etag': 'W/"v1"', subject: 'Review', start: { dateTime: '2026-11-03T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-03T11:00:00', timeZone: 'UTC' }, organizer: { emailAddress: { address: 'organizer@example.test' } }, attendees: [{ emailAddress: { address: 'self@example.test' } }], isOrganizer: false, responseStatus: { response: 'notResponded' } };
const source = (extra: string[] = []) => parseMailInvitations(Buffer.from(['BEGIN:VCALENDAR','VERSION:2.0','METHOD:REQUEST','BEGIN:VEVENT','UID:meeting@example.test','DTSTART:20261103T100000Z','DTEND:20261103T110000Z',...extra,'END:VEVENT','END:VCALENDAR'].join('\r\n'))).invitations[0];
const choice = (connectorId: InvitationCalendar['connectorId']): InvitationCalendar => ({ connectorId, connectionId: 'connection', calendarId: 'calendar', account: 'actor@example.test', name: 'Selected calendar', canWrite: true });
function request(read: (path: string, options: ConnectorRequestOptions) => unknown) {
  const writes: { path: string; options: ConnectorRequestOptions }[] = [];
  const transport: StreamingConnectorRequest = Object.assign(async (path: string, options: ConnectorRequestOptions = {}) => read(path, options), {
    response: async (path: string, options: ConnectorRequestOptions = {}) => { writes.push({ path, options }); return new Response(null, { status: 202 }); },
    assertWrite: async () => {},
  });
  return { transport, writes };
}

test('Google updates only the selected calendar participant and keeps all other attendees untouched', async () => {
  const fixture = request(() => google), access = invitationCalendarAccess(fixture.transport, choice('google-calendar'), { id: 'actor', email: 'actor@example.test' }, 'actor@example.test');
  const event = await access.get('event');
  expect(event.view.replyAs).toBe('self@example.test'); // A delegate may write this calendar.
  await access.respond(event, 'accepted');
  expect(fixture.writes).toEqual([{ path: '/calendar/v3/calendars/calendar/events/event?sendUpdates=all', options: { method: 'PATCH', headers: { 'If-Match': '"v1"' }, body: { attendeesOmitted: true, attendees: [{ email: 'self@example.test', responseStatus: 'accepted' }] }, providerStatus: true } }]);
  expect(google.attendees[1].responseStatus).toBe('accepted');
});

test('Microsoft uses the selected calendar accept, tentative and decline actions with a response notification', async () => {
  const fixture = request(() => graph), access = invitationCalendarAccess(fixture.transport, choice('outlook-calendar'), { id: 'actor', email: 'actor@example.test' }, 'self@example.test');
  const event = await access.get('event');
  for (const desired of ['accepted', 'tentative', 'declined'] satisfies ('accepted' | 'tentative' | 'declined')[]) await access.respond(event, desired);
  expect(fixture.writes.map(write => write.path)).toEqual(['/v1.0/me/calendars/calendar/events/event/accept','/v1.0/me/calendars/calendar/events/event/tentativelyAccept','/v1.0/me/calendars/calendar/events/event/decline']);
  for (const write of fixture.writes) { expect(write.options.body).toEqual({ sendResponse: true }); expect(write.options.headers?.['If-Match']).toBeUndefined(); expect(write.options.providerStatus).toBe(true); }
});

test('UIDs remain query data, including apostrophes and OData-like text', async () => {
  const uid = "x' or true -- @example.test";
  for (const connectorId of ['google-calendar', 'outlook-calendar'] satisfies InvitationCalendar['connectorId'][]) {
    const paths: string[] = [];
    const fixture = request(path => { paths.push(path); return path.includes('?') ? connectorId === 'google-calendar' ? { items: [{ ...google, iCalUID: uid }] } : { value: [{ ...graph, iCalUId: uid }] } : connectorId === 'google-calendar' ? { ...google, iCalUID: uid } : { ...graph, iCalUId: uid }; });
    const access = invitationCalendarAccess(fixture.transport, choice(connectorId), { id: 'actor', email: 'self@example.test' }, 'self@example.test');
    await access.find({ ...source(), uid });
    const query = new URL('https://example.test' + paths[0]).searchParams;
    expect(query.get(connectorId === 'google-calendar' ? 'iCalUID' : '$filter')).toBe(connectorId === 'google-calendar' ? uid : `iCalUId eq '${uid.replaceAll("'", "''")}'`);
  }
});

test('Google locates a rescheduled occurrence by original start rather than its new calendar day', async () => {
  const paths: string[] = [], child = { ...google, id: 'child', recurringEventId: 'event', originalStartTime: { dateTime: '2026-11-03T10:00:00Z' }, start: { dateTime: '2027-03-01T12:00:00Z' }, end: { dateTime: '2027-03-01T13:00:00Z' } };
  const fixture = request(path => { paths.push(path); return path.includes('/instances?') ? { items: [child] } : path.includes('?') ? { items: [{ ...google, recurrence: ['RRULE:FREQ=WEEKLY'] }] } : child; });
  const access = invitationCalendarAccess(fixture.transport, choice('google-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test');
  const event = await access.find(source(['RECURRENCE-ID:20261103T100000Z']));
  expect(event.view.scope).toBe('occurrence'); expect(event.view.id).toBe('child');
  const path = paths.find(value => value.includes('/instances?')); if (!path) throw Error('missing instances read');
  const query = new URL('https://example.test' + path).searchParams;
  expect(query.get('originalStart')).toBe('2026-11-03T10:00:00.000Z'); expect(query.has('timeMin')).toBe(false);
});

test('Microsoft occurrence lookup pins the series and original start, even with a different instance UID', async () => {
  const child = { ...graph, id: 'child', iCalUId: 'instance-uid@example.test', type: 'exception', seriesMasterId: 'event', originalStart: '2026-11-03T10:00:00Z' };
  const fixture = request(path => path.includes('/instances?') ? { value: [{ ...child, id: 'unrelated', seriesMasterId: 'other-series' }, child] } : path.includes('?') ? { value: [{ ...graph, type: 'seriesMaster' }] } : child);
  const access = invitationCalendarAccess(fixture.transport, choice('outlook-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test');
  const event = await access.find(source(['RECURRENCE-ID:20261103T100000Z']));
  expect(event.view).toMatchObject({ id: 'child', uid: 'instance-uid@example.test', scope: 'occurrence' });
});

test('a cancelled Google occurrence can be recognized from its reduced provider record', async () => {
  const cancelled = { id: 'cancelled-child', status: 'cancelled', recurringEventId: 'event', originalStartTime: { dateTime: '2026-11-03T10:00:00Z' } };
  const fixture = request(path => path.includes('/instances?') ? { items: [cancelled] } : path.includes('?') ? { items: [google] } : cancelled);
  const access = invitationCalendarAccess(fixture.transport, choice('google-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test');
  await expect(access.find(source(['RECURRENCE-ID:20261103T100000Z']))).rejects.toThrow('mail_invitation_cancelled'); expect(fixture.writes).toHaveLength(0);
});

test('all-day Google occurrences keep date identity; unsupported Microsoft all-day occurrences never dispatch', async () => {
  const day = { value: '2026-11-03', kind: 'date', timeZone: null, instant: null } satisfies ReturnType<typeof source>['recurrenceId'];
  const invitation = { ...source(), recurrenceId: day };
  const originalStarts: (string | null)[] = [];
  const child = { ...google, id: 'child', recurringEventId: 'event', originalStartTime: { date: '2026-11-03' }, start: { date: '2026-11-03' }, end: { date: '2026-11-04' } };
  const fixture = request(path => {
    if (path.includes('/instances?')) { originalStarts.push(new URL('https://example.test' + path).searchParams.get('originalStart')); return { items: [child] }; }
    return path.includes('?') ? { items: [google] } : child;
  });
  const access = invitationCalendarAccess(fixture.transport, choice('google-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test');
  expect((await access.find(invitation)).view.start).toMatchObject({ value: '2026-11-03', kind: 'date' }); expect(originalStarts).toEqual(['2026-11-03']);
  const microsoft = request(() => ({ value: [{ ...graph, type: 'seriesMaster' }] }));
  await expect(invitationCalendarAccess(microsoft.transport, choice('outlook-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test').find(invitation)).rejects.toThrow('mail_invitation_unsupported_time'); expect(microsoft.writes).toHaveLength(0);
});

test('foreign instance pagination URLs cannot escape the native provider transport', async () => {
  const paths: string[] = [];
  const fixture = request(path => { paths.push(path); return path.includes('/instances?') ? { value: [], '@odata.nextLink': 'https://attacker.example/collect' } : { value: [{ ...graph, type: 'seriesMaster' }] }; });
  const access = invitationCalendarAccess(fixture.transport, choice('outlook-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test');
  await expect(access.find(source(['RECURRENCE-ID:20261103T100000Z']))).rejects.toThrow(); expect(paths.every(path => path.startsWith('/v1.0/'))).toBe(true); expect(fixture.writes).toHaveLength(0);
});

test('Microsoft all-day dates retain the original calendar days after UTC conversion', async () => {
  let originalRead = false;
  const fixture = request((_path, options) => {
    if (options.headers?.Prefer?.includes('Pacific Standard Time')) { originalRead = true; return { ...graph, isAllDay: true, originalStartTimeZone: 'Pacific Standard Time', start: { dateTime: '2026-11-03T00:00:00', timeZone: 'Pacific Standard Time' }, end: { dateTime: '2026-11-04T00:00:00', timeZone: 'Pacific Standard Time' } }; }
    return { ...graph, isAllDay: true, originalStartTimeZone: 'Pacific Standard Time', start: { dateTime: '2026-11-03T08:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-04T08:00:00', timeZone: 'UTC' } };
  });
  const access = invitationCalendarAccess(fixture.transport, choice('outlook-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test');
  expect((await access.get('event')).view.start).toMatchObject({ kind: 'date', value: '2026-11-03' }); expect(originalRead).toBe(true);
});

test('cancelled events, ambiguous lookup, missing participants and read-only calendars cannot be replied to', async () => {
  const cancelled = request(() => ({ ...google, status: 'cancelled' }));
  await expect(invitationCalendarAccess(cancelled.transport, choice('google-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test').get('event')).rejects.toThrow('mail_invitation_cancelled');
  const ambiguous = request(() => ({ value: [graph, { ...graph, id: 'duplicate' }] }));
  await expect(invitationCalendarAccess(ambiguous.transport, choice('outlook-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test').find(source())).rejects.toThrow('mail_invitation_ambiguous');
  const missing = request(() => ({ ...graph, attendees: [] }));
  await expect(invitationCalendarAccess(missing.transport, choice('outlook-calendar'), { id: 'actor', email: 'self@example.test' }, 'self@example.test').get('event')).rejects.toThrow('mail_invitation_not_invitation');
  const readOnly = request(() => google);
  await expect(invitationCalendarAccess(readOnly.transport, { ...choice('google-calendar'), canWrite: false }, { id: 'actor', email: 'self@example.test' }, 'self@example.test').assertWrite()).rejects.toThrow('mail_invitation_permission');
  expect(readOnly.writes).toHaveLength(0);
});

test('Calendar auth reuses the native request and re-proves refreshed credentials before any provider dispatch', async () => {
  const config: ServerConfig = { host: '127.0.0.1', port: 0, token: 'synthetic', hostToken: 'synthetic', approval: { mode: 'auto', timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 1, tokenSource: 'cli', hostTokenSource: 'cli', logFormat: 'pretty', logRequests: false };
  for (const connectorId of ['google-calendar', 'outlook-calendar'] satisfies InvitationCalendar['connectorId'][]) {
    let principal = 'self@example.test', token = 'expired', writes = 0;
    const proofs: string[] = [], factories: string[] = [];
    const identity = () => connectorId === 'google-calendar' ? { id: principal, primary: true, accessRole: 'owner', summary: 'Selected' } : { id: principal === 'self@example.test' ? 'immutable-actor' : 'different-actor', mail: principal };
    const dependencies: InvitationCalendarDependencies = {
      permission: async () => ({ writeAccess: true, readOnly: false }),
      proof: async (url, init) => {
        proofs.push(new Headers(init.headers).get('authorization') ?? ''); expect(init.redirect).toBe('error');
        expect(url).toBe(connectorId === 'google-calendar' ? 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary' : 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName');
        return token === 'expired' ? new Response(null, { status: 401 }) : Response.json(identity());
      },
      request: async (_config, id, connectionId, options) => {
        factories.push(`${id}:${connectionId}`);
        const check = async () => { if (options?.verifyAccess) { if (!await options.verifyAccess(token)) { token = 'renewed'; if (!await options.verifyAccess(token)) throw Error('invalid token'); } } };
        return Object.assign(async (path: string) => {
          await check();
          if (path.includes('/calendarList/primary') || path.includes('/v1.0/me?')) return identity();
          if (path.includes('/events/')) return connectorId === 'google-calendar' ? google : graph;
          return connectorId === 'google-calendar' ? { id: 'canonical-calendar', summary: 'Selected', accessRole: 'writer' } : { id: 'canonical-calendar', name: 'Selected', canEdit: true, owner: { address: 'self@example.test' } };
        }, { response: async () => { await check(); writes++; return new Response(null, { status: 202 }); }, assertWrite: async () => {} });
      },
    };
    const access = await openInvitationCalendar(config, { connectorId, connectionId: 'existing', calendarId: 'primary' }, new AbortController().signal, undefined, dependencies);
    expect(access.calendar.calendarId).toBe(connectorId === 'google-calendar' ? 'self@example.test' : 'canonical-calendar'); expect(factories).toEqual([`${connectorId}:existing`, `${connectorId}:existing`]); expect(proofs.slice(0, 2)).toEqual(['Bearer expired', 'Bearer renewed']);
    const event = await access.get('event'); principal = 'different@example.test';
    await expect(access.respond(event, 'accepted')).rejects.toThrow('mail_invitation_account_changed'); expect(writes).toBe(0);
  }
});
