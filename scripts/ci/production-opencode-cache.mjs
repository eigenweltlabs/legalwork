// Immutable production artifacts are a cache; their producer logs supply the
// independent manifest pin. Development/PR artifacts cannot nominate releases.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { prepareOpencodeEngine, sourceBuildIdentity } from '../../packages/opencode-release/build/prepare.mjs';
import recipe from '../../packages/opencode-release/build/recipe.json' with { type: 'json' };
import { readGitHubApi, verifyRecoveryPin } from './recover-opencode-artifact.mjs';

const productionWorkflows = new Set(['alpha-macos-aarch64', 'alpha-windows-x64', 'release-macos-aarch64']
  .map(name => `.github/workflows/${name}.yml`));
export const productionVerificationStep = 'Verify all production archives and signatures against current source policy';

export function productionCacheKey(identity, helpers) {
  assert.equal(identity.mode, 'production', 'Production cache requires production intent');
  assert.match(identity.sourceKey, /^[a-f0-9]{64}$/);
  assert.deepEqual([...identity.targets].sort(), [...recipe.targets].sort(), 'Production cache requires all twelve targets');
  return 'opencode-production-v1-' + createHash('sha256').update(JSON.stringify({ identity, helpers })).digest('hex');
}

export function eligibleProductionRun(run, { repository, currentRun, event, branch }) {
  if (repository !== 'eigenweltlabs/legalwork' || !Number.isSafeInteger(run.id) || run.id <= 0
    || run.id === Number(currentRun) || run.status !== 'completed' || run.head_repository?.full_name !== repository
    || !productionWorkflows.has(run.path)) return false;
  if (run.event === 'push') return run.head_branch === 'dev';
  if (run.event === 'release') return run.path === '.github/workflows/release-macos-aarch64.yml';
  // A manual branch benchmark can consume that same branch's production build;
  // dev/tag publication can never consume a PR branch's cached producer.
  return run.event === 'workflow_dispatch' && (run.head_branch === 'dev'
    || event === 'workflow_dispatch' && typeof branch === 'string' && branch.length > 0 && run.head_branch === branch);
}

export function productionProducerProof(log, expectedKey) {
  assert.match(expectedKey, /^opencode-production-v1-[a-f0-9]{64}$/);
  log = stripVTControlCharacters(log);
  const keys = new Set([...log.matchAll(/^\S+ production-cache-key=(opencode-production-v1-[a-f0-9]{64})\r?$/gm)].map(match => match[1]));
  const pins = new Set([...log.matchAll(/^\S+ manifest-sha256=([a-f0-9]{64})\r?$/gm)].map(match => match[1]));
  return keys.size === 1 && keys.has(expectedKey) && pins.size === 1 ? [...pins][0] : undefined;
}

export async function findProductionCache(context, read = readGitHubApi) {
  assert.match(context.expectedKey, /^opencode-production-v1-[a-f0-9]{64}$/);
  assert.equal(context.repository, 'eigenweltlabs/legalwork');
  assert.ok(['push', 'release', 'workflow_dispatch'].includes(context.event), 'PRs cannot select production artifacts');
  const root = `repos/${context.repository}/actions/`;
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ name: context.expectedKey, per_page: '100', page: String(page) });
    const data = JSON.parse(read(root + 'artifacts?' + query));
    for (const artifact of data.artifacts) {
      if (artifact.expired !== false || artifact.name !== context.expectedKey || !Number.isSafeInteger(artifact.id)) continue;
      const runID = artifact.workflow_run?.id;
      if (!Number.isSafeInteger(runID) || runID <= 0 || runID === Number(context.currentRun)) continue;
      const run = JSON.parse(read(root + `runs/${runID}`));
      if (!eligibleProductionRun(run, context)) continue;
      const jobs = JSON.parse(read(root + `runs/${runID}/jobs?per_page=100`));
      if (jobs.jobs.length !== jobs.total_count) continue;
      const producer = jobs.jobs.find(job => job.name === 'opencode-engine / build' && job.status === 'completed'
        && job.conclusion === 'success' && job.steps?.some(step => step.name === productionVerificationStep && step.conclusion === 'success'));
      if (!producer) continue;
      const pin = productionProducerProof(read(root + `jobs/${producer.id}/logs`), context.expectedKey);
      if (pin) return { runID: String(runID), jobID: producer.id, artifactID: artifact.id, manifestSha256: pin };
    }
    if (data.artifacts.length < 100) return;
  }
}

export async function verifyProductionEngine(directory, manifestSha256) {
  assert.equal(process.platform, 'darwin', 'Production verification must execute native Apple signature checks');
  await verifyRecoveryPin(directory, manifestSha256);
  const outputDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'opencode-production-check-')));
  try {
    return await prepareOpencodeEngine({ mode: 'production', targets: recipe.targets, outputDirectory,
      distributionDirectory: directory, manifestSha256 });
  } finally { await rm(outputDirectory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output;
  if (process.argv[2] === 'key') {
    const identity = await sourceBuildIdentity({ mode: 'production', targets: recipe.targets });
    const helpers = {};
    for (const name of ['production-opencode-cache.mjs', 'build-opencode-derivative.mjs']) {
      helpers[name] = createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex');
    }
    const key = productionCacheKey(identity, helpers);
    output = `key=${key}\n`;
    console.log(`production-cache-key=${key}`);
  } else if (process.argv[2] === 'find') {
    let result;
    if (process.env.FORCE_REBUILD !== 'true') {
      try {
        result = await findProductionCache({ repository: process.env.GITHUB_REPOSITORY, currentRun: process.env.GITHUB_RUN_ID,
          event: process.env.GITHUB_EVENT_NAME, branch: process.env.GITHUB_REF_NAME, expectedKey: process.env.EXPECTED_KEY });
      } catch (error) { console.warn(`Production artifact discovery unavailable: ${stripVTControlCharacters(error.message).split('\n')[0]}`); }
    }
    assert.ok(result || process.env.REQUIRE_CACHE_HIT !== 'true', 'A verified production cache hit is required for this benchmark');
    output = result ? `cache-hit=true\nrun-id=${result.runID}\nmanifest-sha256=${result.manifestSha256}\n` : 'cache-hit=false\n';
    console.log(result ? `Production cache hit: producer ${result.runID}/${result.jobID}, artifact ${result.artifactID}, manifest ${result.manifestSha256}.`
      : 'Production cache miss: compile and sign the current reviewed engine.');
    const receipt = process.env.PRODUCTION_CACHE_LOOKUP;
    if (receipt) await writeFile(receipt, JSON.stringify({ key: process.env.EXPECTED_KEY, hit: Boolean(result), ...result }) + '\n', { flag: 'wx' });
  } else if (process.argv[2] === 'verify') {
    const verified = await verifyProductionEngine(path.resolve(process.argv[3]), process.env.EXPECTED_MANIFEST_SHA256);
    output = `manifest-sha256=${verified.manifestSha256}\n`;
    console.log(output.trim());
  } else throw new Error('Use key, find or verify <production-distribution-directory>');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
}
