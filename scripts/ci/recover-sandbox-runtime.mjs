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
import { eligibleRecoveryRun, readGitHubApi } from './recover-opencode-artifact.mjs';
import { eligibleProductionRun } from './production-opencode-cache.mjs';
import { sandboxCacheKey, verifyRuntimeCache, writeRuntimeReceipt } from './cache-sandbox-runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function runtimeProducerProof(log, key, artifact) {
  log = stripVTControlCharacters(log);
  const keys = new Set([...log.matchAll(/^\S+ (sandbox-runtime-v2-[a-z0-9-]+-[a-f0-9]{64})\r?$/gm)].map(match => match[1]));
  const pins = new Set([...log.matchAll(/^\S+ SHA256 digest of uploaded artifact zip is ([a-f0-9]{64})\r?$/gm)].map(match => match[1]));
  const uploaded = `Artifact ${artifact.name} has been successfully uploaded!`;
  const line = log.split('\n').find(line => /^\S+ Artifact /.test(line) && line.includes(uploaded)
    && line.trimEnd().endsWith(`Artifact ID is ${artifact.id}`));
  const pin = [...pins][0];
  return keys.size === 1 && keys.has(key) && pins.size === 1 && artifact.digest === 'sha256:' + pin && line ? pin : undefined;
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
        if (!samePR && !eligibleProductionRun(run, context)) continue;
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
  } else throw new Error('Use find|restore x64|arm64');
}
