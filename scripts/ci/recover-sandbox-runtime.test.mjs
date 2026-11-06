import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findRuntimeRecovery, restoreRuntimeArtifact, runtimeProducerProof } from './recover-sandbox-runtime.mjs';
import { verifyRuntimeCache } from './cache-sandbox-runtime.mjs';

const key = 'sandbox-runtime-v2-darwin-arm64-' + 'a'.repeat(64), pin = 'b'.repeat(64);
const context = { repository: 'eigenweltlabs/legalwork', currentRun: '99', event: 'workflow_dispatch', branch: 'fixture',
  expectedKey: key, artifactName: 'sandbox-runtime-darwin-arm64' };
const artifact = { id: 8, name: key, expired: false, digest: 'sha256:' + pin, workflow_run: { id: 42 } };
const run = { id: 42, status: 'completed', event: 'workflow_dispatch', path: '.github/workflows/alpha-macos-aarch64.yml',
  head_branch: 'fixture', head_repository: { full_name: context.repository } };
const job = { id: 7, status: 'completed', conclusion: 'success',
  steps: [{ name: 'Run ./.github/actions/prepare-sandbox-runtime', conclusion: 'success' }] };
const log = `2026-11-05T12:00:00Z ${key}\n2026-11-05T12:01:00Z SHA256 digest of uploaded artifact zip is ${pin}\n2026-11-05T12:01:01Z Artifact ${artifact.name} has been successfully uploaded! Final size is 100 bytes. Artifact ID is 8\n`;

test('native artifact recovery binds the exact key, artifact ID and independent upload digest', () => {
  assert.equal(runtimeProducerProof(log, key, artifact), pin);
  assert.equal(runtimeProducerProof(log.replace(`2026-11-05T12:01:01Z Artifact`, `2026-11-05T12:01:00Z Artifact ${artifact.name}.zip successfully finalized. Artifact ID 8\n2026-11-05T12:01:01Z Artifact`), key, artifact), pin);
  for (const changed of [{ ...artifact, digest: 'sha256:' + 'c'.repeat(64) }, { ...artifact, id: 80 }, { ...artifact, name: 'other' }]) {
    assert.equal(runtimeProducerProof(log, key, changed), undefined);
  }
  assert.equal(runtimeProducerProof(log + `2026-11-05T12:02:00Z ${key.replace(/a{64}/, 'c'.repeat(64))}\n`, key, artifact), undefined);
  assert.equal(runtimeProducerProof(log + `2026-11-05T12:02:00Z SHA256 digest of uploaded artifact zip is ${'c'.repeat(64)}\n2026-11-05T12:02:01Z Artifact ci-timings has been successfully uploaded! Final size is 100 bytes. Artifact ID is 9\n`, key, artifact), pin);
  assert.equal(runtimeProducerProof(log + log, key, artifact), undefined, 'Duplicate upload receipts are ambiguous');
  assert.equal(runtimeProducerProof(log.replace(/.*SHA256 digest.*\n/, ''), key, artifact), undefined);
});

test('recovery requires a successful producer in an eligible completed run, and paginates retained artifacts', async () => {
  const reader = (runData = run, jobData = job, archive = artifact) => endpoint => {
    if (endpoint.includes('artifacts?')) return JSON.stringify({ artifacts: new URL('https://fixture/'+endpoint).searchParams.get('name') === archive.name ? [archive] : [] });
    if (endpoint.endsWith('/logs')) return log;
    return JSON.stringify(endpoint.includes('/jobs?') ? { total_count: 1, jobs: [jobData] } : runData);
  };
  const proof = { runID: 42, jobID: 7, artifactID: 8, digest: pin };
  assert.deepEqual(await findRuntimeRecovery(context, reader()), proof);
  // A failed sibling does not invalidate the independently successful producer.
  assert.deepEqual(await findRuntimeRecovery(context, reader({ ...run, conclusion: 'failure' })), proof);
  for (const change of [{ id: 99 }, { status: 'in_progress' }, { head_branch: 'other' }, { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'fork/legalwork' } }, { event: 'pull_request' }]) {
    assert.equal(await findRuntimeRecovery(context, reader({ ...run, ...change })), undefined);
  }
  for (const change of [{ conclusion: 'failure' }, { steps: [] }, { status: 'in_progress' }]) {
    assert.equal(await findRuntimeRecovery(context, reader(run, { ...job, ...change })), undefined);
  }
  assert.equal(await findRuntimeRecovery(context, reader(run, job, { ...artifact, expired: true })), undefined);
  const pr = { ...context, event: 'pull_request', pullRequest: 370, headRepository: context.repository };
  const prRun = { ...run, event: 'pull_request', path: '.github/workflows/ci-tests.yml', pull_requests: [{ number: 370 }] };
  assert.deepEqual(await findRuntimeRecovery(pr, reader(prRun)), proof);
  assert.equal(await findRuntimeRecovery(pr, reader({ ...prRun, pull_requests: [{ number: 371 }] })), undefined);
  assert.equal(await findRuntimeRecovery(pr, reader()), undefined, 'PRs cannot select branch benchmark artifacts');
  assert.equal(await findRuntimeRecovery({ ...pr, headRepository: 'fork/legalwork' }, () => { throw Error('No fork queries'); }), undefined);
  let pages = 0;
  assert.deepEqual(await findRuntimeRecovery(context, endpoint => {
    if (endpoint.includes('artifacts?') && ++pages === 1) return JSON.stringify({ artifacts: Array.from({ length: 100 }, () => ({ ...artifact, expired: true })) });
    return reader()(endpoint);
  }), proof);
  assert.equal(pages, 2);
  const legacy = { ...artifact, name: context.artifactName };
  assert.deepEqual(await findRuntimeRecovery(context, endpoint => endpoint.endsWith('/logs')
    ? log.replace(`Artifact ${artifact.name}`, `Artifact ${legacy.name}`) : reader(run, job, legacy)(endpoint)), proof);
  let reads = 0;
  const wrongKey = key.replace(/a{64}/, 'c'.repeat(64));
  assert.equal(await findRuntimeRecovery({ ...context, expectedKey: wrongKey }, endpoint => {
    if (endpoint.includes('artifacts?')) return JSON.stringify({ artifacts: new URL('https://fixture/'+endpoint).searchParams.get('name') === context.artifactName
      ? Array.from({ length: 100 }, () => ({ ...artifact, name: context.artifactName })) : [] });
    if (endpoint.endsWith('/logs')) { reads++; return log; }
    return reader()(endpoint);
  }), undefined);
  assert.equal(reads, 3, 'Legacy migration must not scan every historical producer on a cold miss');
});

test('a pinned runtime is safely extracted and verified before replacing any destination', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-recovery-'));
  const archive = path.join(root, 'artifact.zip'), destination = path.join(root, 'runtime');
  // Small synthetic bytes exercise the real ZIP/tar reader and manifest gate;
  // native execution remains mandatory in the composite action and hosted run.
  const pack = mode => execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import hashlib, io, json, tarfile, zipfile, sys
files = {name: name.encode() for name in ['kernel','initrd.gz','qemu-system-aarch64','third-party-notices.txt','third-party-sbom.json']}
files['manifest.json'] = json.dumps({'architecture':'aarch64','qemuVersion':'11.1.2','files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}}).encode()
if sys.argv[2] == 'manifest': files['kernel'] = b'corrupt'
payload = io.BytesIO()
with tarfile.open(fileobj=payload, mode='w:gz') as tar:
 for name, data in files.items():
  info = tarfile.TarInfo(name); info.size=len(data); info.mode=0o755
  tar.addfile(info, io.BytesIO(data))
 if sys.argv[2] in ['traversal','link','duplicate']:
  info = tarfile.TarInfo('../escape' if sys.argv[2]=='traversal' else 'kernel')
  if sys.argv[2]=='link': info.type=tarfile.SYMTYPE; info.linkname='/etc/passwd'
  tar.addfile(info, io.BytesIO(b''))
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
 archive.writestr('sandbox-runtime.tgz', payload.getvalue())
 if sys.argv[2]=='extra': archive.writestr('other', b'unexpected')
`, archive, mode], { stdio: 'pipe' });
  const digest = () => createHash('sha256').update(readFileSync(archive)).digest('hex');
  try {
    pack('valid');
    await restoreRuntimeArtifact(archive, destination, key, 'arm64', digest());
    verifyRuntimeCache(destination, key, 'runtime', 'arm64');
    writeFileSync(path.join(destination, 'sentinel'), 'preserve before full verification');
    await assert.rejects(restoreRuntimeArtifact(archive, destination, key, 'arm64', pin), /independent producer digest/);
    for (const mode of ['manifest', 'traversal', 'link', 'duplicate', 'extra']) {
      pack(mode);
      await assert.rejects(restoreRuntimeArtifact(archive, destination, key, 'arm64', digest()));
      assert.equal(readFileSync(path.join(destination, 'sentinel'), 'utf8'), 'preserve before full verification');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
