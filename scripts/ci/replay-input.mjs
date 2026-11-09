// Only allow the frozen, reviewable PR list to select a nonpublishing timing run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import cases from './fixtures/merge-replay-50.json' with { type: 'json' };

const inputs = JSON.parse(process.env.DISPATCH_INPUTS);
for (const [key, value] of Object.entries(inputs)) {
  if (key !== 'replay_pr') assert.ok([undefined, null, '', false, 'false'].includes(value), 'Replay cannot be combined with ' + key);
}
const sample = cases.find(pr => String(pr.number) === inputs.replay_pr);
assert.ok(sample, 'Choose a PR number from the frozen replay cohort');
for (const sha of [sample.base, sample.head]) assert.match(sha, /^[a-f0-9]{40}$/);
execFileSync('git', ['fetch', '--filter=blob:none', '--no-tags', 'origin', sample.base, sample.head], { stdio: 'inherit' });
appendFileSync(process.env.GITHUB_OUTPUT, 'base=' + sample.base + '\nhead=' + sample.head + '\nevent=pull_request\n');
