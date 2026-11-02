// Native fixture databases can remain process-owned after the engine exits.
// The parent removes private roots only after the complete test child exits.
import assert from 'node:assert/strict';
import timing from './timing.cjs';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function withNativeFixtureOwner(run) {
  const scratch = path.join(root, '.legalwork/scratch');
  mkdirSync(scratch, { recursive: true });
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'legalwork-native-package-')));
  const repository = realpathSync(mkdtempSync(path.join(scratch, 'native-package-')));
  try {
    return run({ LEGALWORK_TEST_NATIVE_FIXTURE_PARENT: temporary, LEGALWORK_TEST_NATIVE_REPO_FIXTURE_PARENT: repository });
  } finally {
    // No retry or ignored cleanup error: a surviving process/handle still fails.
    rmSync(temporary, { recursive: true });
    rmSync(repository, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const firstFile = args.findIndex(value => /\.test\.[cm]?[jt]sx?$/.test(value));
  assert.ok(firstFile >= 0, 'Pass Bun options followed by explicit native test files');
  const options = args.slice(0, firstFile), files = args.slice(firstFile);
  assert.ok(files.every(value => /\.test\.[cm]?[jt]sx?$/.test(value)), 'Put test options before the native file list');
  const preparation = spawnSync(process.execPath, [path.join(root, 'scripts/gen-core-skills.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
  if (preparation.status !== 0) process.exitCode = preparation.status ?? 1;
  else {
    let status = 0;
    // Keep each file's SQLite driver, native handles and environment in its
    // own OS process. A failing file still cannot contaminate the next file.
    for (const file of files) {
      const started = performance.now();
      const code = withNativeFixtureOwner(environment => {
        const result = spawnSync(process.env.LEGALWORK_TEST_BUN_BIN || 'bun', ['test', '--isolate', ...options, file], {
          cwd: root, env: { ...process.env, ...environment, LEGALWORK_TEST_PREPARED: '1' },
          stdio: 'inherit', windowsHide: true, timeout: 300_000,
        });
        if (result.error) throw result.error;
        return result.status ?? 1;
      });
      timing.recordSpan('native-fixture-file', started, { file, status: code });
      if (code !== 0) status = code;
    }
    process.exitCode = status;
  }
}
