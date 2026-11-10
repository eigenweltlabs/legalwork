// Select portable tests by their transitive workspace imports. When the graph
// cannot identify a test for a change, run the owning package's portable suite.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeDiff } from './merge-plan.mjs';
import { runTests } from './run-tests.mjs';
import { standaloneEngineTestFiles, sandboxRuntimeTestFiles } from './sandbox-test-files.mjs';
import { isTestInput, testDependencies } from './test-dependencies.mjs';

export function affectedTests(area, changed, root = process.cwd()) {
  const prefix = 'apps/' + area + '/';
  const relevant = changed.filter(file => isTestInput(area, file));
  if (!relevant.length || relevant.some(f => !existsSync(path.join(root, f)) || !/\.[cm]?[jt]sx?$/.test(f))) return null;
  const dependencies = testDependencies(area, { root });
  const excluded = new Set([...standaloneEngineTestFiles, ...sandboxRuntimeTestFiles].map(f => 'apps/server/src/' + f));
  const result = new Set();
  for (const input of relevant) {
    const selected = dependencies.affected([input]).filter(file => file.startsWith(prefix) && !excluded.has(file));
    if (!selected.length) return null;
    for (const file of selected) result.add(path.resolve(root, file));
  }
  return [...result].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const area = process.argv[2];
  if (!['app', 'server'].includes(area)) throw new Error('Expected app or server');
  const changed = process.env.MERGE_CHANGED_FILES === undefined ? mergeDiff().files : JSON.parse(process.env.MERGE_CHANGED_FILES);
  const tests = changed === null ? null : affectedTests(area, changed);
  console.log(tests ? 'Affected tests:\n' + tests.join('\n') : 'Running the package portable suite');
  process.exitCode = runTests(area, tests ?? [], process.env.SERVER_TEST_SHARD);
}
