import { test, expect } from 'bun:test';
import { registerMailInvitationReplyRoutes } from '../../routes/mail-invitations.js';
import { matchRoute, type Route, type RequestContext } from '../../routes/registry.js';
import { ApprovalService } from '../../approvals.js';
import { ReloadEventStore } from '../../events.js';
import { TokenService } from '../../tokens.js';
import type { ServerConfig } from '../../types.js';
import { LocalMailService } from '../service.js';
import { MailInvitationReplies } from './replies.js';
import { InvitationReplyError } from '../invitation-reply-view.js';

test('invitation reply routes are local host-only, strict and do not expose the internal journal', async () => {
  const config: ServerConfig = { host: '127.0.0.1', port: 0, token: 'synthetic', hostToken: 'synthetic-host', configPath: '/unused', approval: { mode: 'auto', timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 1, tokenSource: 'cli', hostTokenSource: 'cli', logFormat: 'pretty', logRequests: false };
  const mail = new LocalMailService({ ownerId: 'synthetic', databasePath: '/unused', loadKey: async () => { throw Error('must not open'); }, executable: { kind: 'node', path: process.execPath }, entryPoint: '/unused' });
  const replies = new MailInvitationReplies(mail, async () => { throw Error('must not use provider'); }), routes: Route[] = [];
  let writes = 0, reads = 0;
  replies.respond = async () => { writes++; return { outcome: 'confirmed', response: 'accepted' }; };
  replies.preview = async () => { reads++; throw new InvitationReplyError('permission'); };
  replies.calendars = async () => ({ calendars: [], unavailable: [] });
  registerMailInvitationReplyRoutes(routes, config, mail, replies);
  const approvals = new ApprovalService(config.approval), reloadEvents = new ReloadEventStore(), tokens = new TokenService(config);
  async function call(path: string, body: unknown, host = true, contentType = 'application/json') {
    const url = new URL(path, 'http://127.0.0.1'), route = matchRoute(routes, 'POST', url.pathname); if (!route) throw Error('missing route');
    const request = new Request(url, { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body) });
    const context: RequestContext = { request, url, params: route.params, config, approvals, reloadEvents, tokens, ...(host ? { actor: { type: 'host' } } : {}) };
    return route.handler(context);
  }
  try {
    expect(routes).toHaveLength(3); expect(routes.every(route => route.auth === 'host-token')).toBe(true);
    expect(matchRoute(routes, 'POST', '/mail/v1/accounts/mail/invitation/journal')).toBeNull();
    const path = '/mail/v1/accounts/mail/messages/invitations/respond', token = 'a'.repeat(64);
    await expect(call(path, { token }, false)).rejects.toMatchObject({ status: 401 });
    for (const value of [{ token, response: 'declined' }, { token, calendar: 'caller-url' }, { token: 'invalid' }]) await expect(call(path, value)).rejects.toMatchObject({ status: 400 });
    await expect(call(path + '?token=override', { token })).rejects.toMatchObject({ status: 400 });
    await expect(call(path, { token }, true, 'text/plain')).rejects.toMatchObject({ status: 400 });
    expect(writes).toBe(0);
    const result = await call(path, { token }); expect(result.headers.get('cache-control')).toBe('no-store'); expect(await result.json()).toEqual({ outcome: 'confirmed', response: 'accepted' }); expect(writes).toBe(1);
    const input = { source: { locator: { provider: 'gmail', messageId: 'm' }, partId: 'p', referenceId: 'sha256:' + token, rawReferenceId: 'sha256:' + token }, index: 0, calendar: { connectorId: 'google-calendar', connectionId: 'connection', calendarId: 'calendar' }, response: 'accepted' };
    await expect(call('/mail/v1/accounts/mail/messages/invitations/preview', { ...input, accessToken: 'secret' })).rejects.toMatchObject({ status: 400 }); expect(reads).toBe(0);
    await expect(call('/mail/v1/accounts/mail/messages/invitations/preview', input)).rejects.toMatchObject({ status: 403, code: 'mail_invitation_permission', message: 'Invitation reply unavailable' }); expect(reads).toBe(1);
    const remote: Route[] = []; registerMailInvitationReplyRoutes(remote, { ...config, host: '0.0.0.0' }, mail, replies); expect(remote).toHaveLength(0);
  } finally { replies.close(); await mail.stop(); }
});
