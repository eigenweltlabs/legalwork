import { test, expect } from 'bun:test';
import { buildBrowserFixture, electronDisplayEnvironment } from './fixtures/build-browser';
import { buildMailFixtureStyle } from './fixtures/build-mail-style';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

test('invitation keyboard review checks identity, safe cancellation and one-use uncertain replies for Google and delegated Outlook', async () => {
  const displayEnvironment = electronDisplayEnvironment();
  const root = await mkdtemp(join(tmpdir(), 'mail-invitation-render-')), appRoot = resolve(import.meta.dir, '..');
  try {
    const evidence = process.env.MAIL_JOURNEY_EVIDENCE;
    if (evidence) await mkdir(evidence, { recursive: true });
    await buildBrowserFixture({ entrypoints: [join(import.meta.dir, 'fixtures/mail-invitations/browser.tsx')], outdir: root, naming: 'entry.js', alias: { '@': join(appRoot, 'src') }, minify: true });
    await buildMailFixtureStyle(root, appRoot);
    await writeFile(join(root, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="styles/index.css"></head><body><div id="root"></div><script src="entry.js"></script></body></html>');
    const electron = createRequire(resolve(appRoot, '../desktop/package.json'))('electron');
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(electron, [join(import.meta.dir, 'fixtures/mail-invitations/probe.cjs'), root, evidence ?? ''], { env: { ...displayEnvironment, PATH: process.env.PATH, HOME: process.env.HOME, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', expired = false;
      const timer = setTimeout(() => { expired = true; child.kill(); }, 40_000);
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (expired) reject(Error(`Invitation renderer deadline: ${output}`)); else done({ code, output }); });
    });
    if (result.code !== 0) throw Error(result.output);
    expect(result.output).toContain('MAIL_INVITATION_UI_PASS');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
