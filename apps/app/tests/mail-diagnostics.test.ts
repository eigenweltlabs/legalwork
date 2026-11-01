import { test, expect } from 'bun:test';
import { MailClient } from '../src/react-app/domains/mail/mail-client';
import { mailDiagnosticsSchema } from '../../server/src/mail/diagnostics-view';

const report = { format: 'legalwork-mail-diagnostics', version: 1, generatedAt: '2026-11-01T10:00:00.000Z', state: 'locked', snapshot: null };
test('mail diagnostics use only the existing host-authenticated local GET and do not unlock storage', async () => {
  const calls: string[] = [];
  const client = new MailClient('http://127.0.0.1:8787', 'fixture-host-token', async (url, init) => {
    calls.push(String(url)); expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({ 'X-LegalWork-Host-Token': 'fixture-host-token' });
    expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store'); expect(init?.credentials).toBe('omit');
    return Response.json(report);
  });
  expect(await client.diagnostics(new AbortController().signal)).toEqual(report);
  expect(calls).toEqual(['http://127.0.0.1:8787/mail/v1/diagnostics']);
});

test('export validation refuses extra fields or a snapshot exposed from locked storage', async () => {
  expect(mailDiagnosticsSchema.safeParse(report).success).toBe(true);
  for (const value of [{ ...report, accountId: 'private-account' }, { ...report, generatedAt: 'private address' }, { ...report, snapshot: {} }]) {
    const client = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json(value));
    await expect(client.diagnostics(new AbortController().signal)).rejects.toThrow();
  }
});

test('mail diagnostics errors retain fixed messages without provider or private error text', async () => {
  const client = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json({ error: { message: 'PRIVATE_PROVIDER_RESPONSE' } }, { status: 503 }));
  try { await client.diagnostics(new AbortController().signal); throw Error('Expected failure'); }
  catch (error) { expect(String(error)).not.toContain('PRIVATE_PROVIDER_RESPONSE'); expect(String(error)).toContain('503'); }
});
