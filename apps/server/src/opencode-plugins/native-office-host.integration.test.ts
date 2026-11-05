import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { buildNativePluginFixture } from './native-plugin-build.test-support.js';
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)('native Office plugins atomically admit app context and preserve it across a real engine restart', async () => {
  if (!binary)
    throw new Error('An isolated OpenCode binary is required');
  const root = await mkdtemp(join(tmpdir(), 'native-office-host-'));
  const workspace = join(root, 'workspace');
  for (const name of ['workspace', 'home', 'config', 'data', 'cache', 'state', 'tmp'])
    await mkdir(join(root, name), { recursive: true });
  const fakeToken = randomBytes(32).toString('hex');
  let officeCalls = 0;
  const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get('authorization') !== `Bearer ${fakeToken}`)
        return new Response('Unauthorized', { status: 401 });
      if (url.pathname === '/workspaces')
        return Response.json({ items: [{ id: 'smoke', path: workspace }] });
      if (url.pathname.endsWith('/office-tools/status'))
        return Response.json({ connected: true, hosts: [{ host: 'word', documentUrl: join(workspace, 'NDA.docx') }] });
      if (url.pathname.endsWith('/office-tools/execute')) {
        officeCalls++;
        return Response.json({ ok: true, result: { text: 'NDA document' } });
      }
      return new Response('Not found', { status: 404 });
    } });
  let child: ReturnType<typeof spawn> | undefined;
  let stopped: Promise<unknown> | undefined;
  let output = '';
  async function stop() { if (!child)
    return; child.kill('SIGTERM'); await Promise.race([stopped, Bun.sleep(3000)]); if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await stopped;
  } child = undefined; }
  try {
  const plugins: string[] = [];
  for (const host of ['word', 'excel', 'powerpoint']) {
    const outdir = join(root, 'plugins', host);
    await mkdir(outdir, { recursive: true });
    await buildNativePluginFixture(resolve(import.meta.dir, `legalwork-${host}-tools.ts`), join(outdir, 'index.mjs'));
    plugins.push(outdir);
  }
  const password = randomBytes(32).toString('hex');
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_CONFIG_DIR: join(root, 'config'), OPENCODE_DB: join(root, 'data', 'engine.db'), OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins, update: 'disable' }), LEGALWORK_SERVER_URL: `http://127.0.0.1:${relay.port}`, LEGALWORK_SERVER_TOKEN: fakeToken };
  async function start() {
    if (!binary)
      throw new Error('An isolated OpenCode binary is required');
    output = '';
    const running = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = running;
    stopped = new Promise(resolve => running.once('exit', resolve));
    running.stdout.on('data', data => output += data);
    running.stderr.on('data', data => output += data);
    const deadline = Date.now() + 30000;
    let url: string | undefined;
    while (Date.now() < deadline) {
      url = /^server listening on (https?:\/\/[^\s]+)/m.exec(output)?.[1];
      if (url)
        break;
      if (running.exitCode !== null)
        throw new Error('engine exited: ' + output);
      await Bun.sleep(30);
    }
    if (!url)
      throw new Error('no listener: ' + output);
    return OpenCode.make({ baseUrl: url, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  }
    let client = await start();
    const session = await client.session.create({ location: { directory: workspace }, title: 'Native Office host smoke' }, { signal: AbortSignal.timeout(15000) });
    const admitted = await client.session.prompt({ sessionID: session.id, text: 'Read the open document', id: 'msg_office_host_smoke', resume: false }, { signal: AbortSignal.timeout(15000) });
    const inbox = await client.session.inbox.list({ sessionID: session.id });
    if (inbox.length !== 1 || inbox[0].type !== 'user')
      throw new Error('Expected one atomic user admission, received ' + JSON.stringify(inbox));
    const item = inbox[0];
    if (item.type !== 'user')
      throw new Error('Expected a native user inbox item');
    if (!item.payload.text.includes('system-reminder topic="word-pane"'))
      throw new Error('No Word reminder: ' + JSON.stringify(inbox) + '\n' + output);
    const visible = item.payload.metadata?.legalworkPrompt;
    if (!visible || typeof visible !== 'object' || Array.isArray(visible) || visible.visibleText !== 'Read the open document')
      throw new Error('Visible text metadata mismatch');
    expect(await client.session.context({ sessionID: session.id })).toEqual([]);
    expect(plugins).toHaveLength(3);
    await stop();
    client = await start();
    const restored = await client.session.inbox.list({ sessionID: session.id });
    if (JSON.stringify(restored) !== JSON.stringify(inbox))
      throw new Error('Durable inbox changed on restart');
    expect(restored).toEqual(inbox);
    expect(officeCalls).toBe(0);
  }
  finally {
    await stop();
    relay.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
