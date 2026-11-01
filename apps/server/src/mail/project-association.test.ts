import { expect, test } from 'bun:test';
import { mailProjectAssociationSchema, mailProjectCommandSchema, mailProjectResultMatches } from './project-association-view.js';
import type { ProviderMessageLocator } from './model.js';
import { parseParentMessage, parseWorkerMessage, resultMatchesCommand } from './runtime/protocol.js';

const locator: ProviderMessageLocator = { provider: 'gmail', messageId: 'one' };
const project = { id: 'project', binding: 'a'.repeat(64) };
const version = { generation: '11111111-1111-4111-8111-111111111111', revision: 1 };
const association = { accountId: 'a', locator, version, project, updatedAt: 1000 };
const parent = (command: unknown) => parseParentMessage(JSON.stringify({ kind: 'request', id: '1:1', command }));
const response = (result: unknown) => parseWorkerMessage(JSON.stringify({ kind: 'response', id: '1:1', ok: true, result }));

test('project association commands constrain private metadata and cannot request filing, processing or owner authority', () => {
  const command = { operation: 'mail.project.set', accountId: 'a', input: { locator, expected: null, project } };
  expect(parent(command)).toBeDefined();
  for (const invalid of [{ ...command, ownerId: 'other' }, { ...command, input: { ...command.input, send: true } }, { ...command, input: { ...command.input, project: { ...project, binding: 'https://untrusted.test' } } }, { ...command, input: { ...command.input, model: 'remote' } }]) expect(parent(invalid)).toBeUndefined();
  expect(parent({ operation: 'mail.project.history', accountId: 'a', input: { locator, beforeRevision: 0 } })).toBeUndefined();
});

test('private worker association responses stay correlated to the account, locator and versioned correction', () => {
  const command = mailProjectCommandSchema.parse({ operation: 'mail.project.set', accountId: 'a', input: { locator, expected: null, project } });
  expect(response({ projectAssociation: association })).toBeDefined();
  expect(resultMatchesCommand(command, { projectAssociation: association })).toBe(true);
  for (const wrong of [{ ...association, accountId: 'other' }, { ...association, locator: { provider: 'gmail', messageId: 'other' } }, { ...association, project: { ...project, binding: 'b'.repeat(64) } }, { ...association, version: { ...version, revision: 2 } }]) expect(mailProjectResultMatches(command, { projectAssociation: wrong })).toBe(false);
  expect(response({ projectAssociation: { ...association, credential: 'secret' } })).toBeUndefined();
  expect(mailProjectAssociationSchema.safeParse({ ...association, version: null }).success).toBe(false);
  expect(mailProjectAssociationSchema.safeParse({ ...association, updatedAt: null }).success).toBe(false);
});

test('clearing an association retains CAS and cannot accept another generation or a skipped revision', () => {
  const command = mailProjectCommandSchema.parse({ operation: 'mail.project.set', accountId: 'a', input: { locator, expected: version, project: null } });
  for (const revision of [1, 2]) expect(mailProjectResultMatches(command, { projectAssociation: { ...association, project: null, version: { ...version, revision } } })).toBe(true);
  for (const changed of [{ ...version, revision: 3 }, { ...version, generation: '22222222-2222-4222-8222-222222222222' }]) expect(mailProjectResultMatches(command, { projectAssociation: { ...association, project: null, version: changed } })).toBe(false);
});

test('association history is bounded, strictly descending and bound to its own message', () => {
  const command = mailProjectCommandSchema.parse({ operation: 'mail.project.history', accountId: 'a', input: { locator, beforeRevision: 22 } });
  const items = Array.from({ length: 20 }, (_, index) => ({ version: { ...version, revision: 21 - index }, project, at: 1000, source: 'manual' }));
  const page = { accountId: 'a', locator, items, nextRevision: 2 };
  expect(mailProjectResultMatches(command, { projectHistory: page })).toBe(true);
  expect(mailProjectResultMatches(command, { projectHistory: { ...page, nextRevision: 3 } })).toBe(false);
  expect(mailProjectResultMatches(command, { projectHistory: { ...page, items: [...items].reverse() } })).toBe(false);
  expect(mailProjectResultMatches(command, { projectHistory: { ...page, items: [{ ...items[0], version: { ...version, revision: 22 } }] } })).toBe(false);
  expect(mailProjectResultMatches(command, { projectAssociation: association })).toBe(false);
});
