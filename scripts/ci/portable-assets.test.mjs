import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { portableFiles } from './portable-assets.mjs';

test('portable assets cover both entrypoints and reject missing files or linked outputs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'portable-assets-'));
  try {
    for (const name of ['dist', 'dist-word-addin']) mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, 'dist/index.html'), 'renderer');
    assert.throws(() => portableFiles(root), /entrypoints/);
    writeFileSync(path.join(root, 'dist-word-addin/taskpane.html'), 'office');
    const before = portableFiles(root);
    writeFileSync(path.join(root, 'dist/index.html'), 'tampered renderer');
    assert.notDeepEqual(portableFiles(root), before);
    symlinkSync(path.join(root, 'dist/index.html'), path.join(root, 'dist/linked.html'));
    assert.throws(() => portableFiles(root), /links/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
