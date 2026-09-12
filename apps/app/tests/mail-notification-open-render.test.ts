import {linkTestModules} from '../../../scripts/mail/link-test-modules.mjs';
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

test('native notification target opens in shared shell and rejects a different server origin',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-auto-render-')),appRoot=resolve(import.meta.dir,'..');let polls=0,retries=0,reads=0;
 const message={accountId:'a',key:'one',locator:{provider:'gmail',messageId:'one'},subject:'Automatically downloaded',threadId:null,rfcMessageId:null,removed:false,memberships:['INBOX'],contentState:'complete',metadata:null,receivedAt:1000,rawReferenceId:null,isRead:false};
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'X-LegalWork-Host-Token,Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  if(request.method==='OPTIONS')return new Response(null,{headers});
  const path=new URL(request.url).pathname;let value:unknown;
  if(path.endsWith('/status')||path.endsWith('/unlock'))value={state:'ready'};
  else if(path.endsWith('/accounts'))value={items:[{id:'a',provider:'gmail',displayName:'Synthetic account'}],nextCursor:null};
  else if(path.endsWith('/folders'))value={items:[{id:'INBOX',name:'Inbox',kind:'folder',parentId:null,role:'inbox'}],nextCursor:null};
  else if(path.endsWith('/sync')||path.endsWith('/sync/start')){if(path.endsWith('/start'))retries++;else polls++;value={state:polls>=3&&!retries?'waiting':polls>=2?'complete':'syncing',enumerated:1,downloaded:polls>=2?1:0,projected:polls>=2?1:0,failed:0,pending:polls>=2?0:1,error:polls>=3&&!retries?'provider_unavailable':null};}
  else if(path.endsWith('/messages/query'))value={items:polls>=2?[message]:[],nextCursor:null};
  else if(path.endsWith('/messages/read')){reads++;value=message;}else if(path.endsWith('/parts'))value={items:[],nextCursor:null};
  else value={};
  return Response.json(value,{headers});
 }});
 try{
  await linkTestModules(join(appRoot,'node_modules'),join(root,'node_modules'));
  const entry=join(root,'entry.tsx');await writeFile(entry,`import {AppMenuProvider} from ${JSON.stringify(join(appRoot,'src/react-app/shell/app-menu.tsx'))};import React from ${JSON.stringify(join(appRoot,'node_modules/react/index.js'))};import {createRoot} from ${JSON.stringify(join(appRoot,'node_modules/react-dom/client.js'))};import {MemoryRouter} from ${JSON.stringify(join(appRoot,'node_modules/react-router-dom/dist/index.mjs'))};import {MailRoute} from ${JSON.stringify(join(appRoot,'src/react-app/domains/mail/mail-route.tsx'))};localStorage.setItem('legalwork.server.urlOverride','http://127.0.0.1:${server.port}');localStorage.setItem('legalwork.server.token','synthetic');localStorage.setItem('legalwork.server.hostToken','synthetic');window.__LEGALWORK_ELECTRON__={mailNotificationTarget:async()=>{const value=window.pending;window.pending=null;return value;}};window.notify=(serverOrigin)=>{window.pending={serverOrigin,accountId:'a',locator:{provider:'gmail',messageId:'one'}};window.dispatchEvent(new Event('legalwork-mail-notification-open'));};createRoot(document.getElementById('root')).render(<MemoryRouter><AppMenuProvider><MailRoute/></AppMenuProvider></MemoryRouter>);`);
  const build=await Bun.build({entrypoints:[entry],target:'browser',outdir:root,alias:{'@':join(appRoot,'src')},minify:true,plugins:[{name:'fixture-zod',setup(build){build.onResolve({filter:/composer-state-store$/},()=>({path:join(appRoot,'src/react-app/domains/session/surface/composer-state-store.ts')}));build.onResolve({filter:/^zod$/},()=>({path:join(appRoot,'node_modules/zod/index.js')}));}}]});if(!build.success)throw Error(build.logs.map(String).join('\n'));
  await writeFile(join(root,'index.html'),'<html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="entry.js"></script></body></html>');
  const probe=join(root,'probe.cjs');await writeFile(probe,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.webContents.on('console-message',(_event,_level,message)=>console.log(message));await win.loadFile(${JSON.stringify(join(root,'index.html'))});const run=s=>win.webContents.executeJavaScript(s);const until=async s=>{for(let i=0;i<300;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,50));}throw Error('renderer deadline '+s+' BODY '+await run('document.body.textContent'))};await until("!!window.notify&&!!document.querySelector('[aria-label=Compose]:not(:disabled)')");await run("window.notify('http://127.0.0.1:1')");await until("document.body.textContent.includes('Open the local server connection')");assert.equal(await run("!!document.querySelector('.mail-message')"),false);await run("window.notify('http://127.0.0.1:${server.port}')");await until("!!document.querySelector('.mail-message')&&document.querySelector('.mail-message').textContent.includes('Automatically downloaded')");await until("document.activeElement.id==='mail-print-root'");assert.equal(await run("document.body.textContent.includes('Open the local server connection')"),false);console.log('MAIL_AUTO_SYNC_PASS');win.destroy();app.quit();}).catch(e=>{console.error(e);app.exit(1)});`);
  const require=createRequire(resolve(appRoot,'../desktop/package.json'));const result=await new Promise<{code:number|null;output:string}>((resolveResult,reject)=>{const child=spawn(require('electron'),[probe],{env:{PATH:process.env.PATH,HOME:process.env.HOME,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error('renderer deadline '+output));},30000);child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolveResult({code,output});});});if(result.code!==0)throw Error(result.output);expect(result.output).toContain('MAIL_AUTO_SYNC_PASS');expect(retries).toBe(0);expect(reads).toBeGreaterThan(0);
 }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
},45000);
