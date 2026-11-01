import { test, expect } from 'bun:test';
import { MailClient, type MailMessageView } from '../src/react-app/domains/mail/mail-client';
import { requestMailClassifier, previewMailClassification } from '../src/react-app/domains/mail/mail-classifier-client';
import { mailClassifierDisplayPreviewSchema } from '../../server/src/mail/classifier-view';

const item: MailMessageView = { accountId: 'a', key: '["gmail","one"]', locator: { provider: 'gmail', messageId: 'one' }, subject: 'MAT-123', threadId: null, rfcMessageId: null, memberships: [], removed: false, contentState: 'complete', metadata: null };
const version = { generation: '11111111-1111-4111-8111-111111111111', revision: 1 }, project = { id: 'project', binding: 'a'.repeat(64), name: 'Synthetic project' };
const definition = { mode: 'suggestions', rules: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Reference rule', enabled: true, order: 1, project, unavailable: false, criteria: { sender: '', domain: '', reference: 'MAT-123', subject: '' } }], exclusions: { senders: [], domains: [], subjects: [] } };
const state = { accountId: 'a', version, definition };
const preview = { accountId: 'a', locator: item.locator, version, status: 'suggested', candidates: [{ project, rules: [{ id: definition.rules[0].id, name: 'Reference rule', reasons: ['reference'] }] }], unavailable: 0 };

test('classifier settings and preview use the same local authenticated POST without reading bodies, unlocking or invoking a model', async () => {
  const calls: unknown[] = [], signal = new AbortController().signal;
  const client = new MailClient('http://127.0.0.1:8787', 'fixture', async (url, init) => {
    expect(String(url)).toBe('http://127.0.0.1:8787/mail/v1/classifier'); expect(init?.headers).toMatchObject({ 'X-LegalWork-Host-Token': 'fixture' });
    const input = JSON.parse(String(init?.body)); calls.push(input);
    return Response.json(input.operation === 'mail.classifier.preview' ? preview : state);
  });
  expect((await requestMailClassifier(client, 'a', signal)).definition.mode).toBe('suggestions');
  expect((await previewMailClassification(client, item, signal)).candidates[0].project.id).toBe(project.id);
  expect(calls).toEqual([{ operation: 'mail.classifier.read', accountId: 'a' }, { operation: 'mail.classifier.preview', accountId: 'a', input: { locator: item.locator } }]);
});

test('classifier clients reject cross-account, cross-provider, stale-version and ignored-cancellation responses', async () => {
  const signal = new AbortController().signal;
  const foreign = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json({ ...state, accountId: 'other' }));
  await expect(requestMailClassifier(foreign, 'a', signal)).rejects.toMatchObject({ code: 'unavailable' });
  for (const value of [{ ...preview, accountId: 'other' }, { ...preview, locator: { provider: 'graph', messageId: 'one' } }]) {
    const client = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json(value)); await expect(previewMailClassification(client, item, signal)).rejects.toMatchObject({ code: 'unavailable' });
  }
  const stale = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json(state));
  const editable = { mode: 'suggestions', rules: definition.rules.map(({ unavailable: _unavailable, ...rule }) => ({ ...rule, project: { id: project.id, binding: project.binding } })), exclusions: definition.exclusions } satisfies import('../../server/src/mail/classifier-view').MailClassifierSave['definition'];
  await expect(requestMailClassifier(stale, 'a', signal, { expected: version, definition: editable })).rejects.toMatchObject({ code: 'unavailable' });
  const controller = new AbortController(); const ignored = new MailClient('http://127.0.0.1:8787', 'fixture', async () => { controller.abort(); return Response.json(preview); });
  await expect(previewMailClassification(ignored, item, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

test('redacted conflicting projects remain ambiguous and never become a sole suggested destination', () => {
  expect(mailClassifierDisplayPreviewSchema.safeParse({ ...preview, status: 'ambiguous', unavailable: 1 }).success).toBe(true);
  expect(mailClassifierDisplayPreviewSchema.safeParse({ ...preview, unavailable: 1 }).success).toBe(false);
});

test('classifier failures hide raw error payloads and retain their actionable error code', async () => {
  const client = new MailClient('http://127.0.0.1:8787', 'fixture', async () => Response.json({ code: 'mail_classifier_conflict', message: 'private-provider-marker' }, { status: 409 }));
  try { await requestMailClassifier(client, 'a', new AbortController().signal); throw Error('Expected conflict'); }
  catch (error) { expect(error).toMatchObject({ code: 'conflict' }); expect(String(error)).not.toContain('private-provider-marker'); }
});
