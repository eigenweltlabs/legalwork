// Tiny verified native outputs survive dependency-store eviction without
// increasing the Actions cache limit. Native ABI/load checks still run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, closeSync, cpSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { eligibleProductionRun } from './production-opencode-cache.mjs';
import { readGitHubApi } from './recover-opencode-artifact.mjs';
import { restoreElectronNativeCache } from '../../apps/desktop/scripts/electron-native-cache.mjs';
import { restoreSpeechCache } from '../../apps/desktop/scripts/windows-arm64-speech-cache.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function eligibleNativeProducer(run, context) {
  if (eligibleProductionRun(run, context)) return true;
  if (context.repository !== 'eigenweltlabs/legalwork' || !Number.isSafeInteger(run.id) || run.id <= 0
    || run.id === Number(context.currentRun) || run.status !== 'completed' || run.head_repository?.full_name !== context.repository
    || !['sandbox-runtime', 'ci-runtime-cache', 'ci-native-packaging-cache'].some(name => run.path === `.github/workflows/${name}.yml`)) return false;
  if (run.head_branch === 'dev') return ['push', 'workflow_dispatch', 'schedule'].includes(run.event);
  return context.event === 'workflow_dispatch' && typeof context.branch === 'string' && context.branch.length > 0
    && run.head_branch === context.branch && ['workflow_dispatch', 'push'].includes(run.event);
}

export function nativeArtifactDigest(log, artifact) {
  log = stripVTControlCharacters(log);
  let pending;
  const matches = [];
  for (const line of log.split('\n')) {
    const digest = line.match(/^\S+ SHA256 digest of uploaded artifact zip is ([a-f0-9]{64})\r?$/);
    if (digest) pending = digest[1];
    if (!/^\S+ Artifact .* has been successfully uploaded!/.test(line)) continue;
    if (line.includes(`Artifact ${artifact.name} has been successfully uploaded!`)
      && line.trimEnd().endsWith(`Artifact ID is ${artifact.id}`)) matches.push(pending);
    pending = undefined;
  }
  return matches.length === 1 && matches[0] && artifact.digest === 'sha256:' + matches[0] ? matches[0] : undefined;
}

export async function findNativePackageArtifact(context, read = readGitHubApi) {
  assert.match(context.key, /^(electron-sqlite|windows-arm64-speech)-v1-[a-f0-9]{64}$/);
  assert.equal(context.repository, 'eigenweltlabs/legalwork');
  const api = `repos/${context.repository}/actions/`;
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ name: context.key, per_page: '100', page: String(page) });
    const artifacts = JSON.parse(read(api + 'artifacts?' + query)).artifacts;
    for (const artifact of artifacts) {
      if (artifact.name !== context.key || artifact.expired !== false || !Number.isSafeInteger(artifact.id) || artifact.id <= 0
        || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || !Number.isSafeInteger(artifact.workflow_run?.id)) continue;
      const run = JSON.parse(read(api + `runs/${artifact.workflow_run.id}`));
      if (run.id !== artifact.workflow_run.id || !eligibleNativeProducer(run, context)) continue;
      const data = JSON.parse(read(api + `runs/${run.id}/jobs?per_page=100`));
      if (data.jobs.length !== data.total_count) continue;
      for (const job of data.jobs.filter(job => job.status === 'completed' && job.conclusion === 'success'
        && job.steps?.some(step => step.name === 'Retain verified native packaging outputs' && step.conclusion === 'success'))) {
        const log = read(api + `jobs/${job.id}/logs`);
        const verified = context.key.startsWith('electron-sqlite-')
          ? new RegExp(`^\\S+ Verified Electron native cache: ${context.key}; hit=(true|false)\\.\\r?$`, 'm').test(log)
          : new RegExp(`^\\S+ Native speech cache key: ${context.key}\\r?$`, 'm').test(log);
        const digest = nativeArtifactDigest(log, artifact);
        if (verified && digest) return { runID: run.id, jobID: job.id, artifactID: artifact.id, digest };
      }
    }
    if (artifacts.length < 100) return;
  }
}

export function validateNativePackageCache(directory, key) {
  assert.match(key, /^(electron-sqlite|windows-arm64-speech)-v1-[a-f0-9]{64}$/);
  const temporary = mkdtempSync(path.join(tmpdir(), 'native-cache-validation-'));
  try {
    const restore = key.startsWith('electron-sqlite-') ? restoreElectronNativeCache : restoreSpeechCache;
    assert.equal(restore(directory, path.join(temporary, 'verified'), key), true, 'Verified native cache must exist');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export async function restoreNativePackageArchive(archive, directory, key, digest) {
  assert.match(digest, /^[a-f0-9]{64}$/);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  assert.equal(hash.digest('hex'), digest, 'Native package archive differs from its independent producer digest');
  const temporary = mkdtempSync(path.join(tmpdir(), 'native-package-extraction-'));
  try {
    const staged = path.join(temporary, 'cache');
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', [path.join(root, 'scripts/ci/extract-native-package-cache.py'), archive, staged], { stdio: 'inherit' });
    validateNativePackageCache(staged, key);
    rmSync(directory, { recursive: true, force: true });
    cpSync(staged, directory, { recursive: true });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, key, directory] = process.argv.slice(2);
  assert.match(key, /^(electron-sqlite|windows-arm64-speech)-v1-[a-f0-9]{64}$/);
  if (operation === 'find') {
    let result;
    try { result = await findNativePackageArtifact({ key, repository: process.env.GITHUB_REPOSITORY,
      currentRun: process.env.GITHUB_RUN_ID, event: process.env.GITHUB_EVENT_NAME, branch: process.env.GITHUB_REF_NAME }); }
    catch (error) { console.warn('Native artifact lookup unavailable: ' + stripVTControlCharacters(error.message).split('\n')[0]); }
    if (result) {
      console.log(`Recover native package ${key} from ${result.runID}/${result.jobID}, artifact ${result.artifactID}, digest ${result.digest}.`);
      await appendFile(process.env.GITHUB_OUTPUT, `artifact-id=${result.artifactID}\ndigest=${result.digest}\n`);
    } else console.log('No trusted retained native output; use the normal verified native build.');
  } else if (operation === 'validate') validateNativePackageCache(directory, key);
  else {
    assert.equal(operation, 'restore');
    assert.equal(process.env.GITHUB_REPOSITORY, 'eigenweltlabs/legalwork');
    assert.match(process.env.RECOVERY_ARTIFACT_ID, /^[1-9][0-9]*$/);
    const expected = key.startsWith('electron-sqlite-') ? 'electron-native-sqlite' : 'windows-arm64-speech';
    assert.equal(path.resolve(directory), path.join(process.env.RUNNER_TEMP, expected), 'Restore only the owned native cache directory');
    const temporary = mkdtempSync(path.join(tmpdir(), 'native-package-download-'));
    const archive = path.join(temporary, 'artifact.zip');
    try {
      const download = flags => {
        const output = openSync(archive, 'w');
        try { execFileSync('gh', ['api', ...flags, `repos/eigenweltlabs/legalwork/actions/artifacts/${process.env.RECOVERY_ARTIFACT_ID}/zip`], { stdio: ['ignore', output, 'pipe'] }); }
        finally { closeSync(output); }
      };
      try { download([]); }
      catch (error) {
        if (!String(error.stderr ?? error.message).includes('pass --allow-escape-sequences')) throw error;
        download(['--allow-escape-sequences']);
      }
      await restoreNativePackageArchive(archive, directory, key, process.env.RECOVERY_DIGEST);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
