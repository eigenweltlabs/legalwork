// Compare the real release archiver on one immutable, already packaged app.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import timing from './timing.cjs';

const [directory, arch] = process.argv.slice(2);
assert.equal(process.platform, 'linux');
assert.ok(directory && ['x64', 'arm64'].includes(arch), 'Use <packaged directory> x64|arm64');
assert.ok(process.env.RUNNER_TEMP, 'A GitHub runner temporary directory is required');
const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(process.env.RUNNER_TEMP, 'linux-archive-benchmark');
await mkdir(output, { recursive: true });
const manifest = path.join(output, 'payload.json');
const helper = path.join(root, 'scripts/ci/archive-payload.py');
execFileSync('python3', [helper, 'seal', path.resolve(directory), manifest], { stdio: 'inherit' });
const payloadManifestSha256 = createHash('sha256').update(await readFile(manifest)).digest('hex');
const results = [];
for (const level of ['9', '6']) {
  const destination = path.join(output, `level-${level}`);
  const args = ['--dir', 'apps/desktop', 'exec', 'electron-builder', '--config', 'electron-builder.yml',
    '--linux', 'tar.gz', `--${arch}`, '--prepackaged', path.resolve(directory),
    `--config.directories.output=${destination}`, '--publish', 'never'];
  const started = performance.now();
  const child = spawn('pnpm', args, { cwd: root, stdio: 'inherit',
    env: { ...process.env, ELECTRON_BUILDER_COMPRESSION_LEVEL: level } });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Archive level ${level} failed (${signal ?? code})`)));
  });
  const durationMs = Math.round(performance.now() - started);
  const archives = (await readdir(destination)).filter(name => name.endsWith('.tar.gz'));
  assert.equal(archives.length, 1, 'Each comparison must produce exactly one release tarball');
  const archive = path.join(destination, archives[0]);
  execFileSync('python3', [helper, 'verify', archive, manifest], { stdio: 'inherit' });
  const result = { level: Number(level), durationMs, bytes: (await stat(archive)).size, arch, payloadManifestSha256 };
  timing.recordSpan('linux-release-tar-gzip', started, result);
  results.push(result);
  // Retain partial measurements if the next sample fails.
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    version: JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8')).version,
    payloadManifestSha256, results,
  }, null, 2) + '\n');
}
assert.ok(results[1].bytes <= results[0].bytes * 1.10, 'Faster compression must not increase download size by more than 10%');
execFileSync('python3', [helper, 'seal', path.resolve(directory), path.join(output, 'payload-after.json')], { stdio: 'inherit' });
assert.deepEqual(await readFile(path.join(output, 'payload-after.json')), await readFile(manifest), 'The packaged input changed during the comparison');
