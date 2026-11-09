// Select portable tests by their transitive workspace imports. When the graph
// cannot identify a test for a change, run the owning package's portable suite.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeDiff } from './merge-plan.mjs';
import { runTests } from './run-tests.mjs';
import { standaloneEngineTestFiles, sandboxRuntimeTestFiles } from './sandbox-test-files.mjs';

export function affectedTests(area, changed, root = process.cwd()) {
  const prefix = 'apps/' + area + '/';
  const shared = /^(?:packages\/(?:types|ui|openui)\/|patches\/)/;
  const relevant = changed.filter(f => (f.startsWith(prefix) || shared.test(f)) && !f.endsWith('.md')
    && f !== 'apps/server/src/core-skills.ts');
  if (!relevant.length || relevant.some(f => !existsSync(path.join(root, f)) || !/\.[cm]?[jt]sx?$/.test(f))) return null;
  const ts = createRequire(path.join(root, prefix, 'package.json'))('typescript');
  const tracked = execFileSync('git', ['ls-files', '-z', '--', prefix, 'packages/'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(f => /\.[cm]?[jt]sx?$/.test(f) && existsSync(path.join(root, f)));
  const known = new Set(tracked), parents = new Map();
  const config = path.join(root, prefix, 'tsconfig.json');
  const parsed = ts.readConfigFile(config, ts.sys.readFile);
  if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  const sourceReaders = new Map();
  const options = ts.convertCompilerOptionsFromJson(parsed.config.compilerOptions, path.dirname(config)).options;
  const cache = ts.createModuleResolutionCache(root, f => f, options);
  for (const file of tracked) {
    if (file === 'apps/server/src/core-skills.ts') continue;
    const source = readFileSync(path.join(root, file), 'utf8');
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && /readFile/.test(source)) {
      for (const input of relevant) {
        if (!source.includes(path.basename(input))) continue;
        if (!sourceReaders.has(input)) sourceReaders.set(input, []);
        sourceReaders.get(input).push(file);
      }
    }
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const name = imported.fileName;
      if (!name.startsWith('.') && !name.startsWith('@/') && !name.startsWith('@legalwork/')) continue;
      const absolute = ts.resolveModuleName(name, path.join(root, file), options, ts.sys, cache).resolvedModule?.resolvedFileName;
      if (!absolute) continue;
      const dependency = path.relative(root, absolute);
      if (!known.has(dependency)) continue;
      if (!parents.has(dependency)) parents.set(dependency, []);
      parents.get(dependency).push(file);
    }
  }
  const excluded = new Set([...standaloneEngineTestFiles, ...sandboxRuntimeTestFiles].map(f => 'apps/server/src/' + f));
  const tests = tracked.filter(f => f.startsWith(prefix) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f) && !excluded.has(f));
  const result = new Set();
  for (const input of relevant) {
    const reachable = new Set([input, ...(sourceReaders.get(input) ?? [])]);
    for (const file of reachable) for (const parent of parents.get(file) ?? []) reachable.add(parent);
    const stem = path.basename(input).replace(/\.[cm]?[jt]sx?$/, '');
    const selected = tests.filter(f => reachable.has(f) || path.basename(f).startsWith(stem + '.'));
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
