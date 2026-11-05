// Development-only build reuse. Production signing always starts from source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareOpencodeEngine, sourceBuildIdentity } from '../../packages/opencode-release/build/prepare.mjs';
import recipe from '../../packages/opencode-release/build/recipe.json' with { type: 'json' };

export function developmentCacheKey(identity, helpers) {
  assert.equal(identity.mode, 'development', 'Production engines cannot use a development cache');
  assert.match(identity.sourceKey, /^[a-f0-9]{64}$/);
  const digest = createHash('sha256').update(JSON.stringify({ identity, helpers })).digest('hex');
  return `opencode-development-v1-${digest}`;
}

export async function verifyCachedEngine(directory) {
  const receiptPath = path.join(directory, 'distribution-receipt.json');
  assert.ok((await lstat(receiptPath)).isFile(), 'Build receipt must be an ordinary file');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/);
  const outputDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'opencode-cache-check-')));
  try {
    // The existing preparation verifier checks every archive, provenance record,
    // current patch/recipe/compiler pin, and complete target coverage. Cached
    // receipts never nominate source policy or publish a production selector.
    return await prepareOpencodeEngine({ mode: 'development', targets: recipe.targets,
      outputDirectory, distributionDirectory: directory, manifestSha256: receipt.manifestSha256 });
  } finally { await rm(outputDirectory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output;
  if (process.argv[2] === 'key') {
    const identity = await sourceBuildIdentity({ mode: 'development', targets: recipe.targets });
    const helpers = {};
    for (const name of ['cache-opencode-derivative.mjs', 'build-opencode-derivative.mjs']) {
      helpers[name] = createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex');
    }
    output = `key=${developmentCacheKey(identity, helpers)}\n`;
  } else if (process.argv[2] === 'verify' && process.argv[3]) {
    const result = await verifyCachedEngine(path.resolve(process.argv[3]));
    output = `manifest-sha256=${result.manifestSha256}\n`;
  } else throw new Error('Use key or verify <development-distribution-directory>');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
  console.log(output);
}
