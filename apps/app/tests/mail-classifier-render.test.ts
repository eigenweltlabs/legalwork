import { test, expect } from 'bun:test';
import { buildBrowserFixture, electronDisplayEnvironment } from './fixtures/build-browser';
import { buildMailFixtureStyle } from './fixtures/build-mail-style';
import { linkTestModules } from '../../../scripts/mail/link-test-modules.mjs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

test('project classification UI saves explicit automatic policy, reviews arrivals, undoes and confirms assignments', async () => {
  const displayEnvironment = electronDisplayEnvironment();
  const root = await mkdtemp(join(tmpdir(), 'mail-classifier-render-')), appRoot = resolve(import.meta.dir, '..');
  const version = { generation: '11111111-1111-4111-8111-111111111111', revision: 1 }, project = { id: 'synthetic-project', binding: 'a'.repeat(64), name: 'Synthetic project' };
  const locator = { provider: 'gmail', messageId: 'one' }, rule = { id: '22222222-2222-4222-8222-222222222222', name: 'Reference and sender', enabled: true, order: 1, project, unavailable: false, criteria: { sender: 'sender@example.test', domain: '', reference: 'MAT-123', subject: '' } };
  let definition = { mode: 'off', automaticThreshold: 'reference_sender', rules: [rule], exclusions: { senders: [], domains: [], subjects: [] } }, revision = 1, undone = false, dismissed = false, confirmed = false;
  const calls: string[] = [];
  const evidence = { arrivalId: 1, configVersion: version, threshold: 'reference_sender', rules: [{ id: rule.id, name: rule.name, reasons: ['sender', 'reference'] }] };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-LegalWork-Host-Token,Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' };
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    const input = await request.json(), path = new URL(request.url).pathname; calls.push(input.operation ?? input.action);
    let value: unknown;
    if (path.endsWith('/classifier')) {
      if (input.operation === 'mail.classifier.save') { definition = { ...input.input.definition, rules: input.input.definition.rules.map((item: typeof rule) => ({ ...item, project, unavailable: false })) }; revision++; }
      if (input.operation === 'mail.classifier.activity') {
        const assigned = { id: 1, version: { ...version, revision: undone ? 2 : 1 }, locator:{provider:'gmail',messageId:'assigned'}, subject: 'Assigned arrival', at: 1000, outcome: undone ? 'undone' : 'assigned', project, unavailable: false, assignmentVersion: version, canUndo: !undone, canDismiss: false };
        const review = { ...assigned, id: 2, locator:{provider:'gmail',messageId:'review'}, subject: 'Ambiguous arrival', outcome: 'ambiguous', project: null, assignmentVersion: null, canUndo: false, canDismiss: true };
        value = { accountId: 'a', items: input.input.filter === 'review' ? dismissed ? [] : [review] : [assigned], nextCursor: null };
      } else if (input.operation === 'mail.classifier.undo' || input.operation === 'mail.classifier.dismiss') {
        if (input.operation === 'mail.classifier.undo') undone = true; else dismissed = true;
        value = { accountId: 'a', id: input.input.id, version: { ...input.input.expected, revision: input.input.expected.revision + 1 }, outcome: undone && input.operation.endsWith('.undo') ? 'undone' : 'dismissed' };
      } else value = { accountId: 'a', version: { ...version, revision }, definition, automaticStatus: definition.mode === 'automatic' ? 'ready' : 'off', automaticEligible: true };
    } else if (path.endsWith('/projects')) {
      if (input.action === 'catalog') value = { items: [project], nextCursor: null };
      else if (input.action === 'history') value = { accountId: 'a', locator, items: [{ version, project, unavailable: false, at: 1000, source: 'automatic', evidence }], nextRevision: null };
      else { if (input.action === 'set') confirmed = true; value = { accountId: 'a', locator, version: { ...version, revision: confirmed ? 2 : 1 }, project, unavailable: false, updatedAt: 1000, source: confirmed ? 'manual' : 'automatic', evidence: confirmed ? null : evidence }; }
    } else throw Error('Unexpected synthetic endpoint');
    return Response.json(value, { headers });
  } });
  try {
    const evidenceRoot=process.env.MAIL_CLASSIFIER_EVIDENCE; if(evidenceRoot)await mkdir(evidenceRoot,{recursive:true});
    await linkTestModules(join(appRoot, 'node_modules'), join(root, 'node_modules'));
    const entry = join(root, 'entry.tsx');
    await writeFile(entry, `import React from ${JSON.stringify(join(appRoot, 'node_modules/react/index.js'))};import {createRoot} from ${JSON.stringify(join(appRoot, 'node_modules/react-dom/client.js'))};import {MemoryRouter} from ${JSON.stringify(join(appRoot, 'node_modules/react-router-dom/dist/index.mjs'))};import {MailClassifierView} from ${JSON.stringify(join(appRoot, 'src/react-app/domains/settings/pages/mail-classifier-view.tsx'))};import {MailProjectControl} from ${JSON.stringify(join(appRoot, 'src/react-app/domains/mail/mail-project.tsx'))};import {MailClient} from ${JSON.stringify(join(appRoot, 'src/react-app/domains/mail/mail-client.ts'))};const client=new MailClient('http://127.0.0.1:${server.port}','synthetic');const item=${JSON.stringify({ accountId: 'a', key: 'one', locator, subject: 'Synthetic', threadId: null, rfcMessageId: null, removed: false, memberships: ['INBOX'], contentState: 'complete', metadata: null })};createRoot(document.getElementById('root')).render(<React.StrictMode><MemoryRouter><main style={{padding:24,maxWidth:900,margin:'auto'}}><section id="message"><MailProjectControl client={client} item={item}/></section><MailClassifierView client={client} accounts={[{id:'a',provider:'gmail',displayName:'Synthetic account'}]} automatic/></main></MemoryRouter></React.StrictMode>);`);
    await buildBrowserFixture({ entrypoints: [entry], outdir: root, alias: { '@': join(appRoot, 'src') }, minify: true });
    await buildMailFixtureStyle(root,appRoot);
    await writeFile(join(root, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="styles/index.css"></head><body><div id="root"></div><script src="entry.js"></script></body></html>');
    const probe = join(root, 'probe.cjs');
    await writeFile(probe, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1100,height:1000,enableLargerThanScreen:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});await win.loadFile(${JSON.stringify(join(root, 'index.html'))});win.show();win.focus();win.setContentSize(1100,1000);
      const run=code=>win.webContents.executeJavaScript(code),until=async code=>{for(let i=0;i<300;i++){if(await run(code))return;await new Promise(done=>setTimeout(done,30));}throw Error('Renderer deadline: '+code+' '+await run('document.body.textContent'));};
      assert(await run("getComputedStyle(document.documentElement).getPropertyValue('--lw-control-md').trim().length>0"),'Shared design tokens must load');
      await until('document.hasFocus()&&innerWidth===1100&&innerHeight===1000');
      const settledFrame=async()=>{await run("document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))");};
      const click=async text=>{await until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==="+JSON.stringify(text)+")");await run("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==="+JSON.stringify(text)+").click()");};
      const choose=async(label,text)=>{
        await until("(()=>{const trigger=document.querySelector('[aria-label=\\\""+label+"\\\"]');return trigger&&!trigger.disabled&&trigger.getAttribute('aria-disabled')!=='true';})()");
        await run("(()=>{const trigger=document.querySelector('[aria-label=\\\""+label+"\\\"]');trigger.focus();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));})()");
        const popup="[data-slot=select-content][data-open]",option=popup+" [role=option]",highlighted=option+"[data-highlighted]";
        await until("[...document.querySelectorAll('"+option+"')].some(o=>o.textContent.trim()==="+JSON.stringify(text)+")");
        await until("document.querySelector('"+popup+"')?.contains(document.activeElement)&&!!document.querySelector('"+highlighted+"')");
        const count=await run("document.querySelectorAll('"+option+"').length");
        for(let index=0;index<count;index++){
          const current=await run("document.querySelector('"+highlighted+"').textContent.trim()");
          if(current===text)break;
          await run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}))");
          await until("document.querySelector('"+highlighted+"')?.textContent.trim()!=="+JSON.stringify(current));
        }
        await until("[...document.querySelectorAll('"+highlighted+"')].some(o=>o.textContent.trim()==="+JSON.stringify(text)+")");
        await run("document.querySelector('"+highlighted+"').click()");
      };
      await until("document.querySelector('[aria-label=Mode]')?.textContent.includes('Off')");await choose('Mode','Automatic');await until("document.body.textContent.includes('Active for new Inbox mail')");await choose('Assign automatically when','Any matching rule');await until("document.querySelector('[aria-label=\\\"Assign automatically when\\\"]').textContent.includes('Any matching rule')");
      ${evidenceRoot?`await until("!document.querySelector('[data-slot=select-content][data-open]')");await settledFrame();require('node:fs').writeFileSync(${JSON.stringify(join(evidenceRoot,'automatic-project-settings.png'))},(await win.webContents.capturePage()).toPNG());`:''}
      await until("document.body.textContent.includes('Ambiguous arrival')");await click('Dismiss');await until("document.body.textContent.includes('No matching activity')");await until("document.activeElement?.textContent==='Refresh'");
      await choose('Filter assignments','Automatic assignments');await click('Undo assignment');await until("document.body.textContent.includes('Assignment undone')");await until("document.activeElement?.textContent==='Refresh'");
      await run("document.querySelector('#message button').click()");await until("!![...document.querySelectorAll('button')].find(b=>b.textContent==='Keep project')");assert(await run("document.querySelector('[role=dialog]').textContent.includes('Reference and sender')"));await click('Assignment history');await until("document.querySelector('[role=dialog]').textContent.includes('1/1/1970')||document.querySelector('[role=dialog]').textContent.includes('1970')");${evidenceRoot?`await settledFrame();require('node:fs').writeFileSync(${JSON.stringify(join(evidenceRoot,'automatic-project-history.png'))},(await win.webContents.capturePage()).toPNG());`:''}await click('Keep project');await until("!document.querySelector('[role=dialog]')&&!document.querySelector('#message').textContent.includes('Automatic')");
      console.log('MAIL_CLASSIFIER_UI_PASS');win.destroy();app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});`);
    const electron = createRequire(resolve(appRoot, '../desktop/package.json'))('electron');
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(electron, [probe], { env: { ...displayEnvironment, PATH: process.env.PATH, HOME: process.env.HOME, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Renderer deadline ' + output)); }, 40000);
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); done({ code, output }); });
    });
    if (result.code !== 0) throw Error(result.output);
    expect(result.output).toContain('MAIL_CLASSIFIER_UI_PASS'); expect(definition.mode).toBe('automatic'); expect(definition.automaticThreshold).toBe('any_rule'); expect(undone && dismissed && confirmed).toBe(true);
    expect(calls.some(operation => operation === 'mail.classifier.pending' || operation === 'mail.classifier.commit')).toBe(false);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60000);
