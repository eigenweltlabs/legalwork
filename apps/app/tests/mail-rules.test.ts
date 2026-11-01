import { test, expect } from 'bun:test';
import { MailClient } from '../src/react-app/domains/mail/mail-client';
import { requestMailRules } from '../src/react-app/domains/mail/mail-rules-client';

const id = '11111111-1111-4111-8111-111111111111', version = { generation: id, revision: 1 };
const definition = { name: 'Invoices', enabled: false, order: 1, sender: '', subject: 'Invoice', action: { kind: 'read' } } satisfies import('../../server/src/mail/rules-view').MailRuleDefinition;
test('rules client uses host-authenticated account routes and sends reviewed versions without credentials or scope overrides', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const client = new MailClient('http://127.0.0.1:8787', 'fixture', async (url, init) => {
    expect(init?.headers).toMatchObject({ 'X-LegalWork-Host-Token': 'fixture' }); expect(init?.credentials).toBe('omit');
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ accountId: 'a', items: [], activity: [] });
  });
  const signal = new AbortController().signal;
  await requestMailRules(client, 'a', signal); await requestMailRules(client, 'a', signal, { kind: 'save', input: { id, expected: null, definition } });
  await requestMailRules(client, 'a', signal, { kind: 'delete', input: { id, expected: version } });
  expect(calls).toEqual([
    { path: 'http://127.0.0.1:8787/mail/v1/accounts/a/rules/read', body: {} },
    { path: 'http://127.0.0.1:8787/mail/v1/accounts/a/rules/save', body: { id, expected: null, definition } },
    { path: 'http://127.0.0.1:8787/mail/v1/accounts/a/rules/delete', body: { id, expected: version } },
  ]);
});
test('rules client rejects changed accounts and redacts untrusted API error messages', async () => {
  const signal = new AbortController().signal;
  const changed = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json({ accountId: 'b', items: [], activity: [] }));
  await expect(requestMailRules(changed, 'a', signal)).rejects.toThrow('Rule account changed.');
  const failed = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json({ code: 'mail_rules_conflict', message: 'private-provider-marker' }, { status: 409 }));
  try { await requestMailRules(failed, 'a', signal); throw Error('Expected conflict'); } catch (error) { expect(String(error)).not.toContain('private-provider-marker'); }
});
