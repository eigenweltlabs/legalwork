import { expect, test } from 'bun:test';
import { MailProjectClassifierCoordinator } from './project-classifier-coordinator.js';
import { mailClassifierPlanSchema } from './classifier-incoming-view.js';
import type { MailProjectDestination, MailProjectReference } from './project-association-view.js';

const destination = { id: 'project', binding: 'a'.repeat(64), name: 'Synthetic project' };
const plan = mailClassifierPlanSchema.parse({ id: 1, version: { generation: '11111111-1111-4111-8111-111111111111', revision: 1 }, accountId: 'a', locator: { provider: 'gmail', messageId: 'one' }, configVersion: { generation: '22222222-2222-4222-8222-222222222222', revision: 1 }, fingerprint: 'b'.repeat(64), project: { id: destination.id, binding: destination.binding }, threshold: 'reference_sender', rules: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Synthetic rule', reasons: ['reference', 'sender'] }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw Error('Coordinator did not settle'); await Bun.sleep(5); } }

test('the parent resolves exact current project identity and passes only a private reference to commit', async () => {
  for (const resolved of [destination, { ...destination, binding: 'c'.repeat(64) }, null]) {
    let offered = false; const commits: (MailProjectReference | null)[] = [];
    const coordinator = new MailProjectClassifierCoordinator({ canRun: () => true, idleMs: 1000, pending: async () => { if (offered) return { items: [] }; offered = true; return { items: [plan] }; }, resolve: async () => { if (!resolved) throw Error('revoked'); return resolved; }, commit: async (_, project) => { commits.push(project); } });
    try { coordinator.start(); await until(() => commits.length === 1); expect(commits[0]).toEqual(resolved === destination ? plan.project : null); } finally { coordinator.stop(); }
  }
});

test('stop, host read-only and restart fence in-flight destination lookups', async () => {
  for (const action of ['stop', 'read-only', 'restart']) {
    const lookup = deferred<MailProjectDestination>(); let resolving = false, writable = true, offered = false, commits = 0;
    const coordinator = new MailProjectClassifierCoordinator({ canRun: () => writable, idleMs: 1000, pending: async () => { if (offered) return { items: [] }; offered = true; return { items: [plan] }; }, resolve: async () => { resolving = true; return lookup.promise; }, commit: async () => { commits++; } });
    try {
      coordinator.start(); await until(() => resolving);
      if (action === 'read-only') writable = false; else { coordinator.stop(); if (action === 'restart') coordinator.start(); }
      lookup.resolve(destination); await Bun.sleep(30); expect(commits).toBe(0);
    } finally { coordinator.stop(); }
  }
});

test('a timed-out lookup becomes review once and its late result cannot assign a project', async () => {
  const lookup = deferred<MailProjectDestination>(); let offered = false; const commits: (MailProjectReference | null)[] = [];
  const coordinator = new MailProjectClassifierCoordinator({ canRun: () => true, resolveTimeoutMs: 15, pending: async () => { if (offered) return { items: [] }; offered = true; return { items: [plan] }; }, resolve: () => lookup.promise, commit: async (_, project) => { commits.push(project); } });
  try { coordinator.start(); await until(() => commits.length === 1); expect(commits).toEqual([null]); lookup.resolve(destination); await Bun.sleep(30); expect(commits).toEqual([null]); } finally { coordinator.stop(); }
});

test('a failed worker turn backs off instead of spinning and wake remains explicit', async () => {
  let calls = 0;
  const coordinator = new MailProjectClassifierCoordinator({ canRun: () => true, idleMs: 1000, pending: async () => { calls++; throw Error('synthetic worker failure'); }, resolve: async () => destination, commit: async () => {} });
  try { coordinator.start(); await until(() => calls === 1); await Bun.sleep(30); expect(calls).toBe(1); coordinator.wake(); await until(() => calls === 2); } finally { coordinator.stop(); }
});

test('suspended or locked custody does not request work or unlock storage', async () => {
  let calls = 0;
  const coordinator = new MailProjectClassifierCoordinator({ canRun: () => false, pending: async () => { calls++; return { items: [] }; }, resolve: async () => destination, commit: async () => { calls++; } });
  try { coordinator.start(); await Bun.sleep(30); expect(calls).toBe(0); } finally { coordinator.stop(); }
});
