// Existing same-run delivery artifacts also recover an evicted native cache.
// The original successful producer log independently pins its uploaded ZIP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, closeSync, cpSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { eligibleRecoveryRun, readGitHubApi } from './recover-opencode-artifact.mjs';
import { eligibleNativeProducer } from './native-package-artifacts.mjs';
import { sandboxCacheKey, verifyRuntimeCache, writeRuntimeReceipt } from './cache-sandbox-runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function waitForGuestArtifact({ repository, currentRun, arch, timeoutMs = 20 * 60_000, intervalMs = 10_000 },
  read = endpoint => execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }),
  { now = Date.now, sleep = delay } = {}) {
  assert.equal(repository, 'eigenweltlabs/legalwork');
  assert.match(currentRun, /^[1-9][0-9]*$/);
  assert.ok(['x64', 'arm64'].includes(arch));
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isFinite(intervalMs) && intervalMs > 0);
  const name = `sandbox-guest-${arch}`, deadline = now() + timeoutMs;
  const query = new URLSearchParams({ name, per_page: '100' });
  const endpoint = `repos/${repository}/actions/runs/${currentRun}/artifacts?${query}`;
  for (;;) {
    const { artifacts } = JSON.parse(read(endpoint));
    const matches = artifacts.filter(artifact => artifact.name === name && artifact.expired === false
      && Number.isSafeInteger(artifact.id) && artifact.id > 0);
    assert.ok(matches.length <= 1, `Ambiguous ${name} upload in run ${currentRun}`);
    if (matches.length) return matches[0];
    const remaining = deadline - now();
    assert.ok(remaining > 0, `Timed out waiting for ${name} from the parallel guest producer in run ${currentRun}`);
    await sleep(Math.min(intervalMs, remaining));
  }
}

export function runtimeProducerProof(log, key, artifact) {
  log = stripVTControlCharacters(log);
  const keys = new Set([...log.matchAll(/^\S+ (sandbox-runtime-v2-[a-z0-9-]+-[a-f0-9]{64})\r?$/gm)].map(match => match[1]));
  const uploaded = `Artifact ${artifact.name} has been successfully uploaded!`;
  const pins = [];
  let pending;
  for (const line of log.split('\n')) {
    const digest = line.match(/^\S+ SHA256 digest of uploaded artifact zip is ([a-f0-9]{64})\r?$/);
    if (digest) pending = digest[1];
    if (!/^\S+ Artifact .* has been successfully uploaded!/.test(line)) continue;
    if (line.includes(uploaded) && line.trimEnd().endsWith(`Artifact ID is ${artifact.id}`)) pins.push(pending);
    pending = undefined;
  }
  // Packaging now prepares its runtime on the same native host and uploads
  // unrelated diagnostics too. Bind this digest to this upload, not that job's
  // other artifacts; ambiguous duplicate upload receipts still fail closed.
  return keys.size === 1 && keys.has(key) && pins.length === 1 && pins[0]
    && artifact.digest === 'sha256:' + pins[0] ? pins[0] : undefined;
}

export async function findRuntimeRecovery(context, read = readGitHubApi) {
  assert.equal(context.repository, 'eigenweltlabs/legalwork');
  assert.match(context.expectedKey, /^sandbox-runtime-v2-(darwin|linux|win32)-(x64|arm64)-[a-f0-9]{64}$/);
  if (context.event === 'pull_request' && context.headRepository !== context.repository) return;
  const api = `repos/${context.repository}/actions/`;
  // New uploads are indexed by the entire build key. Legacy delivery names
  // get only a bounded migration lookup, never an unbounded cold-build delay.
  for (const name of [context.expectedKey, context.artifactName]) {
    let legacyProducers = 0;
    const legacy = name === context.artifactName;
    const pageSize = legacy ? 10 : 100;
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ name, per_page: String(pageSize), page: String(page) });
      const artifacts = JSON.parse(read(api + 'artifacts?' + query)).artifacts;
      for (const artifact of artifacts) {
        if (artifact.expired !== false || artifact.name !== name || !Number.isSafeInteger(artifact.id) || artifact.id <= 0
          || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || !Number.isSafeInteger(artifact.workflow_run?.id)
          || artifact.workflow_run.id === Number(context.currentRun)) continue;
        const run = JSON.parse(read(api + `runs/${artifact.workflow_run.id}`));
        const samePR = context.event === 'pull_request' && eligibleRecoveryRun(run, context);
        if (!samePR && !eligibleNativeProducer(run, context)) continue;
        const jobs = JSON.parse(read(api + `runs/${run.id}/jobs?per_page=100`));
        if (jobs.total_count !== jobs.jobs.length) continue;
        for (const job of jobs.jobs.filter(job => job.conclusion === 'success' && job.status === 'completed'
          && job.steps?.some(step => step.name === 'Run ./.github/actions/prepare-sandbox-runtime' && step.conclusion === 'success'))) {
          const pin = runtimeProducerProof(read(api + `jobs/${job.id}/logs`), context.expectedKey, artifact);
          if (pin) return { runID: run.id, jobID: job.id, artifactID: artifact.id, digest: pin };
        }
        if (legacy && ++legacyProducers === 3) break;
      }
      if (artifacts.length < pageSize || legacy) break;
    }
  }
}

export async function restoreRuntimeArtifact(archive, directory, key, arch, expectedDigest) {
  assert.match(expectedDigest, /^[a-f0-9]{64}$/);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  assert.equal(hash.digest('hex'), expectedDigest, 'Runtime archive differs from its independent producer digest');
  const temporary = mkdtempSync(path.join(tmpdir(), 'verified-runtime-artifact-'));
  const staged = path.join(temporary, 'runtime');
  try {
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', [path.join(root, 'scripts/ci/extract-runtime-artifact.py'), archive, staged], { stdio: 'inherit' });
    // The independently pinned upload came from a successful current-key
    // producer. Recreate its cache envelope, then apply current validation.
    writeRuntimeReceipt(staged, key);
    verifyRuntimeCache(staged, key, 'runtime', arch);
    rmSync(directory, { recursive: true, force: true });
    cpSync(staged, directory, { recursive: true });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, arch] = process.argv.slice(2);
  const key = sandboxCacheKey('runtime', arch);
  if (operation === 'find') {
    let result;
    try {
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
      result = await findRuntimeRecovery({ repository: process.env.GITHUB_REPOSITORY, currentRun: process.env.GITHUB_RUN_ID,
        event: process.env.GITHUB_EVENT_NAME, branch: event.pull_request?.head.ref ?? process.env.GITHUB_REF_NAME,
        pullRequest: event.pull_request?.number, headRepository: event.pull_request?.head.repo.full_name,
        expectedKey: key, artifactName: `sandbox-runtime-${process.platform}-${arch}` });
    } catch (error) { console.warn(`Native artifact discovery unavailable: ${stripVTControlCharacters(error.message).split('\n')[0]}`); }
    if (result) {
      console.log(`Recover verified native runtime ${key} from ${result.runID}/${result.jobID}, artifact ${result.artifactID}, digest ${result.digest}.`);
      await appendFile(process.env.GITHUB_OUTPUT, `artifact-id=${result.artifactID}\ndigest=${result.digest}\n`);
    } else console.log('No trusted exact native runtime artifact found; build pinned sources.');
  } else if (operation === 'wait-for-guest') {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    console.log(`Waiting for sandbox-guest-${arch} from this workflow run after a cold runtime miss.`);
    const artifact = await waitForGuestArtifact({ repository: process.env.GITHUB_REPOSITORY,
      currentRun: process.env.GITHUB_RUN_ID, arch });
    console.log(`Guest artifact ${artifact.name} is ready (ID ${artifact.id}).`);
  } else if (operation === 'restore') {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.GITHUB_REPOSITORY, 'eigenweltlabs/legalwork');
    assert.match(process.env.RECOVERY_ARTIFACT_ID, /^[1-9][0-9]*$/);
    const temporary = mkdtempSync(path.join(tmpdir(), 'native-runtime-download-'));
    const archive = path.join(temporary, 'artifact.zip');
    try {
      const download = flags => {
        const output = openSync(archive, 'w');
        try { execFileSync('gh', ['api', ...flags, `repos/eigenweltlabs/legalwork/actions/artifacts/${process.env.RECOVERY_ARTIFACT_ID}/zip`], { stdio: ['ignore', output, 'pipe'] }); }
        finally { closeSync(output); }
      };
      try { download([]); }
      catch (error) {
        // The binary response goes only to our file, never terminal output.
        if (!String(error.stderr ?? error.message).includes('pass --allow-escape-sequences')) throw error;
        download(['--allow-escape-sequences']);
      }
      await restoreRuntimeArtifact(archive, path.join(root, 'apps/server/resources/agent-sandbox/runtime'), key, arch, process.env.RECOVERY_DIGEST);
      console.log('Recovered runtime passes the exact current source/toolchain key and file receipt.');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  } else throw new Error('Use find|restore|wait-for-guest x64|arm64');
}
