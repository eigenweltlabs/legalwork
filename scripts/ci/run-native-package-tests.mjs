// Native fixture databases can remain process-owned after the engine exits.
// The parent removes private roots only after the complete test child exits.
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
  process.exitCode = withNativeFixtureOwner(environment => {
    const result = spawnSync(process.env.LEGALWORK_TEST_BUN_BIN || 'bun', ['test', ...process.argv.slice(2)], {
      cwd: root, env: { ...process.env, ...environment }, stdio: 'inherit', windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  });
}
