// Server source tests declare real-engine fixtures through this environment
// variable. The normal unit job leaves it unset; this job must execute them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTests } from './run-tests.mjs';
import { standaloneEngineTestFiles } from './sandbox-test-files.mjs';
import { isTestFile, isTestInput, testDependencies } from './test-dependencies.mjs';
import { contractTests } from './engine-test-contracts.mjs';
import { engineMetadataInputs } from './engine-inputs.mjs';

const standalone = new Set(standaloneEngineTestFiles.map(file => fileURLToPath(new URL(`../../apps/server/src/${file}`, import.meta.url))));

export function engineTestFiles(directory, dependencies) {
  if (dependencies) {
    const inputs = [...dependencies.sources].filter(([, source]) => source.includes('LEGALWORK_TEST_OPENCODE_BIN')).map(([file]) => file);
    return dependencies.affected(inputs).filter(file => file.startsWith('apps/server/src/')
      && !standaloneEngineTestFiles.some(name => file === 'apps/server/src/' + name))
      .map(file => path.resolve(directory, '..', file.replace(/^apps\/server\//, ''))).sort();
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return engineTestFiles(filename);
    return entry.isFile() && !standalone.has(filename) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      && readFileSync(filename, 'utf8').includes('LEGALWORK_TEST_OPENCODE_BIN') ? [filename] : [];
  }).sort();
}

export function engineTestSelection(changed, options = {}) {
  const root = options.root ?? process.cwd(), dependencies = testDependencies('server', {...options,runtimeOnly:true});
  const realTests = engineTestFiles(path.join(root, 'apps/server/src'), dependencies).map(file => path.relative(root, file).split(path.sep).join('/'));
  const inputs = changed.filter(file => isTestInput('server', file));
  const base = options.base ? execFileSync('git',['merge-base',options.base,options.ref??'HEAD'],{cwd:root,encoding:'utf8'}).trim() : undefined;
  const deleted = inputs.filter(file=>!dependencies.files.has(file)&&!file.startsWith('patches/'));
  const metadata = inputs.filter(file=>file.startsWith('patches/')||file.endsWith('/package.json'));
  const previous = base && (deleted.length||metadata.length) ? testDependencies('server',{root,ref:base,runtimeOnly:true}) : undefined;
  const graphs = previous ? [dependencies,previous] : [dependencies];
  const owned = metadata.length ? engineMetadataInputs(metadata,{root,ref:options.ref,base,graphs}) : {inputs:[],unknown:false};
  const sourceInputs = inputs.filter(file=>!metadata.includes(file));
  const unknownEngineInputs = deleted.filter(file=>!graphs.some(graph=>graph.files.has(file)));
  if(owned.unknown)unknownEngineInputs.push(...metadata);
  if(inputs.includes('apps/server/tsconfig.json'))unknownEngineInputs.push('apps/server/tsconfig.json');
  const select = files => contractTests(files,realTests,options.contracts);
  const affected = new Set(select([...sourceInputs,...owned.inputs]));
  // Routes and shared type barrels expose many independent APIs. Their native
  // behavior is owned by the contracts above; portable CI covers other edits.
  const directInputs = sourceInputs.filter(file=>!/^apps\/server\/src\/routes\/|^packages\/types\//.test(file));
  for(const graph of graphs) {
    const helpers=sourceInputs.filter(file=>/\.test-support\.[cm]?[jt]s$/.test(file));
    for(const file of graph.affected(helpers))affected.add(file);
    for(const file of graph.affected(graph.fixtureReaders(sourceInputs)))affected.add(file);
    // A native fixture's direct runtime subjects remain relevant. Loading a
    // subject indirectly through the complete server does not select it.
    for(const file of graph.directTests(directInputs))affected.add(file);
    for(const file of graph.affected(owned.inputs))affected.add(file);
  }
  for(const file of sourceInputs) {
    if(isTestFile(file))continue;
    const declared = select([file]).length || realTests.includes(file)
      || directInputs.includes(file) && graphs.some(graph=>graph.directTests([file]).some(test=>realTests.includes(test)));
    const nativeApi = graphs.some(graph=>[...graph.imports].some(([name,consumers])=>name.startsWith('@opencode/')&&consumers.has(file)));
    if(!declared && nativeApi)unknownEngineInputs.push(file);
  }
  return { realTests, affectedEngineTests: unknownEngineInputs.length ? realTests : realTests.filter(file => affected.has(file)),
    engineInputsUnknown: unknownEngineInputs.length > 0, unknownEngineInputs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.env.LEGALWORK_TEST_OPENCODE_BIN, 'Set up the verified engine before running integration tests');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = engineTestFiles(path.join(root, 'apps/server/src'), testDependencies('server', { root, runtimeOnly:true }));
  assert.ok(files.length > 0, 'No declared server engine tests found');
  console.log(`Running ${files.length} server test files with the verified engine.`);
  process.exitCode = runTests('engine', files);
}
