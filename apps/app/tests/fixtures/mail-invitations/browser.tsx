import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MailClient, type MailMessageView, type MailPartView } from '../../../src/react-app/domains/mail/mail-client';
import { MailInvitations } from '../../../src/react-app/domains/mail/mail-invitations';
import { invitationReplyConfirmInputSchema, invitationReplyPreviewInputSchema, type InvitationCalendar } from '../../../../server/src/mail/invitation-reply-view';

type Scenario = 'google' | 'outlook' | 'cancelled';
type Call = { scenario: Scenario; path: string; body: unknown };
declare global {
  interface Window {
    invitationFixture: { select(scenario: Scenario): void; release(): void; saved(): void; calls: Call[] };
  }
}

const item: MailMessageView = { accountId: 'synthetic-mail', key: 'invitation', locator: { provider: 'gmail', messageId: 'invitation' }, rawReferenceId: `sha256:${'a'.repeat(64)}`, subject: 'Matter review', threadId: null, rfcMessageId: null, memberships: ['INBOX'], removed: false, contentState: 'complete', metadata: null };
const part: MailPartView = { key: 'ics', kind: 'attachment', partId: 'ics', referenceId: `sha256:${'b'.repeat(64)}`, sha256: 'b'.repeat(64), bytes: 100, bytesAvailable: true, state: 'stored', filename: 'invitation.ics', contentType: 'text/calendar', contentId: null };
const start = { value: '2026-11-04T10:00:00Z', kind: 'utc', instant: '2026-11-04T10:00:00Z', timeZone: 'UTC' };
const end = { ...start, value: '2026-11-04T11:00:00Z', instant: '2026-11-04T11:00:00Z' };
let scenario: Scenario = 'google', phase: 'ready' | 'pending' | 'saved' = 'ready';
let release: (() => void) | undefined;
const calls: Call[] = [];
const calendar = (): InvitationCalendar => ({ connectorId: scenario === 'outlook' ? 'outlook-calendar' : 'google-calendar', connectionId: `synthetic-${scenario}`, calendarId: 'selected-calendar', name: scenario === 'outlook' ? 'Delegated calendar' : 'Personal calendar', account: scenario === 'outlook' ? 'delegate@example.test' : 'owner@example.test', canWrite: true });
const client = new MailClient('http://127.0.0.1:1', 'synthetic-only', async (url, init) => {
  const path = new URL(String(url)).pathname, body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ scenario, path, body });
  if (path.endsWith('/messages/invitations')) return Response.json({ invitations: [{ uid: 'synthetic-event', method: scenario === 'cancelled' ? 'CANCEL' : 'REQUEST', sequence: 2, status: scenario === 'cancelled' ? 'cancelled' : 'update', title: 'Matter review', description: 'Discuss the revised contract.', location: 'Room 12', organizer: 'organizer@example.test', attendees: ['owner@example.test'], start, end, recurrence: [], recurrenceId: scenario === 'outlook' ? start : null, delegated: scenario === 'outlook' }] });
  if (path.endsWith('/invitations/calendars')) return Response.json({ calendars: [{ ...calendar(), calendarId: 'read-only', name: 'Read-only calendar', canWrite: false }, calendar()], unavailable: [] });
  if (path.endsWith('/invitations/preview')) {
    const input = invitationReplyPreviewInputSchema.parse(body);
    if (input.calendar.calendarId !== 'selected-calendar' || input.calendar.connectorId !== calendar().connectorId) throw Error('Unexpected reply calendar');
    return Response.json({ token: phase === 'ready' ? 'c'.repeat(64) : null, expiresAt: Date.now() + 300_000, calendar: calendar(), event: { id: 'event', uid: 'synthetic-event', revision: 'd'.repeat(64), title: 'Updated matter review', description: '<p>Current calendar description</p>', descriptionType: 'html', organizer: 'organizer@example.test', replyAs: 'owner@example.test', location: 'Room 14', start, end, scope: scenario === 'outlook' ? 'occurrence' : 'event', currentResponse: phase === 'saved' ? 'accepted' : null, webUrl: null }, response: input.response, status: phase === 'ready' ? 'ready' : phase === 'pending' ? 'pending' : 'unchanged', changedSinceInvitation: true });
  }
  if (path.endsWith('/invitations/respond')) {
    invitationReplyConfirmInputSchema.parse(body);
    await new Promise<void>(done => { release = done; });
    phase = 'pending';
    return Response.json({ outcome: 'uncertain', response: 'accepted' });
  }
  throw Error(`Unexpected synthetic endpoint: ${path}`);
});

window.invitationFixture = { calls, select: () => {}, release: () => { release?.(); release = undefined; }, saved: () => { phase = 'saved'; } };
function Fixture() {
  const [selected, setSelected] = useState<Scenario>('google');
  window.invitationFixture.select = value => { scenario = value; phase = 'ready'; setSelected(value); };
  return <MemoryRouter><main className="mx-auto max-w-3xl p-6"><MailInvitations key={selected} client={client} item={item} part={part} /></main></MemoryRouter>;
}
const root = document.getElementById('root');
if (!root) throw Error('Missing invitation fixture root');
createRoot(root).render(<Fixture />);
