import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const receiptPath = path.join(root, 'apps/app/portable-ui-receipt.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function identity() {
  return { version: JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version,
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')).sort()),
    electron: true, mode: 'production' };
}
export function portableFiles(appRoot) {
  const files = {};
  function visit(relative) {
    for (const entry of readdirSync(path.join(appRoot, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name), source = path.join(appRoot, name);
      assert.ok(!entry.isSymbolicLink(), 'Portable build outputs cannot contain links');
      if (entry.isDirectory()) visit(name);
      else { assert.ok(lstatSync(source).isFile()); files[name] = hash(readFileSync(source)); }
    }
  }
  visit('dist'); visit('dist-word-addin');
  assert.ok(files['dist/index.html'] && files['dist-word-addin/taskpane.html'], 'Both portable app entrypoints are required');
  return Object.fromEntries(Object.entries(files).sort());
}
export function verifyPortableAssets() {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.deepEqual(receipt.identity, identity(), 'Portable assets must match this exact source, version and build environment');
  assert.deepEqual(receipt.files, portableFiles(path.join(root, 'apps/app')), 'Portable assets changed after their producer sealed them');
  console.log(`Verified ${Object.keys(receipt.files).length} portable renderer and Office assets`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'seal') writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, identity: identity(), files: portableFiles(path.join(root, 'apps/app')) }) + '\n');
  else if (process.argv[2] === 'verify') verifyPortableAssets();
  else throw new Error('Use seal|verify after producing both portable builds');
}
