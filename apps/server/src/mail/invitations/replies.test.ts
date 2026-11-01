import { afterEach, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { MailInvitationReplies } from "./replies.js";
import type { MailService, MailServiceStatus } from "../service-interface.js";
import type { MailMessageView, MailPartView } from "../read-view.js";
import type { InvitationCalendarAccess, InvitationCalendarIdentity } from "./calendar.js";
import type { InvitationReplyJournalResult, InvitationReplyPreviewInput } from "../invitation-reply-view.js";

const services: MailInvitationReplies[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function fixture() {
  const bytes = Buffer.from(['BEGIN:VCALENDAR','VERSION:2.0','METHOD:REQUEST','BEGIN:VEVENT','UID:meeting@example.test','SUMMARY:Review','DTSTART:20261103T100000Z','DTEND:20261103T110000Z','ORGANIZER:mailto:organizer@example.test','ATTENDEE:mailto:self@example.test','END:VEVENT','END:VCALENDAR'].join('\r\n'));
  const hash = createHash('sha256').update(bytes).digest('hex'), referenceId = `sha256:${hash}`, rawReferenceId = `sha256:${'a'.repeat(64)}`;
  const locator = { provider: 'gmail', messageId: 'message' } satisfies MailMessageView['locator'];
  const message: MailMessageView = { accountId: 'mail', key: '["gmail","message"]', locator, rawReferenceId, subject: 'Review', threadId: null, rfcMessageId: null, removed: false, memberships: [], contentState: 'complete', metadata: null };
  const part: MailPartView = { key: 'p', kind: 'attachment', partId: 'p', referenceId, bytes: bytes.length, sha256: hash, state: 'stored', bytesAvailable: true, filename: 'invite.ics', contentType: 'text/calendar', contentId: null };
  let state: MailServiceStatus['state'] = 'ready';
  const listeners = new Set<() => void>(), entries = new Map<string, NonNullable<InvitationReplyJournalResult['entry']>>();
  const mail: Pick<MailService, 'status' | 'readMessage' | 'listParts' | 'readContent' | 'onLock' | 'invitationJournal'> = {
    status: () => ({ protocolVersion: 1, state, syncSupported: true }), onLock: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    readMessage: async () => ({ ...message }), listParts: async () => ({ items: [part], nextCursor: null }),
    readContent: async accountId => ({ accountId, locator, referenceId, totalBytes: bytes.length, sha256: hash, offset: 0, data: bytes.toString('base64'), nextOffset: null }),
    invitationJournal: async (accountId, input) => {
      const entry = entries.get(input.key) ?? null;
      if (input.action === 'read') return { accountId, entry: entry ? { ...entry } : null, claimed: false };
      if (input.action === 'begin') { if (entry?.state === 'uncertain') return { accountId, entry: { ...entry }, claimed: false }; const next = { key: input.key, attemptId: input.attemptId, response: input.response, state: 'uncertain', updatedAt: Date.now() } satisfies NonNullable<InvitationReplyJournalResult['entry']>; entries.set(input.key, next); return { accountId, entry: { ...next }, claimed: true }; }
      if (!entry || entry.attemptId !== input.attemptId) throw Error('journal conflict'); const next = { ...entry, state: input.state }; entries.set(input.key, next); return { accountId, entry: { ...next }, claimed: false };
    },
  };
  let identity: InvitationCalendarIdentity = { id: 'actor', email: 'self@example.test' };
  let event: Awaited<ReturnType<InvitationCalendarAccess['get']>> = { etag: '"v1"', view: { id: 'event', uid: 'meeting@example.test', revision: 'b'.repeat(64), title: 'Review', description: '', descriptionType: 'text', organizer: 'organizer@example.test', replyAs: 'self@example.test', location: '', start: { value: '2026-11-03T10:00:00Z', kind: 'utc', timeZone: 'UTC', instant: '2026-11-03T10:00:00.000Z' }, end: { value: '2026-11-03T11:00:00Z', kind: 'utc', timeZone: 'UTC', instant: '2026-11-03T11:00:00.000Z' }, scope: 'event', currentResponse: null, webUrl: null } };
  let writes = 0, allowed = true;
  const access: InvitationCalendarAccess = {
    identity, calendar: { connectorId: 'google-calendar', connectionId: 'connection', calendarId: 'calendar', name: 'Personal', account: 'self@example.test', canWrite: true },
    find: async () => structuredClone(event), get: async () => structuredClone(event), assertWrite: async () => { if (!allowed) throw Error('permission revoked'); },
    respond: async (_event, response) => { writes++; event = { ...event, view: { ...event.view, revision: 'c'.repeat(64), currentResponse: response } }; return new Response(null, { status: 200 }); },
  };
  const input: InvitationReplyPreviewInput = { source: { locator, partId: 'p', referenceId, rawReferenceId }, index: 0, calendar: { connectorId: 'google-calendar', connectionId: 'connection', calendarId: 'calendar' }, response: 'accepted' };
  const make = () => { const service = new MailInvitationReplies(mail, async () => ({ ...access, identity: { ...identity } })); services.push(service); return service; };
  return { mail, message, access, input, make, entries, writes: () => writes, recordWrite: () => writes++, current: () => event, change: (update: Partial<typeof event.view>) => { event = { ...event, view: { ...event.view, ...update } }; }, identity: (next: InvitationCalendarIdentity) => { identity = next; }, revoke: () => { allowed = false; }, lock: () => { state = 'locked'; for (const listener of listeners) listener(); }, unlock: () => { state = 'ready'; } };
}
async function token(service: MailInvitationReplies, input: InvitationReplyPreviewInput) { const preview = await service.preview('mail', input); if (!preview.token) throw Error('missing review'); return preview.token; }

test('a reviewed current event can be replied to once; unchanged responses do not dispatch', async () => {
  const f = fixture(), service = f.make(), review = await token(service, f.input);
  expect(await service.respond('mail', review)).toEqual({ outcome: 'confirmed', response: 'accepted' });
  expect(f.writes()).toBe(1); expect([...f.entries.values()][0].state).toBe('confirmed');
  await expect(service.respond('mail', review)).rejects.toThrow('mail_invitation_expired');
  expect((await service.preview('mail', f.input)).status).toBe('unchanged'); expect(f.writes()).toBe(1);
});

test('calendar updates are shown for fresh review; later edits and organizer changes invalidate approval', async () => {
  const f = fixture(), service = f.make();
  f.change({ title: 'Updated review', location: 'New office' });
  const preview = await service.preview('mail', f.input); expect(preview.changedSinceInvitation).toBe(true); expect(preview.event.title).toBe('Updated review');
  if (!preview.token) throw Error('missing review'); f.change({ revision: 'd'.repeat(64), location: 'Another office' });
  await expect(service.respond('mail', preview.token)).rejects.toThrow('mail_invitation_changed');
  f.change({ organizer: 'different@example.test' }); await expect(service.preview('mail', f.input)).rejects.toThrow('mail_invitation_not_invitation'); expect(f.writes()).toBe(0);
});

test('source replacement, account changes, removed messages and revoked rights cannot dispatch', async () => {
  for (const action of ['source', 'account', 'removed', 'rights']) {
    const f = fixture(), service = f.make(), review = await token(service, f.input);
    if (action === 'source') f.message.rawReferenceId = `sha256:${'f'.repeat(64)}`;
    if (action === 'account') f.identity({ id: 'different', email: 'different@example.test' });
    if (action === 'removed') f.message.removed = true;
    if (action === 'rights') f.revoke();
    await expect(service.respond('mail', review)).rejects.toThrow(); expect(f.writes()).toBe(0); expect(f.entries.size).toBe(0);
  }
});

test('a source change during Calendar reads is caught before claiming the dispatch', async () => {
  const f = fixture(), service = f.make(), review = await token(service, f.input), get = f.access.get;
  f.access.get = async (...args) => { const result = await get(...args); f.message.rawReferenceId = `sha256:${'f'.repeat(64)}`; return result; };
  await expect(service.respond('mail', review)).rejects.toThrow('mail_conflict'); expect(f.writes()).toBe(0); expect(f.entries.size).toBe(0);
});

test('uncertain dispatches survive coordinator restart and reconcile only through an observed provider response', async () => {
  const f = fixture(), service = f.make(), review = await token(service, f.input);
  f.access.respond = async () => { f.recordWrite(); throw Error('response lost'); };
  expect((await service.respond('mail', review)).outcome).toBe('uncertain'); service.close();
  const restarted = f.make(); expect((await restarted.preview('mail', { ...f.input, response: 'declined' })).status).toBe('pending'); expect(f.writes()).toBe(1);
  f.change({ currentResponse: 'accepted' });
  expect((await restarted.preview('mail', f.input)).status).toBe('unchanged'); expect([...f.entries.values()][0].state).toBe('confirmed');
});

test('Microsoft-style asynchronous success remains uncertain until the Calendar reports the response', async () => {
  const f = fixture(), service = f.make(), review = await token(service, f.input);
  f.access.respond = async () => { f.recordWrite(); return new Response(null, { status: 202 }); };
  expect((await service.respond('mail', review)).outcome).toBe('uncertain'); expect(f.writes()).toBe(1); expect([...f.entries.values()][0].state).toBe('uncertain');
});

test('two simultaneous reviews cannot dispatch through the same unresolved journal claim', async () => {
  const f = fixture(), service = f.make(), first = await token(service, f.input), second = await token(service, { ...f.input, response: 'declined' });
  let release: (() => void) | undefined;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let dispatched: (() => void) | undefined;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  f.access.respond = async () => { f.recordWrite(); dispatched?.(); await paused; return new Response(null, { status: 202 }); };
  const sending = service.respond('mail', first); await started;
  await expect(service.respond('mail', second)).rejects.toThrow('mail_invitation_pending'); release?.(); await sending; expect(f.writes()).toBe(1);
});

test('provider precondition and permission refusals are recorded as rejected without retrying', async () => {
  for (const status of [403, 412]) {
    const f = fixture(), service = f.make(), review = await token(service, f.input);
    f.access.respond = async () => { f.recordWrite(); return new Response(null, { status }); };
    expect((await service.respond('mail', review)).outcome).toBe('rejected'); expect(f.writes()).toBe(1); expect([...f.entries.values()][0].state).toBe('rejected');
  }
});

test('a Calendar change while the durable claim is being written cannot dispatch an old review', async () => {
  const f = fixture(), service = f.make(), review = await token(service, f.input), journal = f.mail.invitationJournal;
  if (!journal) throw Error('missing journal');
  f.mail.invitationJournal = async (...args) => { const result = await journal(...args); if (args[1].action === 'begin') f.change({ revision: 'e'.repeat(64), title: 'New organizer update' }); return result; };
  expect((await service.respond('mail', review)).outcome).toBe('rejected'); expect(f.writes()).toBe(0); expect([...f.entries.values()][0].state).toBe('rejected');
});

test('lock/unlock and expiration clear review authority without creating a provider operation', async () => {
  const f = fixture(), service = f.make(), review = await token(service, f.input);
  f.lock(); f.unlock(); await expect(service.respond('mail', review)).rejects.toThrow('mail_invitation_expired');
  const next = await token(service, f.input), original = Date.now;
  try { const now = original(); Date.now = () => now + 6 * 60000; await expect(service.respond('mail', next)).rejects.toThrow('mail_invitation_expired'); }
  finally { Date.now = original; }
  expect(f.writes()).toBe(0);
});

test('closing during a provider read cannot produce a review or a journal claim', async () => {
  const f = fixture(), service = f.make();
  f.access.find = async () => { service.close(); return structuredClone(f.current()); };
  await expect(service.preview('mail', f.input)).rejects.toThrow('mail_locked'); expect(f.writes()).toBe(0); expect(f.entries.size).toBe(0);
});

test('replying to a different calendar participant or occurrence scope requires a matching invitation', async () => {
  const f = fixture(), service = f.make(); f.change({ replyAs: 'different@example.test' });
  await expect(service.preview('mail', f.input)).rejects.toThrow('mail_invitation_not_invitation');
  f.change({ replyAs: 'self@example.test', scope: 'occurrence' }); await expect(service.preview('mail', f.input)).rejects.toThrow('mail_invitation_changed'); expect(f.writes()).toBe(0);
});
