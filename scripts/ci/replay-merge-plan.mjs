// Input is a frozen set of GitHub PR number/base/head triples. No workflow dispatch or checkout.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mergeDiff, mergePlan, portableAreas, hostChecks } from './merge-plan.mjs';
import { standaloneEngineTestFiles } from './sandbox-test-files.mjs';
import { engineTestSelection } from './run-engine-tests.mjs';
import { isTestInput } from './test-dependencies.mjs';
import { changeScope } from './change-scope.mjs';

const cases = JSON.parse(readFileSync(process.argv[2] || new URL('./fixtures/merge-replay-50.json', import.meta.url), 'utf8'));
if (!cases.length || new Set(cases.map(pr => pr.number)).size !== cases.length) throw Error('Expected unique PRs');
const standalone = new Set(standaloneEngineTestFiles.map(file => 'apps/server/src/' + file));
const rows = cases.map(({ number, base, head }) => {
  const { files, engineDepsChanged } = mergeDiff({ EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head });
  const grep = spawnSync('git', ['grep', '-lzF', 'LEGALWORK_TEST_OPENCODE_BIN', head, '--', 'apps/server/src'], { encoding: 'utf8' });
  if (![0, 1].includes(grep.status)) throw Error(grep.stderr || 'Could not read native fixtures at ' + head);
  const realTests = grep.stdout.split('\0').map(file => file.slice(head.length + 1))
    .filter(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && !standalone.has(file));
  const dependencyAnalysis = changeScope(files).server && files.some(file => isTestInput('server', file));
  const selection = dependencyAnalysis ? engineTestSelection(files, { base, ref: head }) : { realTests };
  const { fullEngine, targets, focused } = mergePlan(files, { engineDepsChanged, ...selection });
  const nativeCount = fullEngine && !dependencyAnalysis ? engineTestSelection([],{ref:head}).realTests.length : selection.realTests.length;
  const host = hostChecks(files);
  return { number, base, head, areas: portableAreas(files), fullEngine, targets, focused,
    engine: fullEngine || targets.some(target => target !== 'win32') || focused.length > 0 || host.length > 0,
    hostChecks: host, realTests: nativeCount, dependencyAnalysis, unknownInputs: selection.engineInputsUnknown ?? false,
    unknownEngineInputs:selection.unknownEngineInputs??[] };
});
console.log(JSON.stringify({ count: rows.length, fullEngine: rows.filter(pr => pr.fullEngine).length,
  engine: rows.filter(pr => pr.engine).length, fullSandbox: rows.filter(pr => pr.targets.length === 3).length, rows }, null, 2));
