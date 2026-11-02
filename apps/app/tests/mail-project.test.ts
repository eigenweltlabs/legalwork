import { expect, test } from 'bun:test';
import { MailClient, type MailMessageView } from '../src/react-app/domains/mail/mail-client';
import { mailProjectCatalog, mailProjectHistory, readMailProject, setMailProject } from '../src/react-app/domains/mail/mail-project-client';

const item: MailMessageView = { accountId: 'a', key: '["gmail","one"]', locator: { provider: 'gmail', messageId: 'one' }, subject: 'Synthetic', threadId: null, rfcMessageId: null, memberships: [], removed: false, contentState: 'complete', metadata: null };
const version = { generation: '11111111-1111-4111-8111-111111111111', revision: 1 };
const project = { id: 'project', binding: 'a'.repeat(64), name: 'Synthetic project' };
const state = { accountId: item.accountId, locator: item.locator, version, project, unavailable: false, updatedAt: 1 };

test('project assignment shares host transport and sends only exact identity, reviewed version and destination binding', async () => {
  const calls: unknown[] = [];
  const client = new MailClient('http://127.0.0.1:8787', 'fixture', async (url, init) => {
    expect(String(url)).toBe('http://127.0.0.1:8787/mail/v1/projects'); expect(init?.headers).toMatchObject({ 'X-LegalWork-Host-Token': 'fixture' });
    calls.push(JSON.parse(String(init?.body))); return Response.json(state);
  });
  const signal = new AbortController().signal, current = await readMailProject(client, item, signal);
  await setMailProject(client, item, current, { id: project.id, binding: project.binding }, signal);
  expect(calls).toEqual([{ action: 'read', accountId: 'a', input: { locator: item.locator } }, { action: 'set', accountId: 'a', input: { locator: item.locator, expected: version, project: { id: project.id, binding: project.binding } } }]);
});

test('project reads and edits cannot consume cross-account or cross-message responses', async () => {
  for (const response of [{ ...state, accountId: 'other' }, { ...state, locator: { provider: 'gmail', messageId: 'other' } }]) {
    const client = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json(response));
    await expect(readMailProject(client, item, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(setMailProject(client, item, response, null, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' });
  }
});

test('catalog and history are paginated without broadening the message scope or accepting stalled history', async () => {
  const calls: unknown[] = [], signal = new AbortController().signal;
  const entry = { version, project, unavailable: false, at: 1, source: 'manual' };
  const client = new MailClient('http://127.0.0.1:8787', 'fixture', async (_url, init) => {
    const input = JSON.parse(String(init?.body)); calls.push(input);
    return Response.json(input.action === 'catalog' ? { items: [project], nextCursor: null } : { accountId: item.accountId, locator: item.locator, items: [entry], nextRevision: null });
  });
  await mailProjectCatalog(client, signal, 'previous'); await mailProjectHistory(client, item, signal, 2);
  expect(calls).toEqual([{ action: 'catalog', after: 'previous' }, { action: 'history', accountId: 'a', input: { locator: item.locator, beforeRevision: 2 } }]);
  await expect(mailProjectHistory(client, item, signal, 1)).rejects.toMatchObject({ code: 'unavailable' });
});

test('conflict errors stay typed and hide raw provider or database error bodies', async () => {
  const client = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json({ code: 'mail_project_conflict', message: 'private-database-marker' }, { status: 409 }));
  try { await readMailProject(client, item, new AbortController().signal); throw Error('Expected conflict'); }
  catch (error) { expect(error).toMatchObject({ code: 'conflict' }); expect(String(error)).not.toContain('private-database-marker'); }
});
