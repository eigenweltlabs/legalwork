import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
