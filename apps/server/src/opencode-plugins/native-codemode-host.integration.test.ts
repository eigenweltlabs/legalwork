import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { buildNativePluginFixture } from './native-plugin-build.test-support.js';
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)('native Code Mode consumes the full structured result and durably publishes its state change', async () => {
  if (!binary)
    throw new Error('An isolated OpenCode binary is required');
  const root = await mkdtemp(join(tmpdir(), 'native-codemode-host-'));
  const workspace = join(root, 'workspace');
  for (const name of ['workspace', 'home', 'config', 'data', 'cache', 'state', 'tmp'])
    await mkdir(join(root, name), { recursive: true });
  const fakeToken = randomBytes(32).toString('hex');
  let officeCalls = 0;
  let documentName = 'NDA.docx';
  let modelCalls = 0;
  let primaryCalls = 0;
  const traces: unknown[] = [];
  const modelServer = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const body: unknown = await request.json();
      modelCalls++;
      traces.push(body);
      const candidates = body && typeof body === 'object' ? Reflect.get(body, 'tools') : undefined;
      const primary = Array.isArray(candidates) && candidates.some(tool => tool && typeof tool === 'object' && Reflect.get(tool, 'name') === 'execute');
      const callTool = primary && primaryCalls++ === 0;
      const id = `resp_${modelCalls}`;
      const item = callTool
        ? { type: 'function_call', id: `fc_${modelCalls}`, call_id: 'call_fixture', name: 'execute', arguments: JSON.stringify({ code: 'const result = await tools.fixture_json({}); return result.tail.length;' }), status: 'completed' }
        : { type: 'message', id: `msg_${modelCalls}`, role: 'assistant', content: [{ type: 'output_text', text: 'Done' }], status: 'completed' };
      const events = [
        { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: callTool ? { ...item, arguments: '' } : item },
        ...(callTool ? [
          { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
          { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
        ] : []),
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get('authorization') !== `Bearer ${fakeToken}`)
        return new Response('Unauthorized', { status: 401 });
      if (url.pathname === '/change-state') {
        documentName = 'Budget.xlsx';
        return Response.json({ ok: true });
      }
      if (url.pathname === '/workspaces')
        return Response.json({ items: [{ id: 'smoke', path: workspace }] });
      if (url.pathname.endsWith('/office-tools/status'))
        return Response.json({ connected: true, hosts: [{ host: 'word', documentUrl: join(workspace, documentName) }] });
      if (url.pathname.endsWith('/office-tools/execute')) {
        officeCalls++;
        return Response.json({ ok: true, result: { text: 'NDA document' } });
      }
      return new Response('Not found', { status: 404 });
    } });
  let child: ReturnType<typeof spawn> | undefined;
  let stopped: Promise<unknown> | undefined;
  let output = '';
  async function stop() {
    if (!child) return;
    child.kill('SIGTERM');
    await Promise.race([stopped, Bun.sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await stopped;
    }
    child = undefined;
  }
  try {
  const plugins: string[] = [];
  for (const host of ['word', 'excel', 'powerpoint']) {
    const outdir = join(root, 'plugins', host);
    await mkdir(outdir, { recursive: true });
    await buildNativePluginFixture(resolve(import.meta.dir, `legalwork-${host}-tools.ts`), join(outdir, 'index.mjs'));
    plugins.push(outdir);
  }
  const probe = join(root, 'plugins', 'fixture');
  await mkdir(probe, { recursive: true });
  const fixtureEntry = join(root, 'fixture.ts');
  await writeFile(fixtureEntry, `import {Plugin} from "@opencode/plugin";import {nativeTool} from ${JSON.stringify(resolve(import.meta.dir, 'native-tool.ts'))};import {z} from ${JSON.stringify(Bun.resolveSync('zod', import.meta.dir))};export default Plugin.define({id:"fixture",async setup(ctx){await ctx.tool.transform(editor=>editor.add(nativeTool(ctx,{name:"fixture_json",description:"Fixture result",schema:z.object({}),execute:async()=>{await fetch("http://127.0.0.1:${relay.port}/change-state",{headers:{authorization:"Bearer ${fakeToken}"}});await new Promise(resolve=>setTimeout(resolve,5100));return JSON.stringify({tail:"x".repeat(120000)});}})));}});`);
  await buildNativePluginFixture(fixtureEntry, join(probe, 'index.mjs'));
  plugins.push(probe);
  const password = randomBytes(32).toString('hex');
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_CONFIG_DIR: join(root, 'config'), OPENCODE_DB: join(root, 'data', 'engine.db'), OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins, update: 'disable', model: 'openai/fixture', permissions: [{ action: '*', resource: '*', effect: 'allow' }], providers: { openai: { settings: { baseURL: `http://127.0.0.1:${modelServer.port}/v1`, apiKey: 'fixture', transport: 'http' }, models: { fixture: { modelID: 'fixture', limit: { context: 200000, output: 32000 }, capabilities: { tools: true } } } } } }), LEGALWORK_SERVER_URL: `http://127.0.0.1:${relay.port}`, LEGALWORK_SERVER_TOKEN: fakeToken };
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
    await client.session.prompt({ sessionID: session.id, text: 'Execute fixture_json using execute, report the tail length', id: 'msg_codemode_fixture' }, { signal: AbortSignal.timeout(25000) });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(25000) });
    const history = await client.session.context({ sessionID: session.id });
    const tools = history.flatMap(message => message.type === 'assistant' ? message.content.filter(part => part.type === 'tool') : []);
    const executed = tools.find(tool => tool.name === 'execute');
    expect(executed?.state.status).toBe('completed');
    if (executed?.state.status !== 'completed')
      throw new Error('Code Mode did not complete: ' + JSON.stringify(history));
    const text = executed.state.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    expect(text).toContain('120000');
    expect(text).toContain('system-reminder topic="word-pane"');
    expect(text).toContain('Budget.xlsx');
    expect(text).not.toContain('x'.repeat(1000));
    expect(documentName).toBe('Budget.xlsx');
    expect(modelCalls).toBe(2);
    expect(primaryCalls).toBe(2);
    expect(officeCalls).toBe(0);
    const nextRequest = JSON.stringify(traces.at(-1));
    expect(nextRequest).toContain('Budget.xlsx');
    expect(nextRequest).toContain('120000');
    expect(nextRequest).not.toContain('x'.repeat(1000));
  }
  finally {
    await stop();
    relay.stop(true);
    modelServer.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
