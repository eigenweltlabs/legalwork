import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { eligibleNativeProducer, findNativePackageArtifact, nativeArtifactDigest, restoreNativePackageArchive } from './native-package-artifacts.mjs';
import { changeScope } from './change-scope.mjs';

const key = 'electron-sqlite-v1-' + 'a'.repeat(64), pin = 'b'.repeat(64);
const context = { key, repository: 'eigenweltlabs/legalwork', currentRun: '99', event: 'workflow_dispatch', branch: 'fixture' };
const run = { id: 42, status: 'completed', event: 'push', path: '.github/workflows/ci-native-packaging-cache.yml',
  head_branch: 'fixture', head_repository: { full_name: context.repository } };
const artifact = { id: 8, name: key, expired: false, digest: 'sha256:' + pin, workflow_run: { id: 42 } };
const job = { id: 7, status: 'completed', conclusion: 'success',
  steps: [{ name: 'Retain verified native packaging outputs', conclusion: 'success' }] };
const log = `2026-11-06T12:00:00Z Verified Electron native cache: ${key}; hit=false.\n2026-11-06T12:00:01Z SHA256 digest of uploaded artifact zip is ${pin}\n2026-11-06T12:00:02Z Artifact ${key}.zip successfully finalized. Artifact ID 8\n2026-11-06T12:00:03Z Artifact ${key} has been successfully uploaded! Final size is 100 bytes. Artifact ID is 8\n`;

test('native preparation artifacts respect repository, PR, production and explicit branch boundaries', () => {
  assert.equal(eligibleNativeProducer(run, context), true);
  for (const change of [{ id: 99 }, { status: 'in_progress' }, { event: 'pull_request' }, { head_branch: 'other' },
    { head_repository: { full_name: 'fork/legalwork' } }, { path: '.github/workflows/ci-tests.yml' }]) {
    assert.equal(eligibleNativeProducer({ ...run, ...change }, context), false);
  }
  assert.equal(eligibleNativeProducer(run, { ...context, event: 'push', branch: 'dev' }), false);
  assert.equal(eligibleNativeProducer(run, { ...context, event: 'pull_request' }), false);
  assert.equal(eligibleNativeProducer({ ...run, head_branch: 'dev' }, { ...context, event: 'release' }), true);
  assert.equal(eligibleNativeProducer({ ...run, path: '.github/workflows/sandbox-runtime.yml', event: 'workflow_dispatch' }, context), true);
});

test('native discovery requires successful retention, exact-key native verification and the independent upload digest', async () => {
  const reader = (overrides = {}) => endpoint => {
    if (endpoint.includes('/artifacts?')) return JSON.stringify({ artifacts: [overrides.artifact ?? artifact] });
    if (endpoint.endsWith('/logs')) return overrides.log ?? log;
    return JSON.stringify(endpoint.includes('/jobs?') ? { total_count: 1, jobs: [overrides.job ?? job] } : overrides.run ?? run);
  };
  assert.deepEqual(await findNativePackageArtifact(context, reader()), { runID: 42, jobID: 7, artifactID: 8, digest: pin });
  for (const overrides of [{ artifact: { ...artifact, expired: true } }, { artifact: { ...artifact, digest: 'sha256:' + 'c'.repeat(64) } },
    { job: { ...job, conclusion: 'failure' } }, { job: { ...job, steps: [] } }, { run: { ...run, id: 43 } },
    { log: log.replace(key + '; hit=false.', 'other; hit=false.') }, { log: log + log }]) {
    assert.equal(await findNativePackageArtifact(context, reader(overrides)), undefined);
  }
  assert.equal(nativeArtifactDigest(log + `2026-11-06T12:01:00Z SHA256 digest of uploaded artifact zip is ${'c'.repeat(64)}\n2026-11-06T12:01:01Z Artifact other has been successfully uploaded! Final size is 100 bytes. Artifact ID is 9\n`, artifact), pin);
  let pages = 0;
  assert.deepEqual(await findNativePackageArtifact(context, endpoint => {
    if (endpoint.includes('/artifacts?') && ++pages === 1) return JSON.stringify({ artifacts: Array.from({ length: 100 }, () => ({ ...artifact, expired: true })) });
    return reader()(endpoint);
  }), { runID: 42, jobID: 7, artifactID: 8, digest: pin });
  assert.equal(pages, 2);
});

test('native package ZIP integrity, paths, file types and receipts are checked before replacing a cache', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-package-artifact-'));
  const archive = path.join(root, 'artifact.zip'), destination = path.join(root, 'cache');
  const pack = mode => execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import hashlib,json,sys,zipfile
files={'.forge-meta':b'arm64--148','better_sqlite3.node':b'native fixture'}
receipt={'schema':1,'key':sys.argv[2],'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}}
files['receipt.json']=json.dumps(receipt).encode()
if sys.argv[3]=='corrupt': files['better_sqlite3.node']=b'corrupt'
if sys.argv[3]=='extra': files['unexpected']=b'extra'
if sys.argv[3]=='drive': files['C:escape.dll']=b'escape'
if sys.argv[3]=='device': files['NUL.dll']=b'device'
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for name,data in files.items(): archive.writestr(name,data)
 if sys.argv[3] in ['traversal','link','duplicate']:
  info=zipfile.ZipInfo('../escape' if sys.argv[3]=='traversal' else 'better_sqlite3.node')
  if sys.argv[3]=='link': info.external_attr=0o120777 << 16
  archive.writestr(info,b'other')
`, archive, key, mode], { stdio: 'pipe' });
  const digest = () => createHash('sha256').update(readFileSync(archive)).digest('hex');
  try {
    pack('valid'); await restoreNativePackageArchive(archive, destination, key, digest());
    assert.equal(readFileSync(path.join(destination, 'better_sqlite3.node'), 'utf8'), 'native fixture');
    writeFileSync(path.join(destination, 'sentinel'), 'preserve until verified');
    await assert.rejects(restoreNativePackageArchive(archive, destination, key, pin), /independent producer digest/);
    for (const mode of ['corrupt', 'extra', 'traversal', 'link', 'duplicate', 'drive', 'device']) {
      pack(mode); await assert.rejects(restoreNativePackageArchive(archive, destination, key, digest()));
      assert.equal(readFileSync(path.join(destination, 'sentinel'), 'utf8'), 'preserve until verified');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retention follows real native verification and recovery stays on the exact-key cache miss path', () => {
  const { parse } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yaml');
  const yaml = filename => parse(readFileSync(new URL('../../' + filename, import.meta.url), 'utf8'));
  for (const filename of ['.github/actions/prepare-electron-native/action.yml', '.github/actions/prepare-windows-arm64-speech/action.yml']) {
    const action = yaml(filename), recover = action.runs.steps.find(step => step.uses === './.github/actions/recover-native-package');
    assert.equal(recover.if, "steps.cache.outputs.cache-hit != 'true'");
    assert.equal(recover.with.key, '${{ steps.key.outputs.key }}');
  }
  for (const name of ['alpha-macos-aarch64', 'alpha-windows-x64', 'release-macos-aarch64']) {
    for (const job of Object.values(yaml(`.github/workflows/${name}.yml`).jobs)) {
      if (!job.steps?.some(step => step.uses === './.github/actions/retain-native-packaging')) continue;
      const retain = job.steps.findIndex(step => step.uses === './.github/actions/retain-native-packaging');
      const build = job.steps.findIndex(step => step.run?.includes('build:electron:production'));
      const signing = job.steps.findIndex(step => step.uses === 'azure/login@v2');
      assert.ok(build >= 0 && build < retain && retain < signing);
      assert.equal(job.steps[retain].name, 'Retain verified native packaging outputs');
    }
  }
  const warmer = yaml('.github/workflows/ci-native-packaging-cache.yml');
  assert.equal(warmer.permissions.actions, 'read');
  assert.ok(warmer.jobs.prepare.steps.findIndex(step => step.run?.includes('electron-native-cache.mjs prepare'))
    < warmer.jobs.prepare.steps.findIndex(step => step.uses === './.github/actions/retain-native-packaging'));
  assert.equal(changeScope(['scripts/ci/native-package-artifacts.mjs']).sandbox, true);
  const retain = yaml('.github/actions/retain-native-packaging/action.yml');
  for (const step of retain.runs.steps.filter(step => step.uses === 'actions/upload-artifact@v4')) assert.equal(step.with['retention-days'], 7);
});
