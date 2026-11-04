// A same-PR development artifact can outlive an evicted Actions cache.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export function eligibleRecoveryRun(run, { repository, branch, pullRequest, currentRun }) {
  return repository === 'eigenweltlabs/legalwork' && Number.isSafeInteger(run.id) && run.id > 0 && run.id !== Number(currentRun)
    && run.event === 'pull_request' && run.path === '.github/workflows/ci-tests.yml'
    && run.status === 'completed' && run.head_repository?.full_name === repository
    && run.head_branch === branch && run.pull_requests?.some(pr => pr.number === pullRequest);
}
export function producerProof(log, expectedKey) {
  assert.match(expectedKey, /^opencode-development-v1-[a-f0-9]{64}$/);
  log = stripVTControlCharacters(log);
  const keys = new Set([...log.matchAll(/^\S+ key=(opencode-development-v1-[a-f0-9]{64})\r?$/gm)].map(match => match[1]));
  const pins = new Set([...log.matchAll(/^\S+ manifest-sha256=([a-f0-9]{64})\r?$/gm)].map(match => match[1]));
  if (keys.size !== 1 || !keys.has(expectedKey) || pins.size !== 1) return undefined;
  return [...pins][0];
}
export async function verifyRecoveryPin(directory, expectedPin) {
  assert.match(expectedPin, /^[a-f0-9]{64}$/);
  assert.ok((await lstat(directory)).isDirectory(), 'Recovered distribution must be an ordinary directory');
  for (const name of ['derivative-release.json', 'distribution-receipt.json']) assert.ok((await lstat(path.join(directory, name))).isFile(), 'Recovered identities must be ordinary files');
  const manifest = await readFile(path.join(directory, 'derivative-release.json'));
  assert.equal(createHash('sha256').update(manifest).digest('hex'), expectedPin, 'Recovered manifest differs from the independent producer log pin');
  const receipt = JSON.parse(await readFile(path.join(directory, 'distribution-receipt.json'), 'utf8'));
  assert.equal(receipt.manifestSha256, expectedPin, 'Recovered receipt must retain the same independent pin');
}
export function readGitHubApi(endpoint, execute = execFileSync) {
  const logs = endpoint.endsWith('/logs');
  // Fetched logs are data for the parser, never terminal output. Newer gh
  // versions require an explicit opt-in before returning ANSI-bearing bodies.
  const read = flags => execute('gh', ['api', ...flags, endpoint], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let body;
  try { body = read([]); }
  catch (error) {
    if (!logs || !String(error.stderr ?? error.message).includes('pass --allow-escape-sequences')) throw error;
    body = read(['--allow-escape-sequences']);
  }
  return logs ? stripVTControlCharacters(body) : body;
}
export async function findRecovery({ event, repository, currentRun, expectedKey }, read = readGitHubApi) {
  if (repository !== 'eigenweltlabs/legalwork' || event.pull_request?.head.repo.full_name !== repository) return undefined;
  const branch = event.pull_request.head.ref, pullRequest = event.pull_request.number;
  assert.equal(typeof branch, 'string'); assert.ok(Number.isSafeInteger(pullRequest) && pullRequest > 0);
  const root = `repos/${repository}/actions/`;
  const query = new URLSearchParams({ event: 'pull_request', branch, status: 'completed', per_page: '20' });
  const runs = JSON.parse(read(root + 'workflows/ci-tests.yml/runs?' + query)).workflow_runs;
  for (const run of runs) {
    if (!eligibleRecoveryRun(run, { repository, branch, pullRequest, currentRun })) continue;
    const data = JSON.parse(read(root + `runs/${run.id}/jobs?per_page=100`));
    if (data.jobs.length !== data.total_count) continue; // Never assume a truncated list is complete.
    const job = data.jobs.find(job => job.name === 'opencode-derivative / build' && job.status === 'completed' && job.conclusion === 'success'
      && job.steps?.some(step => step.name === 'Verify all development archives against current source policy' && step.conclusion === 'success'));
    if (!job) continue;
    const artifacts = JSON.parse(read(root + `runs/${run.id}/artifacts?per_page=100`));
    if (artifacts.artifacts.length !== artifacts.total_count) continue;
    const full = artifacts.artifacts.filter(artifact => artifact.name === 'opencode-derivative-ci' && artifact.expired === false);
    if (full.length !== 1) continue;
    const pin = producerProof(read(root + `jobs/${job.id}/logs`), expectedKey);
    if (pin) return { runID: String(run.id), jobID: job.id, manifestSha256: pin, artifactID: full[0].id };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'find') {
    assert.equal(process.env.BUILD_MODE, 'development', 'Production must never select artifact recovery');
    let result;
    try {
      result = await findRecovery({ event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
        repository: process.env.GITHUB_REPOSITORY, currentRun: process.env.GITHUB_RUN_ID, expectedKey: process.env.EXPECTED_KEY });
    } catch (error) { console.warn(`Artifact discovery unavailable; compile reviewed source: ${stripVTControlCharacters(error.message).split('\n')[0]}`); }
    if (result) {
      console.log(`Recover development engine from successful producer ${result.runID}/${result.jobID} (${result.manifestSha256}).`);
      await appendFile(process.env.GITHUB_OUTPUT, `run-id=${result.runID}\nmanifest-sha256=${result.manifestSha256}\n`);
    } else console.log('No matching same-PR producer found; compile reviewed source.');
  } else if (process.argv[2] === 'verify-pin') await verifyRecoveryPin(process.argv[3], process.env.EXPECTED_MANIFEST_SHA256);
  else throw new Error('Use find or verify-pin <downloaded distribution>');
}
