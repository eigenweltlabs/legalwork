// Preview by default. An administrator can activate the queue after its handler lands.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function queuedRuleset(current) {
  assert.equal(current.target, 'branch');
  assert.equal(current.enforcement, 'active');
  assert.deepEqual(current.conditions.ref_name, { include: ['refs/heads/dev'], exclude: [] });
  assert.ok(Array.isArray(current.bypass_actors), 'Use a ruleset response with visible bypass permissions');
  const { name, enforcement, target, conditions, bypass_actors, rules } = structuredClone(current);
  const required = rules.find(rule => rule.type === 'required_status_checks')?.parameters;
  assert.deepEqual(required?.required_status_checks.map(check => check.context).sort(),
    ['legalwork-tests (macos-14)', 'legalwork-tests (ubuntu-latest)'],
    'Every required check must report on merge_group before enabling the queue');
  assert.ok(rules.find(rule => rule.type === 'pull_request')?.parameters.allowed_merge_methods.includes('squash'));
  required.strict_required_status_checks_policy = false;
  if (!rules.some(rule => rule.type === 'merge_queue')) {
    rules.push({ type: 'merge_queue', parameters: {
      grouping_strategy: 'ALLGREEN', merge_method: 'SQUASH', max_entries_to_build: 3,
      min_entries_to_merge: 1, max_entries_to_merge: 3, min_entries_to_merge_wait_minutes: 0,
      check_response_timeout_minutes: 120,
    } });
  }
  return { name, enforcement, target, conditions, bypass_actors, rules };
}

const api = 'repos/eigenweltlabs/legalwork';
const ruleset = api + '/rulesets/18320382';
const handler = '.github/workflows/ci-tests.yml';

export function enableDevQueue(gh, handlerContent) {
  const liveHandler = Buffer.from(JSON.parse(gh(['api', api + '/contents/' + handler + '?ref=dev'])).content, 'base64');
  assert.ok(liveHandler.equals(handlerContent) && /^  merge_group:\s*\n    types: \[checks_requested\]\s*\n    branches: \[dev\]/m.test(handlerContent.toString()),
    'Run from the landed dev checkout with the current merge-group handler');
  const current = JSON.parse(gh(['api', ruleset]));
  const payload = queuedRuleset(current);
  if (JSON.stringify(current.rules) !== JSON.stringify(payload.rules)) {
    gh(['api', '--method', 'PUT', ruleset, '--input', '-'], JSON.stringify(payload));
  }
  const active = JSON.parse(gh(['api', ruleset]));
  assert.deepEqual(queuedRuleset(active).rules, active.rules);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 2) console.log(JSON.stringify(queuedRuleset(JSON.parse(readFileSync(0, 'utf8'))), null, 2));
  else {
    assert.deepEqual(process.argv.slice(2), ['--enable']);
    const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input });
    enableDevQueue(gh, readFileSync(new URL('../../' + handler, import.meta.url)));
    console.log('Verified the dev merge queue and required checks.');
  }
}
