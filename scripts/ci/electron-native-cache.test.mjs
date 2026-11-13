import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { electronNativeCacheKey, restoreElectronNativeCache, sealElectronNativeCache } from '../../apps/desktop/scripts/electron-native-cache.mjs';

test('Electron addon identity separates ABI, architecture, source, tools and settings', () => {
  const identity = { platform: 'win32', arch: 'arm64', electron: '43.8.3', abi: '160', source: 'one', compiler: 'one', settings: 'one' };
  const key = electronNativeCacheKey(identity);
  for (const change of [{ electron: '43.8.4' }, { abi: '161' }, { arch: 'x64' }, { source: 'two' }, { compiler: 'two' }, { settings: 'two' }]) {
    assert.notEqual(electronNativeCacheKey({ ...identity, ...change }), key);
  }
  assert.throws(() => electronNativeCacheKey({ ...identity, platform: 'linux' }));
});

test('native reuse verifies the complete binary/marker before replacing installed output', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'electron-native-cache-'));
  const source = path.join(root, 'source'), cache = path.join(root, 'cache'), destination = path.join(root, 'destination');
  try {
    mkdirSync(source); mkdirSync(destination);
    writeFileSync(path.join(source, 'better_sqlite3.node'), 'native fixture');
    writeFileSync(path.join(source, '.forge-meta'), 'arm64--160');
    assert.equal(restoreElectronNativeCache(cache, destination, 'fixture'), false);
    sealElectronNativeCache(cache, source, 'fixture');
    assert.equal(restoreElectronNativeCache(cache, destination, 'fixture'), true);
    assert.equal(readFileSync(path.join(destination, 'better_sqlite3.node'), 'utf8'), 'native fixture');
    assert.throws(() => restoreElectronNativeCache(cache, destination, 'other'), /inputs changed/);
    writeFileSync(path.join(destination, 'better_sqlite3.node'), 'installed sentinel');
    writeFileSync(path.join(cache, 'better_sqlite3.node'), 'corrupt');
    assert.throws(() => restoreElectronNativeCache(cache, destination, 'fixture'), /Corrupt/);
    assert.equal(readFileSync(path.join(destination, 'better_sqlite3.node'), 'utf8'), 'installed sentinel');
    rmSync(path.join(cache, 'better_sqlite3.node'));
    symlinkSync(path.join(source, 'better_sqlite3.node'), path.join(cache, 'better_sqlite3.node'));
    assert.throws(() => restoreElectronNativeCache(cache, destination, 'fixture'));
    assert.throws(() => sealElectronNativeCache(cache, source, 'fixture'), /overwrite/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
