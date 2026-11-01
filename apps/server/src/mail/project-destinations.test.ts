import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rename, rm, symlink, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailProjectDestinations } from './project-destinations.js';
import { projectSyncStore, type ProjectLink } from '../project-sync-store.js';
import { writeEigenweltConnection } from '../eigenwelt-connection-store.js';
import type { ServerConfig } from '../types.js';

async function fixture(run: (config: ServerConfig, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mail-project-destinations-')), previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(dir, 'runtime.sqlite');
  const config: ServerConfig = { host: '127.0.0.1', port: 0, token: 'fixture', hostToken: 'host', workspaces: [], authorizedRoots: [join(dir, 'allowed')], readOnly: false, approval: { mode: 'auto', timeoutMs: 1000 }, corsOrigins: [], startedAt: 0, tokenSource: 'cli', hostTokenSource: 'cli', logFormat: 'pretty', logRequests: false, configPath: join(dir, 'server.json') };
  try {
    const path = join(dir, 'allowed', 'project'); await mkdir(path, { recursive: true });
    config.workspaces.push({ id: 'local', name: 'Synthetic project', path, preset: 'starter', workspaceType: 'local' });
    await run(config, dir);
  } finally {
    if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('project catalog excludes the main assistant, preserves rename identity and never bootstraps project files', () => fixture(async config => {
  const workspace = config.workspaces[0]; config.workspaces.push({ ...workspace, id: 'assistant', preset: 'main-assistant' });
  const catalog = mailProjectDestinations(config), original = await catalog.resolve(workspace.id);
  expect(catalog.projects()).toEqual(['local']); await expect(catalog.resolve('assistant')).rejects.toBeDefined();
  workspace.displayName = 'Renamed'; expect(await catalog.resolve(workspace.id)).toEqual({ ...original, name: 'Renamed' });
  await expect(access(join(workspace.path, '.legalwork'))).rejects.toBeDefined();
}));

test('canonical roots reject symlink escapes and bindings reject directory replacement or workspace reuse', () => fixture(async (config, dir) => {
  const workspace = config.workspaces[0], catalog = mailProjectDestinations(config), original = await catalog.resolve(workspace.id);
  const outside = join(dir, 'outside'); await mkdir(outside);
  const escape = join(dir, 'allowed', 'escape'); await symlink(outside, escape, 'dir');
  const oldPath = workspace.path; workspace.path = escape; await expect(catalog.resolve(workspace.id)).rejects.toBeDefined();
  workspace.path = oldPath; await rename(oldPath, oldPath + '-old'); await mkdir(oldPath);
  expect((await catalog.resolve(workspace.id)).binding).not.toBe(original.binding);
  workspace.path = oldPath + '-old'; expect((await catalog.resolve(workspace.id)).binding).not.toBe(original.binding);
}));

test('shared project destinations bind the signed-in account and organization and hide revoked or inconsistent links', () => fixture(async config => {
  const workspace = config.workspaces[0], catalog = mailProjectDestinations(config), store = await projectSyncStore(config);
  const link: ProjectLink = { workspaceId: workspace.id, projectId: '11111111-1111-4111-8111-111111111111', orgId: 'firm', origin: 'remote', role: 'member', ownerUserId: null, settings: { access: 'members', memberIds: ['one'], scope: { documents: true, notes: true, tasks: true, recordings: false, metadata: true, reviews: true } }, confirmed: true, remoteUpdatedAt: null, filesReconciledAt: null, state: 'active', allowDeletions: false, lastSyncAt: null, lastError: null, report: null };
  store.saveLink(link);
  const connect = (userId: string, orgId = 'firm') => writeEigenweltConnection(config, { platformToken: 'synthetic', account: { userId, orgId, userName: userId, userEmail: userId + '@example.test', orgName: orgId } });
  await expect(catalog.resolve(workspace.id)).rejects.toBeDefined(); await connect('one');
  const original = await catalog.resolve(workspace.id); await connect('two'); await expect(catalog.resolve(workspace.id)).rejects.toBeDefined();
  store.updateLink(workspace.id, { settings: { ...link.settings, memberIds: ['one', 'two'] } });
  expect((await catalog.resolve(workspace.id)).binding).not.toBe(original.binding);
  await connect('one', 'other-firm'); await expect(catalog.resolve(workspace.id)).rejects.toBeDefined();
  await connect('one'); store.updateLink(workspace.id, { state: 'revoked' }); await expect(catalog.resolve(workspace.id)).rejects.toBeDefined();
  store.updateLink(workspace.id, { state: 'active' });
  await mkdir(join(workspace.path, '.legalwork'));
  await writeFile(join(workspace.path, '.legalwork', 'project.json'), JSON.stringify({ version: 1, revision: 1, fields: [], syncProjectId: '22222222-2222-4222-8222-222222222222' }));
  await expect(catalog.resolve(workspace.id)).rejects.toBeDefined();
}));
