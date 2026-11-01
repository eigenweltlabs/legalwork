import { expect, test } from 'bun:test';
import { classifyMailProject } from './classifier.js';
import { mailClassifierDefinitionSchema, mailClassifierCommandSchema, mailClassifierResultMatches } from './classifier-view.js';
import { parseParentMessage, parseWorkerMessage } from './runtime/protocol.js';

const project = { id: 'one', binding: 'a'.repeat(64) }, other = { id: 'two', binding: 'b'.repeat(64) };
const criteria = { sender: '', domain: '', reference: 'MAT-123', subject: '' };
const rule = { id: '11111111-1111-4111-8111-111111111111', name: 'Matter reference', enabled: true, order: 1, project, criteria };
const definition = mailClassifierDefinitionSchema.parse({ mode: 'suggestions', rules: [rule], exclusions: { senders: [], domains: [], subjects: [] } });
const metadata = { from: 'Client <client@example.test>', subject: 'Re: [MAT-123] contract' };

test('classifier defaults and commands cannot add model, owner, filesystem, provider-write or automatic authority', () => {
  expect(classifyMailProject({ ...definition, mode: 'off' }, metadata)).toEqual({ status: 'off', candidates: [] });
  for (const extra of [{ ownerId: 'other' }, { model: 'remote' }, { send: true }, { projectPath: '/private' }]) expect(mailClassifierCommandSchema.safeParse({ operation: 'mail.classifier.preview', accountId: 'a', input: { locator: { provider: 'gmail', messageId: 'one' } }, ...extra }).success).toBe(false);
  expect(mailClassifierDefinitionSchema.safeParse({ ...definition, mode: 'automatic' }).success).toBe(false);
  expect(mailClassifierDefinitionSchema.safeParse({ ...definition, rules: [{ ...rule, criteria: { sender: '', domain: '', reference: '', subject: '' } }] }).success).toBe(false);
  expect(mailClassifierDefinitionSchema.safeParse({ ...definition, rules: [rule, rule] }).success).toBe(false);
});

test('references match literal subject tokens and abstain on larger or visually similar references', () => {
  for (const subject of ['[MAT-123]', 'mat-123: contract', 'Re: MAT-123.', '⚖ MAT-123 (urgent)']) expect(classifyMailProject(definition, { ...metadata, subject }).status).toBe('suggested');
  for (const subject of ['MAT-1234', 'xMAT-123', 'MAT-123_suffix', 'MAT-123/4', 'MAT-123-extra', 'MAT-１２３', 'MAT-123\u0301', 'MAT-123а', 'X/MAT-123']) expect(classifyMailProject(definition, { ...metadata, subject }).status).toBe('unmatched');
  const punctuated = { ...definition, rules: [{ ...rule, criteria: { ...criteria, reference: '[a+b?]' } }] };
  expect(classifyMailProject(punctuated, { ...metadata, subject: '[a+b?] review' }).status).toBe('suggested');
  expect(classifyMailProject(punctuated, { ...metadata, subject: 'aaab review' }).status).toBe('unmatched');
});

test('sender matching parses exactly one actual address and never treats display names as addresses', () => {
  const configured = mailClassifierDefinitionSchema.parse({ ...definition, rules: [{ ...rule, criteria: { ...criteria, reference: '', sender: 'Client@Example.Test' } }] });
  expect(classifyMailProject(configured, metadata).status).toBe('suggested');
  for (const from of ['"client@example.test" <other@example.test>', 'client@example.test, other@example.test', 'client@example.test.attacker.invalid', null]) expect(classifyMailProject(configured, { ...metadata, from }).status).not.toBe('suggested');
  const byDomain = { ...configured, rules: [{ ...rule, criteria: { ...criteria, reference: '', domain: 'example.test' } }] };
  expect(classifyMailProject(byDomain, metadata).status).toBe('suggested');
  for (const from of ['client@sub.example.test', 'client@example.test.attacker.invalid', 'client@examp1e.test']) expect(classifyMailProject(byDomain, { ...metadata, from }).status).toBe('unmatched');
});

test('ambiguous or malformed senders abstain even when a subject reference matches or a sender exclusion could be bypassed',()=>{
  for(const from of [null,'client@example.test, other@example.test','invalid-address']){
    expect(classifyMailProject({...definition,exclusions:{senders:['client@example.test'],domains:[],subjects:[]}}, {...metadata,from}).status).toBe('unavailable');
  }
  const multilingual={...definition,rules:[{...rule,criteria:{...criteria,reference:'争议2026-123',subject:'Überprüfung'}}]};
  expect(classifyMailProject(multilingual,{...metadata,subject:'[争议2026-123] ÜBERPRÜFUNG'}).status).toBe('suggested');
});

test('all configured conditions are required, exclusions win, and disabled rules cannot contribute', () => {
  const configured = { ...definition, rules: [{ ...rule, criteria: { ...criteria, sender: 'client@example.test', subject: 'contract' } }] };
  expect(classifyMailProject(configured, metadata).candidates[0].rules[0].reasons).toEqual(['sender', 'reference', 'subject']);
  for (const value of [{ ...metadata, from: 'other@example.test' }, { ...metadata, subject: 'MAT-123 other' }, { ...metadata, subject: 'contract' }]) expect(classifyMailProject(configured, value).status).toBe('unmatched');
  for (const exclusions of [{ senders: ['client@example.test'], domains: [], subjects: [] }, { senders: [], domains: ['example.test'], subjects: [] }, { senders: [], domains: [], subjects: ['CONTRACT'] }]) expect(classifyMailProject({ ...definition, exclusions }, metadata).status).toBe('excluded');
  expect(classifyMailProject({ ...definition, rules: [{ ...rule, enabled: false }] }, metadata).status).toBe('unmatched');
});

test('overlapping projects remain ambiguous regardless of rule ordering and repeated evidence does not duplicate a destination', () => {
  const second = { ...rule, id: '22222222-2222-4222-8222-222222222222', name: 'Second', order: 2 };
  const same = classifyMailProject({ ...definition, rules: [second, rule] }, metadata);
  expect(same.status).toBe('suggested'); expect(same.candidates).toHaveLength(1); expect(same.candidates[0].rules.map(item => item.name)).toEqual(['Matter reference', 'Second']);
  const conflict = classifyMailProject({ ...definition, rules: [rule, { ...second, project: other }] }, metadata);
  expect(conflict.status).toBe('ambiguous'); expect(conflict.candidates.map(item => item.project)).toEqual([project, other]);
});

test('oversized and injected configuration is rejected and unusually large metadata cannot run an unbounded scan', () => {
  for (const domain of ['*.example.test', 'https://example.test', 'example.test:443', 'example.test/other', 'user@example.test']) expect(mailClassifierDefinitionSchema.safeParse({ ...definition, rules: [{ ...rule, criteria: { ...criteria, domain } }] }).success).toBe(false);
  expect(classifyMailProject(definition, { ...metadata, subject: 'MAT-123' + 'x'.repeat(65536) }).status).toBe('unavailable');
  const large = { ...definition, rules: Array.from({ length: 20 }, (_, index) => ({ ...rule, id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, project: { ...project, id: '\u0000'.repeat(4096) } })) };
  expect(mailClassifierDefinitionSchema.safeParse(large).success).toBe(false);
});

test('private classifier results bind the exact account, provider locator, revision and saved settings', () => {
  const locator = { provider: 'gmail', messageId: 'one' }, version = { generation: '11111111-1111-4111-8111-111111111111', revision: 1 };
  const command = mailClassifierCommandSchema.parse({ operation: 'mail.classifier.preview', accountId: 'a', input: { locator } });
  expect(parseParentMessage(JSON.stringify({ kind: 'request', id: '1:1', command }))).toBeDefined();
  const result = { classification: { accountId: 'a', locator, version, ...classifyMailProject(definition, metadata) } };
  expect(parseWorkerMessage(JSON.stringify({ kind: 'response', id: '1:1', ok: true, result }))).toBeDefined();
  expect(mailClassifierResultMatches(command, result)).toBe(true);
  expect(mailClassifierResultMatches(command, { classification: { ...result.classification, accountId: 'other' } })).toBe(false);
  expect(mailClassifierResultMatches(command, { classification: { ...result.classification, locator: { provider: 'graph', messageId: 'one' } } })).toBe(false);
  expect(mailClassifierResultMatches(command, { classification: { ...result.classification, accessToken: 'secret' } })).toBe(false);
  const save = mailClassifierCommandSchema.parse({ operation: 'mail.classifier.save', accountId: 'a', input: { expected: null, definition } });
  const saved = { classifier: { accountId: 'a', version, definition } };
  expect(mailClassifierResultMatches(save, saved)).toBe(true);
  expect(mailClassifierResultMatches(save, { classifier: { ...saved.classifier, version: { ...version, revision: 2 } } })).toBe(false);
  expect(mailClassifierResultMatches(save, { classifier: { ...saved.classifier, definition: { ...definition, mode: 'off' } } })).toBe(false);
});
