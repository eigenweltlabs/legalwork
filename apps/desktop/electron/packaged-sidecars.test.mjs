import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
const require = createRequire(import.meta.url);
const afterPack = require('../scripts/electron-after-pack.cjs');
const { Arch } = require('electron-builder');

for (const [platform, configKey, arch, triple, suffix] of [
  ['linux', 'linux', Arch.arm64, 'aarch64-unknown-linux-gnu', ''],
  ['win32', 'win', Arch.x64, 'x86_64-pc-windows-msvc', '.exe'],
]) test(`real numeric ${platform} architecture selects only prepared and filtered sidecars`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'packaged-sidecars-'));
  try {
    const sidecars = join(root, 'resources', 'sidecars');
    await mkdir(sidecars, { recursive: true });
    const config = parse(await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
    const filters = config[configKey].extraResources.find(item => item.to === 'sidecars').filter;
    for (const base of ['opencode', 'legalwork-orchestrator']) {
      const name = `${base}-${triple}${suffix}`;
      assert.ok(filters.includes(name));
      await writeFile(join(sidecars, name), base);
    }
    await writeFile(join(sidecars, `versions.json-${triple}${suffix}`), '{"fixture":true}');
    await writeFile(join(sidecars, 'wrong-architecture'), 'do not ship');
    await afterPack({ electronPlatformName: platform, arch, appOutDir: root });
    for (const base of ['opencode', 'legalwork-orchestrator']) assert.equal(await readFile(join(sidecars, base + suffix), 'utf8'), base);
    assert.equal(await readFile(join(sidecars, 'versions.json'), 'utf8'), '{"fixture":true}');
    assert.equal((await readdir(sidecars)).length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});
