import { test, expect } from 'bun:test';
import { MailClient, MailRequestError, type MailMessageView, type MailPartView } from '../src/react-app/domains/mail/mail-client';
import { MailInvitationsClient } from '../src/react-app/domains/mail/mail-invitations-client';

test('confirmation sends only the one-use review token to the pinned mail account', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = new MailClient('http://127.0.0.1:8787', 'synthetic-host', async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    expect(init?.headers).toMatchObject({ 'X-LegalWork-Host-Token': 'synthetic-host' }); expect(init?.redirect).toBe('error');
    return Response.json({ outcome: 'uncertain', response: 'accepted' });
  });
  const item: MailMessageView = { accountId: 'mail', key: '["gmail","message"]', locator: { provider: 'gmail', messageId: 'message' }, rawReferenceId: `sha256:${'a'.repeat(64)}`, subject: 'Meeting', threadId: null, rfcMessageId: null, memberships: [], removed: false, contentState: 'complete', metadata: null };
  expect((await new MailInvitationsClient(client).respond(item, 'b'.repeat(64), new AbortController().signal)).outcome).toBe('uncertain');
  expect(requests).toEqual([{ path: 'http://127.0.0.1:8787/mail/v1/accounts/mail/messages/invitations/respond', body: { token: 'b'.repeat(64) } }]);
});

test('review pins the exact downloaded invitation rather than accepting caller event content', async () => {
  let body: unknown;
  const client = new MailClient('http://127.0.0.1:8787', 'synthetic', async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ error: { code: 'mail_invitation_changed' } }, { status: 409 }); });
  const item: MailMessageView = { accountId: 'mail', key: '["gmail","message"]', locator: { provider: 'gmail', messageId: 'message' }, rawReferenceId: `sha256:${'a'.repeat(64)}`, subject: 'Meeting', threadId: null, rfcMessageId: null, memberships: [], removed: false, contentState: 'complete', metadata: null };
  const part: MailPartView = { key: 'p', kind: 'attachment', partId: 'p', referenceId: `sha256:${'b'.repeat(64)}`, sha256: 'b'.repeat(64), bytes: 100, bytesAvailable: true, state: 'stored', filename: 'invite.ics', contentType: 'text/calendar', contentId: null };
  const calendar = { connectorId: 'google-calendar', connectionId: 'connection', calendarId: 'calendar' } satisfies Parameters<MailInvitationsClient['preview']>[3];
  await expect(new MailInvitationsClient(client).preview(item, part, 0, calendar, 'accepted', new AbortController().signal)).rejects.toMatchObject({ invitationCode: 'changed' });
  expect(body).toEqual({ source: { locator: item.locator, rawReferenceId: item.rawReferenceId, partId: part.partId, referenceId: part.referenceId }, index: 0, calendar, response: 'accepted' });
});

test('unknown provider failures cannot inject their text or a new reply-error code into the UI', async () => {
  const client = new MailClient('http://127.0.0.1:8787', 'synthetic', async () => Response.json({ error: { code: 'mail_invitation_secret', message: 'private provider data' } }, { status: 503 }));
  try { await new MailInvitationsClient(client).calendars(new AbortController().signal); throw Error('expected failure'); }
  catch (error) { expect(error).toBeInstanceOf(MailRequestError); expect(error instanceof MailRequestError && error.invitationCode).toBeUndefined(); expect(String(error)).not.toContain('private provider data'); }
});
