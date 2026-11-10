// Read-only. Pass Actions run IDs for a cohort, including failed runs.
// Measure elapsed time including GitHub scheduling and any rerun wait.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { signedJobs } from './alpha-candidate.mjs';
import cohort from './fixtures/merge-replay-50.json' with { type: 'json' };

export function gateTiming(run, jobs) {
  const elapsed = steps => Math.ceil((Math.max(...steps.map(step => Date.parse(step.completed_at))) - Date.parse(run.created_at)) / 1000);
  const replay = run.event === 'workflow_dispatch' && run.display_title?.startsWith('Merge gate replay #');
  if (run.event === 'pull_request' || run.event === 'merge_group' || replay) {
    const required = ['ubuntu-latest', 'macos-14'].map(os => jobs.find(job => job.name === 'legalwork-tests (' + os + ')'));
    return { kind: replay ? 'replay' : run.event, seconds: required.every(job => job?.conclusion === 'success') ? elapsed(required) : null };
  }
  const production = run.event === 'push' && run.head_branch === 'dev';
  if (run.path !== '.github/workflows/alpha-macos-aarch64.yml' || (!production && run.event !== 'workflow_dispatch')) return null;
  const download = jobs.find(job => job.name === 'opencode-engine / build')?.steps?.find(
    step => step.name === 'Download the independently pinned production engine cache');
  if (!download || !['success', 'failure', 'cancelled', 'timed_out'].includes(download.conclusion)) return null;
  const packages = signedJobs(jobs);
  // An engine-only dispatch skips version selection and every packaging job by design.
  if (!production && ![...packages, jobs.find(job => job.name === 'portable-version')]
    .some(job => job && job.conclusion !== 'skipped')) return null;
  const signed = packages.map((job, index) => {
    const passed = name => job?.steps?.find(step => step.name === name && step.conclusion === 'success');
    if (!passed(index ? 'Verify signed Windows artifacts' : 'Package Electron alpha (macOS, signed + notarized)')) return undefined;
    return passed('Publish complete alpha') || (!production && passed(index ? 'Upload signed Windows test artifacts' : 'Upload signed Mac test artifacts'));
  });
  return { kind: production ? 'warm-alpha' : 'warm-benchmark', seconds: signed.every(Boolean) ? elapsed(signed) : null };
}

// A red step that goes green on a rerun of the identical commit is a triage
// signal. Keep the original failure visible and never retry it automatically.
export function recoveredSteps(first, latest) {
  const passed = new Set(latest.filter(job => job.conclusion === 'success').map(job => job.name));
  return first.filter(job => job.conclusion === 'failure' && passed.has(job.name))
    .flatMap(job => (job.steps ?? []).filter(step => step.conclusion === 'failure')
      .map(step => ({ job: job.name, step: step.name })));
}

// Each revision gets its own denominator. A second dispatch of a slow or red
// sample cannot replace the first observation for the same revision.
export function replayScores(rows, cases = cohort) {
  const scores = {};
  const replays = rows.filter(row => row.kind === 'replay').sort((a, b) => Number(a.id) - Number(b.id));
  for (const head of new Set(replays.map(row => row.head))) {
    const first = new Map();
    for (const row of replays.filter(row => row.head === head)) if (!first.has(row.pr)) first.set(row.pr, row);
    const score = { total: cases.length, withinFiveMinutes: 0, late: [], failed: [], unmeasured: [] };
    for (const { number } of cases) {
      const row = first.get(number);
      if (!row) score.unmeasured.push(number);
      else if (row.seconds === null) score.failed.push(number);
      else if (row.seconds > 300) score.late.push(number);
      else score.withinFiveMinutes++;
    }
    scores[head] = score;
  }
  return scores;
}

export function alphaRunsSince(since, api) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since) || !Number.isFinite(Date.parse(since)))
    throw Error('Use a UTC rollout timestamp such as 2026-11-10T12:00:00Z');
  const query = new URLSearchParams({ branch: 'dev', event: 'push', status: 'completed', created: '>=' + since, per_page: '100' });
  const runs = [];
  for (let page = 1; ; page++) {
    const batch = api('workflows/alpha-macos-aarch64.yml/runs?' + query + '&page=' + page);
    if (batch.total_count > 1000) throw Error('More than 1,000 matching runs. Choose a later start for an uncapped measurement.');
    runs.push(...batch.workflow_runs);
    if (page * 100 >= batch.total_count) {
      if (new Set(runs.map(run => run.id)).size !== batch.total_count || runs.length !== batch.total_count)
        throw Error('The run list changed during pagination. Measure the cohort again.');
      return runs;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const api = endpoint => JSON.parse(execFileSync('gh', ['api', 'repos/{owner}/{repo}/actions/' + endpoint], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  const alphaSince = args.length === 2 && args[0] === '--alpha-since';
  if (!alphaSince && (!args.length || args.some(id => !/^\d+$/.test(id)) || new Set(args).size !== args.length))
    throw Error('Pass unique Actions run IDs or --alpha-since UTC_TIMESTAMP');
  const runs = alphaSince ? alphaRunsSince(args[1], api) : args.map(id => api('runs/' + id));
  const rows = runs.map(run => {
    const id = String(run.id);
    const jobsFor = prefix => {
      const jobs = [];
      for (let page = 1; ; page++) {
        const batch = api(prefix + '/jobs?per_page=100&page=' + page).jobs;
        jobs.push(...batch);
        if (batch.length < 100) return jobs;
      }
    };
    const jobs = jobsFor('runs/' + id);
    const recovered = run.run_attempt > 1 ? recoveredSteps(jobsFor('runs/' + id + '/attempts/1'), jobs) : [];
    const timing = gateTiming(run, jobs);
    const pr = timing?.kind === 'replay' ? Number(run.display_title.match(/^Merge gate replay #(\d+)$/)?.[1]) : run.pull_requests?.[0]?.number;
    return { id, head: run.head_sha, pr, attempt: run.run_attempt, recovered, ...timing };
  });
  const summary = alphaSince ? { 'warm-alpha': { targetSeconds: 1800, total: 0, withinTarget: 0 } } : {};
  for (const row of rows.filter(row => row.kind)) {
    const target = row.kind.startsWith('warm') ? 1800 : 300;
    const bucket = summary[row.kind] ??= { targetSeconds: target, total: 0, withinTarget: 0 };
    bucket.total++;
    if (row.seconds !== null && row.seconds <= target) bucket.withinTarget++;
  }
  console.log(JSON.stringify({ rows, summary, cohorts: replayScores(rows) }, null, 2));
}
