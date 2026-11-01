import { expect, test } from 'bun:test';
import { ApiError } from '../errors.js';
import { ApprovalService } from '../approvals.js';
import { ReloadEventStore } from '../events.js';
import { TokenService } from '../tokens.js';
import type { ServerConfig } from '../types.js';
import { registerMailClassifierRoutes } from '../routes/mail-classifier.js';
import { matchRoute, type Route, type RequestContext } from '../routes/registry.js';
import { LocalMailService } from './service.js';
import { type MailClassifierCommand, type MailClassifierResult, mailClassifierDefinitionSchema } from './classifier-view.js';
import type { MailProjectDestination } from './project-association-view.js';

const locator = { provider: 'gmail', messageId: 'one' } satisfies import('./model.js').ProviderMessageLocator;
const version = { generation: '11111111-1111-4111-8111-111111111111', revision: 1 };
const project = { id: 'private-project-id', binding: 'a'.repeat(64), name: 'Synthetic project name' }, reference = { id: project.id, binding: project.binding };
const definition = mailClassifierDefinitionSchema.parse({ mode: 'suggestions', rules: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Reference rule', enabled: true, order: 1, project: reference, criteria: { sender: '', domain: '', reference: 'MAT-123', subject: '' } }], exclusions: { senders: [], domains: [], subjects: [] } });
const preview = { accountId: 'a', locator, version, status: 'suggested', candidates: [{ project: reference, rules: [{ id: definition.rules[0].id, name: 'Reference rule', reasons: ['reference'] }] }] } satisfies import('./classifier-view.js').MailClassifierPreview;
type Success = Exclude<MailClassifierResult, { classifierFailure: unknown }>;
function fixture() {
  const config: ServerConfig = { host: '127.0.0.1', port: 0, token: 'fixture', hostToken: 'host', workspaces: [], authorizedRoots: [], readOnly: false, approval: { mode: 'auto', timeoutMs: 1000 }, corsOrigins: [], startedAt: 0, tokenSource: 'cli', hostTokenSource: 'cli', logFormat: 'pretty', logRequests: false };
  const mail = new LocalMailService({ ownerId: 'synthetic', databasePath: '/unused', loadKey: async () => { throw Error('No worker'); }, executable: { kind: 'node', path: process.execPath }, entryPoint: '/unused' });
  let ready = true, calls = 0;
  let resolve: (id: string) => Promise<MailProjectDestination> = async id => { if (id !== project.id) throw Error('private-path'); return project; };
  let respond: (command: MailClassifierCommand) => Promise<Success> = async command => command.operation === 'mail.classifier.preview' ? { classification: preview } : { classifier: { accountId: 'a', version: command.operation === 'mail.classifier.save' ? { ...version, revision: 2 } : version, definition } };
  mail.status = () => ({ protocolVersion: 1, state: ready ? 'ready' : 'locked', syncSupported: false });
  mail.classifier = command => { calls++; return respond(command); };
  const routes: Route[] = [], options = { routes, host: config.host, mail, ensureWritable: () => { if (config.readOnly) throw new ApiError(403, 'read_only', 'Read only'); }, resolve: (id: string) => resolve(id) };
  registerMailClassifierRoutes(options);
  async function post(body: unknown, host = true) {
    const path = '/mail/v1/classifier', route = matchRoute(routes, 'POST', path); if (!route) throw Error('Missing route');
    const request = new Request('http://127.0.0.1' + path, { method: 'POST', body: JSON.stringify(body) });
    const ctx: RequestContext = { config, approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config), request, url: new URL(request.url), params: route.params, ...(host ? { actor: { type: 'host' } } : {}) };
    return route.handler(ctx);
  }
  return { config, options, post, calls: () => calls, ready: (value: boolean) => { ready = value; }, resolver: (value: typeof resolve) => { resolve = value; }, responder: (value: typeof respond) => { respond = value; } };
}
const read = { operation: 'mail.classifier.read', accountId: 'a' }, check = { operation: 'mail.classifier.preview', accountId: 'a', input: { locator } };

test('classifier routes require unlocked loopback host authority and reject added owner or model fields', async () => {
  const f = fixture(); expect(f.options.routes[0].auth).toBe('host-token');
  await expect(f.post(read, false)).rejects.toMatchObject({ status: 401 });
  for (const body of [{ ...read, ownerId: 'other' }, { ...check, input: { locator, model: 'remote' } }]) await expect(f.post(body)).rejects.toMatchObject({ status: 400 });
  f.ready(false); await expect(f.post(read)).rejects.toMatchObject({ status: 423 }); expect(f.calls()).toBe(0);
  const remote: Route[] = []; registerMailClassifierRoutes({ ...f.options, routes: remote, host: '0.0.0.0' }); expect(remote).toEqual([]);
});
test('classifier saves require writable mode and exact current destination identity', async () => {
  const f = fixture(), save = { operation: 'mail.classifier.save', accountId: 'a', input: { expected: version, definition } };
  f.config.readOnly = true; await expect(f.post(save)).rejects.toMatchObject({ status: 403 }); f.config.readOnly = false;
  f.resolver(async () => ({ ...project, binding: 'b'.repeat(64) })); await expect(f.post(save)).rejects.toMatchObject({ status: 409 }); expect(f.calls()).toBe(0);
  f.resolver(async () => project); const response = await f.post(save); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toMatchObject({ definition: { rules: [{ project }] } });
});
test('inaccessible destinations are redacted and losing a conflicting destination never turns ambiguity into an automatic choice', async () => {
  const f = fixture(); f.resolver(async () => { throw Error('/private/project'); });
  const config = await (await f.post(read)).json(); expect(config.definition.rules[0]).toMatchObject({ project: null, unavailable: true }); expect(JSON.stringify(config)).not.toContain(project.id); expect(JSON.stringify(config)).not.toContain(project.name);
  const unavailable = await (await f.post(check)).json(); expect(unavailable).toMatchObject({ status: 'unavailable', candidates: [], unavailable: 1 });
  const other = { id: 'inaccessible-id', binding: 'b'.repeat(64) };
  f.responder(async () => ({ classification: { ...preview, status: 'ambiguous', candidates: [...preview.candidates, { ...preview.candidates[0], project: other }] } })); f.resolver(async id => { if (id !== project.id) throw Error('private'); return project; });
  const value = await (await f.post(check)).json(); expect(value.status).toBe('ambiguous'); expect(value.candidates).toHaveLength(1); expect(value.unavailable).toBe(1); expect(JSON.stringify(value)).not.toContain(other.id);
});
test('preview rechecks reject late configuration changes, wrong accounts and locks during project resolution', async () => {
  const f = fixture(); f.responder(async () => ({ classification: { ...preview, accountId: 'other' } })); await expect(f.post(check)).rejects.toMatchObject({ status: 503 });
  let count = 0; f.responder(async () => ({ classification: ++count === 1 ? preview : { ...preview, status: 'off', candidates: [] } })); await expect(f.post(check)).rejects.toMatchObject({ status: 409 });
  f.responder(async () => ({ classification: preview })); f.resolver(async () => { f.ready(false); return project; }); await expect(f.post(check)).rejects.toMatchObject({ status: 423 });
});
