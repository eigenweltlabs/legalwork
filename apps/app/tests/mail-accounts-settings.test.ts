import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
test('settings persists the app badge toggle and preserves same-host OAuth, cancels replaced hosts, refreshes accounts and cancels IMAP on exit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-onboarding-')),app=resolve(import.meta.dir,'..');const calls:{path:string;body:Record<string,unknown>}[]=[];let release:()=>void=()=>{};let begins=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'X-LegalWork-Host-Token,Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  if(request.method==='OPTIONS')return new Response(null,{headers});expect(['synthetic','replacement']).toContain(request.headers.get('X-LegalWork-Host-Token'));
  const path=new URL(request.url).pathname,body=request.method==='POST'?await request.json().catch(()=>({})):{};calls.push({path,body});let value:unknown;
  if(path==='/mail/v1/status')value={state:'ready'};
  else if(path==='/mail/v1/accounts')value={items:[],nextCursor:null};
  else if(path==='/mail/v1/connections'){begins++;value={connectionId:'oauth-one',authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&code_challenge_method=S256',expiresAt:Date.now()+60000};}
  else if(path==='/mail/v1/connections/oauth-one')value=begins===1?{state:'pending',connectionId:'oauth-one',expiresAt:Date.now()+60000}:{state:'connected',connectionId:'oauth-one',expiresAt:Date.now()+60000,accountId:'gmail-one',renewable:true};
  else if(path==='/mail/v1/imap/connections'){await new Promise<void>(resolve=>{release=resolve;});value={accountId:'imap-one',provider:'imap'};}
  else value={cancelled:true};
  return Response.json(value,{headers});
 }});
 try {
  const entry=join(root,'entry.tsx');await writeFile(entry,`
    import React from ${JSON.stringify(join(app,'node_modules/react/index.js'))};
    import {createRoot} from ${JSON.stringify(join(app,'node_modules/react-dom/client.js'))};
    import {MailAccountsView} from ${JSON.stringify(join(app,'src/react-app/domains/settings/pages/mail-accounts-view.tsx'))};
    window.__host='synthetic';window.__opened=[];window.__changed=0;window.__badge=false;window.__LEGALWORK_ELECTRON__={invokeDesktop:async(command,value)=>{if(command==='setMailBadgeEnabled')window.__badge=value;return window.__badge;},shell:{openExternal:async url=>window.__opened.push(url)}};
    const root=createRoot(document.getElementById('root'));window.__leave=()=>root.unmount();root.render(React.createElement(MailAccountsView));
  `);
  const resolver=join(root,'connection.ts');await writeFile(resolver,`export async function resolveLegalworkConnection(){return {normalizedBaseUrl:'http://127.0.0.1:${server.port}',resolvedHostToken:window.__host}}`);
  const buildScript=join(root,'build.mjs');await writeFile(buildScript,`const options=${JSON.stringify({entrypoints:[entry],outdir:root,target:'browser',alias:{'@/react-app/shell/legalwork-connection':resolver,'@':join(app,'src')},minify:true})};options.plugins=[{name:'fixture-host',setup(build){build.onResolve({filter:/legalwork-connection/},()=>({path:${JSON.stringify(resolver)}}))}}];const result=await Bun.build(options);if(!result.success)throw Error(result.logs.map(String).join('\\n'));`);
  const built=spawnSync(process.execPath,[buildScript],{encoding:'utf8'});if(built.status!==0)throw Error(built.stderr);
  await writeFile(join(root,'index.html'),'<meta charset="utf-8"><div id="root"></div><script src="entry.js"></script>');
  const probe=join(root,'probe.cjs');await writeFile(probe,`
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(join(root,'profile'))});
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      await win.loadFile(${JSON.stringify(join(root,'index.html'))});const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw Error(code+' :: '+error.message)});
      const until=async code=>{for(let i=0;i<200;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout '+code+' '+await run('document.body.textContent'))};
      await until("!!document.querySelector('[role=tab]')");await run("Array.from(document.querySelectorAll('[role=tab]')).find(e=>e.textContent==='Notifications').click()");
      await until("!!document.querySelector('[role=switch]')&&!document.querySelector('[role=switch]').disabled");
      assert.equal(await run("document.querySelector('[role=switch]').getAttribute('aria-checked')"),'false');
      await run("document.querySelector('[role=switch]').click()");
      await until("window.__badge===true&&!document.querySelector('[role=switch]').disabled");
      assert.equal(await run("document.querySelector('[role=switch]').getAttribute('aria-checked')"),'true');
      await run("Array.from(document.querySelectorAll('[role=tab]')).find(e=>e.textContent==='Accounts').click()");
      await until("!!document.querySelector('form')");
      await run("document.querySelector('form').requestSubmit()");await until("document.body.textContent.includes('Finish sign-in')");
      await run("window.dispatchEvent(new Event('legalwork-server-settings-changed'))");await new Promise(r=>setTimeout(r,150));assert.equal(await run("document.body.textContent.includes('Connecting…')"),true);
      await run("window.__host='replacement';window.dispatchEvent(new Event('legalwork-server-settings-changed'))");await until("!!document.querySelector('form')&&!document.body.textContent.includes('Connecting…')");
      await run("document.querySelector('form').requestSubmit()");await until("document.body.textContent.includes('Connected.')");assert.equal(await run("document.body.textContent.includes('Close setup')"),false);
      assert.equal(await run('window.__opened.length'),2);
      await run("document.querySelector('[aria-label=Provider]').click()");await until("!!document.querySelector('[role=option]')");await run("(()=>{const option=Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent==='iCloud Mail');option.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',bubbles:true}));option.click();})()");
      await until("!!document.querySelector('form input[type=password]')");
      await run("(()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [selector,value] of [['form input[autocomplete=username]','demo@icloud.com'],['form input[type=password]','synthetic-app-password']]){const el=document.querySelector(selector);setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}})()");
      await run("document.querySelector('form').requestSubmit()");await until("document.body.textContent.includes('Connecting…')");
      assert.equal(await run("document.querySelector('form input[type=password]').value"),'');
      assert.equal(await run("JSON.stringify(localStorage).includes('synthetic-app-password')"),false);
      await new Promise(r=>setTimeout(r,100));
      await run("window.__leave()");
      await new Promise(r=>setTimeout(r,100));
      assert.equal(await run('document.querySelector("form")'),null);console.log('ONBOARDING_PASS');win.destroy();app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});
  `);
  const require=createRequire(resolve(app,'../desktop/package.json'));
  const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{
   const child=spawn(require('electron'),[probe],{env:{HOME:process.env.HOME,PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})},stdio:['ignore','pipe','pipe']});let output='';
   const timer=setTimeout(()=>{child.kill();reject(Error(output+' renderer timeout'));},15000);
   child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});
  });if(result.code!==0)throw Error(result.output);expect(result.output).toContain('ONBOARDING_PASS');
  expect(calls.filter(call=>call.path==='/mail/v1/accounts').length).toBeGreaterThanOrEqual(2);
  expect(calls.some(call=>call.path==='/mail/v1/connections/oauth-one/cancel')).toBe(true);
  const imap=calls.find(call=>call.path==='/mail/v1/imap/connections');expect(imap?.body.host).toBe('imap.mail.me.com');expect(imap?.body.port).toBe(993);expect(imap?.body.password).toBe('synthetic-app-password');expect(calls.some(call=>call.path===`/mail/v1/imap/connections/${imap?.body.requestId}/cancel`)).toBe(true);
 } finally {release();server.stop(true);await rm(root,{recursive:true,force:true});}
},20000);
