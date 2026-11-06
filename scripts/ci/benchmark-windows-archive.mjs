// Compare the real differential NSIS payload archiver, retaining byte equality.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const builder = createRequire(require.resolve('electron-builder'));
const { archive, compute7zCompressArgs } = builder('app-builder-lib/out/targets/archive.js');
const { configureDifferentialAwareArchiveOptions } = builder('app-builder-lib/out/targets/differentialUpdateInfoBuilder.js');
const { getPath7za } = builder('app-builder-lib/out/toolsets/7zip.js');
const [directory, arch] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(directory && ['x64', 'arm64'].includes(arch) && process.env.RUNNER_TEMP);
const output = path.join(process.env.RUNNER_TEMP, 'windows-archive-benchmark');
await mkdir(output, { recursive: true });
const sevenZip = await getPath7za();
const extract = (source, destination) => execFileSync(sevenZip, ['x', source, `-o${destination}`, '-y'], { stdio: 'inherit' });
const installers = (await readdir(directory)).filter(name => name.endsWith('.exe'));
assert.equal(installers.length, 1);
const installer = path.join(directory, installers[0]);
extract(installer, path.join(output, 'installer'));

async function files(directory) {
  const result = [];
  for (const entry of (await readdir(directory)).sort()) {
    const filename = path.join(directory, entry), metadata = await lstat(filename);
    assert.ok(!metadata.isSymbolicLink(), 'Installer comparison rejects links');
    if (metadata.isDirectory()) result.push(...await files(filename));
    else { assert.ok(metadata.isFile()); result.push(filename); }
  }
  return result;
}
async function payload(directory) {
  const result = {};
  for (const filename of await files(directory)) {
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(filename)) digest.update(bytes);
    result[path.relative(directory, filename).replaceAll('\\', '/')] = digest.digest('hex');
  }
  return result;
}
const archives = (await files(path.join(output, 'installer'))).filter(name => /\.7z$/.test(name));
assert.equal(archives.length, 1, 'The signed NSIS installer must have one embedded native payload');
const source = path.join(output, 'payload');
extract(archives[0], source);
const expected = await payload(source);
assert.ok(expected['LegalWork.exe'] && expected['resources/app.asar']);
const payloadManifestSha256 = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
const results = [];
// Reverse the order for a second pair to expose filesystem warm-up effects.
for (const [index, level] of ['9', '5', '5', '9'].entries()) {
  process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = level;
  const options = configureDifferentialAwareArchiveOptions({ withoutDir: true, installTimeDecodable: true });
  const args = compute7zCompressArgs('7z', options);
  assert.ok(args.includes('-mf=BCJ') && args.includes('-md=1m') && args.includes('-ms=off'));
  const destination = path.join(output, `sample-${index}.7z`);
  const started = performance.now();
  await archive('7z', destination, source, options);
  const durationMs = Math.round(performance.now() - started);
  const extracted = path.join(output, `extracted-${index}`);
  extract(destination, extracted);
  assert.deepEqual(await payload(extracted), expected, 'Every compressed payload file must preserve its exact bytes');
  results.push({ level: Number(level), durationMs, bytes: (await lstat(destination)).size, args });
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ arch,
    sourceRunId: 42058781441, sourceHead: '5cc60428b483f03e7aff144492e18a81c33c0719',
    payloadManifestSha256, verifiedFiles: Object.keys(expected).length, results }, null, 2) + '\n');
  await rm(extracted, { recursive: true });
  await rm(destination);
}
assert.deepEqual(await payload(source), expected, 'The immutable input changed');
const average = (level, field) => results.filter(row => row.level === level).reduce((sum, row) => sum + row[field], 0) / 2;
assert.ok(average(5, 'bytes') <= average(9, 'bytes') * 1.10, 'Faster compression must keep download growth below 10%');
console.log(JSON.stringify({ arch, oldMs: average(9, 'durationMs'), newMs: average(5, 'durationMs'), sizeRatio: average(5, 'bytes') / average(9, 'bytes') }));
