// Full native verification already succeeded. Reuse the original delivery
// artifacts only while the complete handoff is still retained and unambiguous.
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readGitHubApi } from './recover-opencode-artifact.mjs';

export const deliveryArtifacts = ['opencode-derivative-ci', ...['macOS', 'Linux', 'Windows'].map(os => 'opencode-derivative-ci-' + os)];

export function retainedProductionHandoff({ repository, sourceRun, currentRun, now = Date.now() }, read = readGitHubApi) {
  assert.equal(repository, 'eigenweltlabs/legalwork');
  for (const value of [sourceRun, currentRun]) assert.match(value, /^[1-9][0-9]*$/);
  assert.notEqual(sourceRun, currentRun);
  const artifacts = [];
  for (let page = 1; ; page++) {
    const data = JSON.parse(read(`repos/${repository}/actions/runs/${sourceRun}/artifacts?per_page=100&page=${page}`));
    artifacts.push(...data.artifacts);
    if (data.artifacts.length < 100) break;
  }
  // Leave an hour for consumers to download before expiration. A missing,
  // expired or ambiguous family simply uses fresh current-run uploads.
  return deliveryArtifacts.every(name => {
    const matches = artifacts.filter(artifact => artifact.name === name);
    return matches.length === 1 && matches[0].expired === false
      && Number.isSafeInteger(matches[0].id) && matches[0].id > 0
      && Date.parse(matches[0].expires_at) > now + 60 * 60 * 1000;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let reuse = false;
  if (process.env.PRODUCTION_SOURCE_RUN) {
    assert.match(process.env.VERIFIED_MANIFEST_SHA256, /^[a-f0-9]{64}$/, 'Handoff requires the current full verification pin');
    try {
      reuse = retainedProductionHandoff({ repository: process.env.GITHUB_REPOSITORY,
        sourceRun: process.env.PRODUCTION_SOURCE_RUN, currentRun: process.env.GITHUB_RUN_ID });
    } catch (error) { console.warn('Retained delivery unavailable; upload the fully verified current distribution: ' + error.message.split('\n')[0]); }
  }
  const runID = reuse ? process.env.PRODUCTION_SOURCE_RUN : process.env.GITHUB_RUN_ID;
  assert.match(runID, /^[1-9][0-9]*$/);
  await appendFile(process.env.GITHUB_OUTPUT, `reuse=${reuse}\nrun-id=${runID}\n`);
  console.log(`Verified engine handoff: run ${runID}; reuse retained delivery=${reuse}.`);
}
