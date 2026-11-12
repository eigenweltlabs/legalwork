// A coalesced push may replace another pending push. Diff against the last
// candidate that actually published all three targets, including skipped pushes.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { changeScope } from './change-scope.mjs';
import { changedPaths } from './sandbox-changes.mjs';

export const alphaTargets = ['aarch64-apple-darwin', 'aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc'];
export function signedJobs(jobs) {
  return alphaTargets.map(target => jobs.find(job => job.name === 'Build + Publish alpha (' + target + ')'));
}
export function lastPublished(runs, jobsFor, ancestor) {
  for (const run of runs) {
    if (run.event !== 'push' || run.head_branch !== 'dev' || run.conclusion !== 'success' || !ancestor(run.head_sha)) continue;
    if (signedJobs(jobsFor(run.id)).every(job => job?.conclusion === 'success'
      && job.steps.some(step => step.name === 'Publish complete alpha' && step.conclusion === 'success'))) return run.head_sha;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let build = true;
  if (process.env.DIRECT_ALPHA === 'false') {
    const api = route => JSON.parse(execFileSync('gh', ['api', 'repos/{owner}/{repo}/actions/' + route], { encoding: 'utf8' }));
    try {
      const head = process.env.GITHUB_SHA;
      const runs = api('workflows/alpha-macos-aarch64.yml/runs?branch=dev&event=push&status=success&per_page=12').workflow_runs;
      const base = lastPublished(runs, id => api('runs/' + id + '/jobs?per_page=100').jobs, sha => {
        if (!/^[a-f0-9]{40}$/.test(sha)) return false;
        try { execFileSync('git', ['merge-base', '--is-ancestor', sha, head]); return true; } catch { return false; }
      });
      if (base) build = changeScope(changedPaths(base, head, false)).alpha;
    } catch (error) { console.warn('Could not establish the last published alpha. Building this candidate.', error.message); }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, 'alpha=' + build + '\n');
}
