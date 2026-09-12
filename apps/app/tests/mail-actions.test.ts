import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';

test('mailbox UI queues independent bulk actions, shows partial failure, safely undoes and confirms permanent deletion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-actions-render-')),appRoot=resolve(import.meta.dir,'..');let sequence=1;const actions=new Map<string,Record<string,unknown>>(),mutations:Record<string,unknown>[]=[];
 const messages=['one','two'].map(id=>({accountId:'a',key:JSON.stringify(['gmail',id]),locator:{provider:'gmail',messageId:id},subject:id==='one'?'Review contract':'Matter update',threadId:null,rfcMessageId:null,removed:false,memberships:['INBOX','UNREAD'],contentState:'complete',metadata:null,receivedAt:1000,rawReferenceId:null,isRead:false,isFlagged:false,mutationPrecondition:'gmail:observed'}));
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'X-LegalWork-Host-Token,Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  if(request.method==='OPTIONS')return new Response(null,{headers});expect(request.headers.get('X-LegalWork-Host-Token')).toBe('synthetic');
  const path=new URL(request.url).pathname,body=request.method==='POST'?await request.json():{};let value:unknown;
  if(path.endsWith('/status')||path.endsWith('/unlock'))value={state:'ready'};
  else if(path.endsWith('/accounts'))value={items:[{id:'a',provider:'gmail',displayName:'Synthetic account'}],nextCursor:null};
  else if(path.endsWith('/folders'))value={items:[{id:'INBOX',name:'Inbox',kind:'label',parentId:null,role:'inbox',mutationPrecondition:'folder:one'},{id:'work',name:'Work',kind:'label',parentId:null,mutationPrecondition:'folder:work'}],nextCursor:null};
  else if(path.endsWith('/sync'))value={state:'complete',enumerated:2,downloaded:2,projected:2,failed:0,pending:0,error:null};
  else if(path.endsWith('/events/query'))value={stream:'synthetic',nextCursor:sequence};
  else if(path.endsWith('/messages/query'))value={items:messages,nextCursor:null};
  else if(path.endsWith('/messages/read'))value=messages.find(item=>item.locator.messageId===body.locator.messageId);
  else if(path.endsWith('/messages/parts'))value={items:[],nextCursor:null};
  else if(path.endsWith('/actions/query'))value={items:[...actions.values()].filter(item=>!['cancelled','succeeded'].includes(String(item.state))),nextCursor:null};
  else if(path.endsWith('/actions/read'))value=actions.get(body.actionId);
  else if(path.endsWith('/actions/cancel')){const item=actions.get(body.actionId)!;value={...item,state:'cancelled',version:{generation:(item.version as {generation:string}).generation,revision:2}};actions.set(body.actionId,value as Record<string,unknown>);sequence++;}
  else if(path.endsWith('/actions/mutation')){
   mutations.push(body);if(body.locator?.messageId==='two'&&body.change.kind==='read')return Response.json({error:'rejected'},{status:403,headers});
   const item={id:randomUUID(),kind:'mutation',state:'queued',version:{generation:randomUUID(),revision:1},attempts:0,maxAttempts:5,availableAt:Date.now(),cancelRequested:false,lastError:null,conflictPolicy:'manual',executionSupported:true,credentialCurrent:true,providerResult:null,mutation:{locator:body.locator,precondition:body.precondition,change:body.change}};actions.set(item.id,item);value=item;
  }else value={};return Response.json(value,{headers});
 }});
 try{
  await symlink(join(appRoot,'node_modules'),join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
  const entry=join(root,'entry.tsx');await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {MailRoute} from ${JSON.stringify(join(appRoot,'src/react-app/domains/mail/mail-route.tsx'))};localStorage.setItem('legalwork.server.urlOverride','http://127.0.0.1:${server.port}');localStorage.setItem('legalwork.server.hostToken','synthetic');localStorage.setItem('legalwork.server.token','synthetic');createRoot(document.getElementById('root')).render(<MemoryRouter><MailRoute/></MemoryRouter>);`);
  const build=await Bun.build({entrypoints:[entry],target:'browser',outdir:root,alias:{'@':join(appRoot,'src')},minify:true,plugins:[{name:'fixture-zod',setup(build){build.onResolve({filter:/^zod$/},()=>({path:join(appRoot,'node_modules/zod/index.js')}));}}]});if(!build.success)throw Error(build.logs.map(String).join('\n'));
  await writeFile(join(root,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="entry.css"><style>:root{--border:#dedfe4;--muted:#f4f4f5;--muted-foreground:#6b6f78;--background:#fff;--foreground:#20222a;--popover:#fff;--popover-foreground:#20222a;--primary:#46536a;--destructive:#a83737}body{margin:0;font-family:system-ui}button,input,select{font:inherit}#root{height:100vh}button{cursor:pointer;border:0;background:transparent;color:inherit}</style></head><body><div id="root"></div><script src="entry.js"></script></body></html>');
  const probe=join(root,'probe.cjs');await writeFile(probe,`
  const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1200,height:760,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});await win.loadFile(${JSON.stringify(join(root,'index.html'))});const run=s=>win.webContents.executeJavaScript(s);const until=async s=>{for(let i=0;i<200;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,30));}throw Error('renderer deadline '+s+' '+await run('document.body.textContent'));};
  await until("document.querySelectorAll('.mail-message-row').length===2");
  await run("document.querySelector('[aria-label=\\"Select all messages on this page\\"]').click()");await until("document.body.textContent.includes('2 selected')");
  await run("document.querySelector('[aria-label=\\"Mark read\\"]').click()");await until("document.body.textContent.includes('Matter update: Mail request failed (403).')");
  assert.equal(await run("document.querySelectorAll('.mail-message-row.is-unread').length"),1);
  await run("document.querySelector('[aria-label=\\"Undo Mark read\\"]').click()");await until("document.querySelectorAll('.mail-message-row.is-unread').length===2");
  await run("document.querySelector('[aria-label=\\"More mailbox actions\\"]').click();[...document.querySelectorAll('button')].find(b=>b.textContent==='Permanently delete…').click()");await until("!!document.querySelector('[role=dialog]')");assert.ok(await run("document.querySelector('[role=dialog]').textContent.includes('cannot be undone')"));
  await run("[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(b=>b.textContent==='Cancel').click()");await until("!document.querySelector('[role=dialog]')");
  await run("document.querySelector('.mail-account-row').click()");await until("document.querySelectorAll('.mail-account-folders button').length===2");
  await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='New folder or label…').click()");await until("!!document.querySelector('[aria-label=\\"Folder or label name\\"]')");
  await run("(()=>{const input=document.querySelector('[aria-label=\\"Folder or label name\\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Litigation');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await run("[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(b=>b.textContent==='Create').click()");await until("!document.querySelector('[role=dialog]')");await until("document.body.textContent.includes('Create folder')");
  fs.writeFileSync('/tmp/eig144-mail-actions.png',(await win.webContents.capturePage()).toPNG());console.log('MAIL_ACTIONS_PASS');win.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});
  `);
  const require=createRequire(resolve(appRoot,'../desktop/package.json'));const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{const child=spawn(require('electron'),[probe],{env:{HOME:process.env.HOME,PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error(output+' renderer timeout'));},20000);child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});});if(result.code!==0)throw Error(result.output);expect(result.output).toContain('MAIL_ACTIONS_PASS');expect(mutations.filter(item=>(item.change as {kind:string}).kind==='read')).toHaveLength(2);expect(mutations.some(item=>(item.change as {kind:string}).kind==='delete')).toBe(false);expect(mutations.at(-1)).toMatchObject({change:{kind:'mailbox',operation:'create',path:'Litigation'},precondition:'gmail-mailbox-v1'});
 }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
},30000);
