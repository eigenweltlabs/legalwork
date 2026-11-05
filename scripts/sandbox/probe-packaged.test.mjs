import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(new URL('./probe-packaged.mjs', import.meta.url));
const probe = fileURLToPath(new URL('./probe.mjs', import.meta.url));
async function fixture(platform, run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'legalwork-packaged-probe-')));
  try {
    const bundle = join(root, 'LegalWork.app');
    const executable = platform === 'darwin' ? join(bundle, 'Contents', 'MacOS', 'LegalWork')
      : join(root, platform === 'win32' ? 'LegalWork.exe' : 'legalwork');
    const resources = platform === 'darwin' ? join(bundle, 'Contents', 'Resources') : join(root, 'resources');
    const node = join(resources, 'node', platform === 'win32' ? 'node.exe' : 'node');
    await mkdir(dirname(executable), { recursive: true }); await writeFile(executable, 'fixture app');
    await mkdir(dirname(node), { recursive: true }); await writeFile(node, 'fixture bundled Node');
    const preload = join(root, 'preload.mjs');
    // Intercept only this fixture child's launch seam. No VM, app or substitute
    // host Node is executed; the real CLI must select the expected shipped path.
    await writeFile(preload, `import assert from 'node:assert/strict';import cp from 'node:child_process';import{realpathSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';
      Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
      cp.spawnSync=(command,args,options)=>{assert.equal(realpathSync(command),process.env.LEGALWORK_PROBE_EXPECTED_NODE);assert.deepEqual(args,${JSON.stringify([probe, join(resources, 'agent-sandbox')])});assert.equal(options.timeout,300000);assert.equal(options.windowsHide,true);console.log('bundled Node probe selected');return{status:0}};syncBuiltinESMExports();`);
    const invoke = (target, expectedNode = node) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, target], { encoding: 'utf8', env: { ...process.env, LEGALWORK_PROBE_EXPECTED_NODE: expectedNode } });
    await run({ root, bundle, executable, resources, node, invoke });
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const platform of ['darwin', 'linux', 'win32']) test(`actual ${platform} packaged executable selects its shipped Node and sandbox`, () => fixture(platform, async f => {
  const result = f.invoke(f.executable); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /bundled Node probe selected/);
}));

test('the macOS app bundle argument remains supported', () => fixture('darwin', async f => {
  const result = f.invoke(f.bundle); assert.equal(result.status, 0, result.stderr);
}));

test('resources redirected outside their canonical package parent are rejected', () => fixture('darwin', async f => {
  const outside = join(f.root, 'outside'), node = join(outside, 'node', 'node'); await mkdir(dirname(node), { recursive: true }); await writeFile(node, 'outside');
  await rm(f.resources, { recursive: true }); await symlink(outside, f.resources, process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.invoke(f.bundle, node); assert.notEqual(result.status, 0); assert.match(result.stderr, /escapes its package/);
}));

test('a bundled Node redirected outside its canonical resources is rejected', () => fixture('darwin', async f => {
  const outside = join(f.root, 'outside-node'), node = join(outside, 'node'); await mkdir(outside); await writeFile(node, 'outside');
  await rm(dirname(f.node), { recursive: true }); await symlink(outside, dirname(f.node), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.invoke(f.bundle, node); assert.notEqual(result.status, 0); assert.match(result.stderr, /escapes its package/);
}));
