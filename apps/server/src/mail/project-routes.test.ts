import { expect, test } from 'bun:test';
import { ApprovalService } from '../approvals.js';
import { ReloadEventStore } from '../events.js';
import { TokenService } from '../tokens.js';
import { ApiError } from '../errors.js';
import type { ServerConfig } from '../types.js';
import { registerMailProjectRoutes } from '../routes/mail-projects.js';
import { matchRoute, type Route, type RequestContext } from '../routes/registry.js';
import { LocalMailService } from './service.js';
import { MailProjectError, type MailProjectDestination } from './project-association-view.js';

const locator = { provider: 'gmail', messageId: 'one' } satisfies import('./model.js').ProviderMessageLocator;
const version = { generation: '11111111-1111-4111-8111-111111111111', revision: 1 };
const project = { id: 'project', name: 'Synthetic project', binding: 'a'.repeat(64) };
const reference = { id: project.id, binding: project.binding };
const record = { accountId: 'a', locator, version, project: reference, updatedAt: 1000 };
function fixture() {
  const config: ServerConfig = { host: '127.0.0.1', port: 0, token: 'fixture', hostToken: 'host', workspaces: [], authorizedRoots: [], readOnly: false, approval: { mode: 'auto', timeoutMs: 1000 }, corsOrigins: [], startedAt: 0, tokenSource: 'cli', hostTokenSource: 'cli', logFormat: 'pretty', logRequests: false };
  const mail = new LocalMailService({ ownerId: 'synthetic', databasePath: '/unused', loadKey: async () => { throw Error('No worker'); }, executable: { kind: 'node', path: process.execPath }, entryPoint: '/unused' });
  let ready = true, writes = 0, resolve: (id: string) => Promise<MailProjectDestination> = async id => { if (id !== project.id) throw new MailProjectError('unavailable'); return project; };
  mail.status = () => ({ protocolVersion: 1, state: ready ? 'ready' : 'locked', syncSupported: false });
  mail.projectAssociation = async command => {
    if (command.operation === 'mail.project.history') return { projectHistory: { accountId: command.accountId, locator: command.input.locator, items: [{ version, project: reference, at: 1000, source: 'manual' }], nextRevision: null } };
    if (command.operation === 'mail.project.set') { writes++; return { projectAssociation: { ...record, project: command.input.project, version: { ...version, revision: 2 } } }; }
    return { projectAssociation: record };
  };
  const routes: Route[] = [];
  const options = { routes, host: config.host, mail, ensureWritable: () => { if (config.readOnly) throw new ApiError(403, 'read_only', 'Read only'); }, projects: () => [project.id], resolve: (id: string) => resolve(id) };
  registerMailProjectRoutes(options);
  async function post(body: unknown, host = true, routeList = routes) {
    const path = '/mail/v1/projects', route = matchRoute(routeList, 'POST', path);
    if (!route) throw Error('Missing route');
    const request = new Request('http://127.0.0.1' + path, { method: 'POST', body: JSON.stringify(body) });
    const ctx: RequestContext = { config, approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config), request, url: new URL(request.url), params: route.params, ...(host ? { actor: { type: 'host' } } : {}) };
    return route.handler(ctx);
  }
  return { config, mail, routes, options, post, writes: () => writes, ready: (value: boolean) => { ready = value; }, resolver: (value: typeof resolve) => { resolve = value; } };
}

test('project metadata requires local host authority, unlocked mail and exact inputs without auto-unlock', async () => {
  const f = fixture(), read = { action: 'read', accountId: 'a', input: { locator } };
  expect(f.routes[0].auth).toBe('host-token');
  await expect(f.post(read, false)).rejects.toMatchObject({ status: 401 });
  for (const body of [{ ...read, ownerId: 'other' }, { ...read, input: { locator, files: true } }, { action: 'set', accountId: 'a', input: { locator, project: reference } }]) await expect(f.post(body)).rejects.toMatchObject({ status: 400 });
  f.ready(false); await expect(f.post(read)).rejects.toMatchObject({ status: 423 });
  const remote: Route[] = []; registerMailProjectRoutes({ ...f.options, routes: remote, host: '0.0.0.0' }); expect(remote).toEqual([]);
  expect(f.writes()).toBe(0);
});

test('project edits require writable mode and the current destination binding', async () => {
  const f = fixture(), input = { action: 'set', accountId: 'a', input: { locator, expected: version, project: reference } };
  f.config.readOnly = true; await expect(f.post(input)).rejects.toMatchObject({ status: 403 });
  f.config.readOnly = false;
  f.resolver(async () => ({ ...project, binding: 'b'.repeat(64) })); await expect(f.post(input)).rejects.toMatchObject({ status: 409 });
  expect(f.writes()).toBe(0);
  f.resolver(async () => project);
  const response = await f.post(input); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toMatchObject({ project });
  expect(f.writes()).toBe(1);
});

test('inaccessible or replaced projects disappear from current assignment and history without exposing their identity', async () => {
  const f = fixture();
  for (const resolve of [async () => { throw Error('/private/project/path'); }, async () => ({ ...project, binding: 'b'.repeat(64) })]) {
    f.resolver(resolve);
    for (const action of ['read', 'history']) {
      const response = await f.post({ action, accountId: 'a', input: { locator } }), value = await response.json();
      expect(action === 'read' ? value : value.items[0]).toMatchObject({ project: null, unavailable: true });
      expect(JSON.stringify(value)).not.toContain(project.name); expect(JSON.stringify(value)).not.toContain(reference.binding); expect(JSON.stringify(value)).not.toContain('path');
    }
  }
  const response = await f.post({ action: 'set', accountId: 'a', input: { locator, expected: version, project: null } });
  expect(await response.json()).toMatchObject({ project: null, unavailable: false });
});

test('host reads reject cross-message service responses and recheck lock after asynchronous destination resolution', async () => {
  const f = fixture(); f.mail.projectAssociation = async () => ({ projectAssociation: { ...record, accountId: 'other' } });
  const routes: Route[] = []; registerMailProjectRoutes({ ...f.options, routes });
  await expect(f.post({ action: 'read', accountId: 'a', input: { locator } }, true, routes)).rejects.toMatchObject({ status: 409 });
  const original = fixture(); original.resolver(async () => { original.ready(false); return project; });
  await expect(original.post({ action: 'read', accountId: 'a', input: { locator } })).rejects.toMatchObject({ status: 423 });
});

test('catalog pagination advances past inaccessible projects without leaking them', async () => {
  const f = fixture(), ids = Array.from({ length: 23 }, (_, i) => String(i).padStart(2, '0'));
  f.options.projects = () => ids;
  const routes: Route[] = [];
  registerMailProjectRoutes({ ...f.options, routes, resolve: async id => { if (id !== '22') throw Error('unavailable'); return { ...project, id }; } });
  expect(await (await f.post({ action: 'catalog' }, true, routes)).json()).toEqual({ items: [], nextCursor: '19' });
  expect(await (await f.post({ action: 'catalog', after: '19' }, true, routes)).json()).toEqual({ items: [{ ...project, id: '22' }], nextCursor: null });
});
