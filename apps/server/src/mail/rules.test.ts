import { test, expect } from 'bun:test';
import { mailRuleDefinitionSchema, mailRulesSchema } from './rules-view.js';
import { mailRuleMatches } from './storage/rules.js';
import { parseParentMessage, parseWorkerMessage, resultMatchesCommand } from './runtime/protocol.js';
import { LocalMailService } from './service.js';
import { registerMailRoutes } from '../routes/mail.js';
import { matchRoute, type Route, type RequestContext } from '../routes/registry.js';
import { ApprovalService } from '../approvals.js';
import { ReloadEventStore } from '../events.js';
import { TokenService } from '../tokens.js';
import type { ServerConfig } from '../types.js';

const id = '11111111-1111-4111-8111-111111111111';
const definition = mailRuleDefinitionSchema.parse({ name: 'Invoices', enabled: true, order: 1, sender: 'billing@example.com', subject: 'invoice', action: { kind: 'read' } });
const command = { operation: 'mail.rules.save', accountId: 'a', input: { id, expected: null, definition } } satisfies import('./rules-view.js').MailRulesCommand;
const result = { rules: mailRulesSchema.parse({ accountId: 'a', items: [{ id, version: { generation: id, revision: 1 }, definition, status: 'ready' }], activity: [] }) };
const parent = (value: unknown) => parseParentMessage(JSON.stringify({ kind: 'request', id: '1:1', command: value }));

test('rule conditions use parsed single sender addresses and literal case-insensitive subjects', () => {
  expect(mailRuleMatches(definition, { from: 'Billing <BILLING@example.com>', subject: 'INVOICE #1' })).toBe(true);
  for (const from of ['"billing@example.com" <evil@example.com>', 'billing@example.com, other@example.com', 'Team: billing@example.com;', null]) expect(mailRuleMatches(definition, { from, subject: 'invoice' })).toBe(false);
  expect(mailRuleMatches(definition, { from: 'billing@example.com', subject: 'Other' })).toBe(false);
  expect(mailRuleMatches({ ...definition, sender: '', subject: '.*' }, { from: null, subject: 'Invoice' })).toBe(false);
});
test('rules reject scripts, send, cross-matter actions, unconstrained matching and invalid snooze zones', () => {
  expect(parent(command)).toBeDefined();
  for (const action of [{ kind: 'send' }, { kind: 'script', code: 'process.exit()' }, { kind: 'file', matterId: 'other' }, { kind: 'snooze', minutes: 60, timeZone: 'Mars/Olympus' }]) expect(parent({ ...command, input: { ...command.input, definition: { ...definition, action } } })).toBeUndefined();
  for (const extra of [{ ownerId: 'other' }, { accessToken: 'secret' }, { matterId: 'other' }]) expect(parent({ ...command, input: { ...command.input, ...extra } })).toBeUndefined();
  expect(mailRuleDefinitionSchema.safeParse({ ...definition, sender: '', subject: '' }).success).toBe(false);
  expect(parent({ ...command, input: { id, definition } })).toBeUndefined();
});
test('rules IPC binds responses to account, saved definition, revision and deletion', () => {
  expect(parseWorkerMessage(JSON.stringify({ kind: 'response', id: '1:1', ok: true, result }))).toBeDefined();
  expect(resultMatchesCommand(command, result)).toBe(true);
  expect(resultMatchesCommand({ ...command, accountId: 'b' }, result)).toBe(false);
  expect(resultMatchesCommand({ ...command, input: { ...command.input, definition: { ...definition, enabled: false } } }, result)).toBe(false);
  expect(resultMatchesCommand({ operation: 'mail.rules.delete', accountId: 'a', input: { id, expected: { generation: id, revision: 1 } } }, result)).toBe(false);
  expect(parseWorkerMessage(JSON.stringify({ kind: 'response', id: '1:1', ok: true, result: { rules: { ...result.rules, password: 'secret' } } }))).toBeUndefined();
});

test('rules routes require the local host actor and exact account-scoped inputs', async () => {
  const service = new LocalMailService({ ownerId: 'fixture', databasePath: '/unused', loadKey: async () => { throw Error('No worker'); }, executable: { kind: 'node', path: process.execPath }, entryPoint: '/unused' });
  const config: ServerConfig = { host: '127.0.0.1', port: 0, token: 'fixture', hostToken: 'host', approval: { mode: 'auto', timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: 'cli', hostTokenSource: 'cli', logFormat: 'pretty', logRequests: false };
  const routes: Route[] = []; let writes = 0;
  service.saveRule = async (accountId, input) => { writes++; expect(accountId).toBe('a'); expect(input).toEqual(command.input); return result.rules; };
  registerMailRoutes(routes, '127.0.0.1', service);
  async function post(body: unknown, host = true) {
    const path = '/mail/v1/accounts/a/rules/save', route = matchRoute(routes, 'POST', path); if (!route) throw Error('Missing route');
    const context: RequestContext = { config, approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config), request: new Request('http://127.0.0.1' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url: new URL('http://127.0.0.1' + path), params: route.params, ...(host ? { actor: { type: 'host' } } : {}) };
    return route.handler(context);
  }
  expect((await post(command.input)).status).toBe(200);
  for (const extra of [{ ownerId: 'other' }, { accountId: 'b' }, { runOnExistingMail: true }, { accessToken: 'secret' }]) await expect(post({ ...command.input, ...extra })).rejects.toMatchObject({ status: 400 });
  await expect(post(command.input, false)).rejects.toMatchObject({ status: 401 }); expect(writes).toBe(1);
  const remote: Route[] = []; registerMailRoutes(remote, '0.0.0.0', service); expect(remote).toEqual([]);
});
