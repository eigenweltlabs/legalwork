import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function dependencyStore({ filter = '', ignoreScripts = 'false', defaultStore, temporary, os, arch, nodeAbi = process.versions.modules }) {
  assert.ok(['true', 'false'].includes(ignoreScripts), 'Invalid dependency lifecycle mode');
  assert.ok(['Linux', 'macOS', 'Windows'].includes(os), 'Unknown dependency cache OS');
  assert.ok(['X64', 'ARM64'].includes(arch), 'Unknown dependency cache architecture');
  if (!filter) {
    assert.ok(defaultStore, 'Resolve the default pnpm store for a full install');
    const prefix = `pnpm-v1-${os}-${arch}-`;
    return { path: defaultStore.trim(), prefix, restoreKeys: `${prefix}\n${os}-${arch}-electron-pnpm-` };
  }
  assert.ok(temporary, 'Filtered stores require a job-owned temporary directory');
  const scope = createHash('sha256').update(JSON.stringify({ filter, ignoreScripts })).digest('hex').slice(0, 20);
  const prefix = `pnpm-filtered-v1-${os}-${arch}-node${nodeAbi}-${scope}-`;
  return { path: (os === 'Windows' ? path.win32 : path.posix).join(temporary, `pnpm-filtered-${scope}`), prefix, restoreKeys: prefix };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = dependencyStore({ filter: process.env.WORKSPACE_FILTER, ignoreScripts: process.env.IGNORE_SCRIPTS,
    defaultStore: process.env.PNPM_DEFAULT_STORE, temporary: process.env.RUNNER_TEMP, os: process.env.RUNNER_OS, arch: process.env.RUNNER_ARCH });
  appendFileSync(process.env.GITHUB_OUTPUT, `path=${store.path}\nprefix=${store.prefix}\nrestore-keys<<DEPENDENCY_STORE_KEYS\n${store.restoreKeys}\nDEPENDENCY_STORE_KEYS\n`);
  console.log(`Dependency store: ${store.path}; cache namespace: ${store.prefix}`);
}
