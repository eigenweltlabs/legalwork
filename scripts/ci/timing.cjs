const { appendFileSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { performance } = require('node:perf_hooks');

function recordSpan(name, started, fields = {}) {
  const span = { kind: 'ci-span', name, durationMs: Math.round(performance.now() - started), ...fields };
  console.log(JSON.stringify(span));
  const filename = process.env.LEGALWORK_CI_TIMINGS || (process.env.RUNNER_TEMP && join(process.env.RUNNER_TEMP, 'ci-spans.jsonl'));
  if (filename) {
    mkdirSync(dirname(filename), { recursive: true });
    appendFileSync(filename, JSON.stringify(span) + '\n');
  }
}

module.exports = { recordSpan };
