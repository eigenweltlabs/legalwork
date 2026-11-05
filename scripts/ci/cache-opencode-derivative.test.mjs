import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { developmentCacheKey, verifyCachedEngine } from './cache-opencode-derivative.mjs';
import { writeFixtureDerivativeDistribution } from '../../packages/opencode-release/test-fixture.mjs';
import { sourceBuildIdentity } from '../../packages/opencode-release/build/prepare.mjs';
import { assembleDerivativeDistribution } from '../../packages/opencode-release/build/distribution.mjs';
import { macEntitlementsSha256 } from '../../packages/opencode-release/build/mac-signing.mjs';
import { sha256 } from '../../packages/opencode-release/build/candidate.mjs';
import recipe from '../../packages/opencode-release/build/recipe.json' with { type: 'json' };

test('build cache keys are exact and exclude production engines', () => {
  const identity = { mode: 'development', sourceKey: 'a'.repeat(64), targets: ['darwin-arm64'] };
  const key = developmentCacheKey(identity, { producer: '1' });
  assert.equal(key, developmentCacheKey(identity, { producer: '1' }));
  assert.notEqual(key, developmentCacheKey({ ...identity, sourceKey: 'b'.repeat(64) }, { producer: '1' }));
  assert.notEqual(key, developmentCacheKey({ ...identity, targets: ['linux-arm64'] }, { producer: '1' }));
  assert.notEqual(key, developmentCacheKey(identity, { producer: '2' }));
  assert.throws(() => developmentCacheKey({ ...identity, mode: 'production' }, {}), /Production/);
});

test('complete cached archives are verified without recompiling; tampering and missing receipts fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-engine-cache-'));
  try {
    const f = await writeFixtureDerivativeDistribution(root);
    const identity = await sourceBuildIdentity({ mode: 'development', targets: recipe.targets });
    // Supply genuine build metadata around tiny, explicitly non-executable
    // fixture bytes. Verification uses the production archive/provenance code.
    for (const build of f.builds) {
      const filename = path.join(build.directory, 'provenance.json');
      const provenance = JSON.parse(await readFile(filename, 'utf8'));
      provenance.build = { wrapperSha256: identity.files['build/candidate.mjs'],
        signingHelperSha256: identity.files['build/mac-signing.mjs'], signingEntitlementsSha256: macEntitlementsSha256,
        recipeSha256: identity.files['build/recipe.json'], buildSha256: provenance.binary.sha256 };
      const bytes = JSON.stringify(provenance) + '\n';
      await writeFile(filename, bytes); build.provenanceSha256 = sha256(bytes);
      const binary = build.target.startsWith('windows-') ? 'opencode.exe' : 'opencode';
      await writeFile(path.join(build.directory, 'SHA256SUMS'), `${provenance.binary.sha256}  ${binary}\n${sha256(bytes)}  provenance.json\n`);
    }
    await rm(f.archives, { recursive: true });
    const manifestPath = path.join(root, 'derivative-release.json');
    const result = await assembleDerivativeDistribution({ builds: f.builds, outputDirectory: f.archives, manifestPath, onProgress: () => {} });
    const receipt = path.join(root, 'distribution-receipt.json');
    await writeFile(receipt, JSON.stringify(result));
    const verified = await verifyCachedEngine(root);
    assert.equal(verified.manifestSha256, result.manifestSha256);
    assert.equal(verified.targets.length, 12);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const archive = path.join(f.archives, manifest.artifacts[recipe.targets[0]].archive.filename);
    await writeFile(archive, 'corrupted archive');
    await assert.rejects(verifyCachedEngine(root), /corrupt/);
    await rm(receipt);
    await assert.rejects(verifyCachedEngine(root), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
