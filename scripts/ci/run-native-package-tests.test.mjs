import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { withNativeFixtureOwner } from './run-native-package-tests.mjs';

test('the parent owns both fixture roots through child exit and retains a failing child status', () => {
  let roots;
  const status = withNativeFixtureOwner(environment => {
    roots = Object.values(environment);
    assert.ok(roots.every(existsSync));
    const result = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path');
      for (const name of ['LEGALWORK_TEST_NATIVE_FIXTURE_PARENT', 'LEGALWORK_TEST_NATIVE_REPO_FIXTURE_PARENT']) {
        fs.openSync(path.join(process.env[name], 'process-owned.db'), 'w');
      }
      process.exitCode = 3;
    `], { env: { ...process.env, ...environment } });
    return result.status;
  });
  assert.equal(status, 3);
  assert.ok(roots.every(root => !existsSync(root)));
});


test('Bun canonical fixture paths stay inside Node-owned temporary and repository roots', () => {
  const module = new URL('../../apps/server/src/native-fixture-directory.test-support.ts', import.meta.url).href;
  const status = withNativeFixtureOwner(environment => {
    const result = spawnSync(process.env.LEGALWORK_TEST_BUN_BIN || 'bun', ['--eval', `
      import { nativeFixtureDirectory, removeNativeFixtureDirectory } from ${JSON.stringify(module)};
      import { realpath } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      for (const repository of [false, true]) {
        const directory = await realpath(await nativeFixtureDirectory(join(tmpdir(), 'alias-check-'), repository));
        await removeNativeFixtureDirectory(directory);
        if (!require('node:fs').existsSync(directory)) throw new Error('Child removed a parent-owned fixture');
      }
    `], { env: { ...process.env, ...environment }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.status;
  });
  assert.equal(status, 0);
});


test('native files get separate OS processes and cleanup owners while every selected file runs', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-driver-test-'));
  try {
    const trace = path.join(directory, 'trace.jsonl');
    const first = path.join(directory, 'first.test.ts'), second = path.join(directory, 'second.test.ts');
    const record = `require('node:fs').appendFileSync(process.env.NATIVE_DRIVER_TRACE, JSON.stringify({ pid: process.pid, root: process.env.LEGALWORK_TEST_NATIVE_FIXTURE_PARENT })+'\\n');`;
    writeFileSync(first, `import {test,expect} from 'bun:test'; test('intentional failure',()=>{${record}process.env.NATIVE_DRIVER_LEAK='set';require('node:fs').rmSync(process.env.LEGALWORK_TEST_NATIVE_FIXTURE_PARENT,{recursive:true});expect(true).toBe(false)});`);
    writeFileSync(second, `import {test,expect} from 'bun:test'; test('clean process',()=>{expect(process.env.NATIVE_DRIVER_LEAK).toBeUndefined();${record}});`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run-native-package-tests.mjs', import.meta.url)), first, second], { env: { ...process.env, NATIVE_DRIVER_TRACE: trace }, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const rows = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].pid, rows[1].pid);
    assert.notEqual(rows[0].root, rows[1].root);
    assert.ok(rows.every(row => !existsSync(row.root)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
