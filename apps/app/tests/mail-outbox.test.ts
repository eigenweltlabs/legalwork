import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

test('SMTP Settings, durable composer queue and uncertain Outbox recovery render in isolated Electron',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shared-mail-ui-')),app=resolve(import.meta.dir,'..');
 try{
 const entry=join(dir,'entry.tsx');await writeFile(entry,`
 import React,{useState} from ${JSON.stringify(join(app,'node_modules/react/index.js'))};import{createRoot}from ${JSON.stringify(join(app,'node_modules/react-dom/client.js'))};
 import{MailSmtpView}from ${JSON.stringify(join(app,'src/react-app/domains/settings/pages/mail-smtp-view.tsx'))};import{MailComposer}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-composer.tsx'))};import{MailOutbox}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-outbox.tsx'))};import{emptyCompose}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-compose-model.ts'))};import{MailClient}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-client.ts'))};
 const account={id:'imap',provider:'imap',displayName:'Mailbox'};window.__queued=0;window.__actions=[];
 const item={id:'action',accountId:'imap',draftId:'22222222-2222-4222-8222-222222222222',version:{generation:'11111111-1111-4111-8111-111111111111',revision:1},subject:'Synthetic',from:'self@example.com',state:'uncertain',attempts:1,createdAt:1,updatedAt:1,error:'outcome_unknown',result:null,cancellationGuaranteed:false};
 const client=new MailClient('http://127.0.0.1:43111','synthetic',async(url,init)=>{const body=init.body?JSON.parse(init.body):{};const path=new URL(url).pathname;
 if(path.endsWith('/smtp'))return Response.json({configured:false,settings:null,current:false});
 if(path.endsWith('/smtp/configure')){window.__smtp=body;const{password,...settings}=body;return Response.json({configured:true,current:true,settings});}
 if(path.endsWith('/senders'))return Response.json([{id:'self',accountId:'imap',address:'self@example.com',displayName:'',source:'user_confirmed',available:true,signature:'',defaultNew:true,defaultReply:true,sendMode:'self'}]);
 if(path.endsWith('/drafts/query'))return Response.json({accountId:'imap',items:[],nextCursor:null});
 if(path.endsWith('/drafts/save')){window.__draft=body.content;return Response.json({id:body.draftId,version:{generation:'11111111-1111-4111-8111-111111111111',revision:1},updatedAt:0,deleted:false,subject:body.content.subject,content:body.content});}
 if(path.endsWith('/outbox/queue')){window.__queued++;window.__pin=body;await new Promise(resolve=>setTimeout(resolve,100));return Response.json({...item,state:'queued',error:null,cancellationGuaranteed:true});}
 if(path.endsWith('/outbox'))return Response.json([item]);
 if(path.endsWith('/outbox/action')){window.__actions.push(body);return Response.json(item);}
 throw Error('Unexpected fixture request');});
 function Fixture(){const[mode,setMode]=useState('settings');window.__compose=()=>setMode('compose');return mode==='settings'?React.createElement(MailSmtpView,{client,accounts:[account]}):mode==='outbox'?React.createElement(MailOutbox,{client,accounts:[account],onClose:()=>{}}):React.createElement(MailComposer,{client,accounts:[account],initial:{account:'imap',id:item.draftId,version:null,content:emptyCompose('')},onClose:()=>{},onSwitch:()=>{},onQueued:()=>setMode('outbox')});}
 createRoot(document.getElementById('root')).render(React.createElement(Fixture));`);
 const builder=join(dir,'build.mjs');await writeFile(builder,`const built=await Bun.build({entrypoints:[${JSON.stringify(entry)}],outdir:${JSON.stringify(dir)},target:'browser',alias:{'@':${JSON.stringify(join(app,'src'))}},plugins:[{name:'fixture-zod',setup(build){build.onResolve({filter:/^zod$/},()=>({path:${JSON.stringify(join(app,'../server/node_modules/zod/index.js'))}}));}}],minify:true});if(!built.success)throw Error(built.logs.map(String).join('\\n'));`);
 const built=spawnSync(process.execPath,[builder],{encoding:'utf8',timeout:10000});if(built.status!==0)throw Error(built.stderr||built.stdout);
 await writeFile(join(dir,'index.html'),'<meta charset="utf-8"><div id="root"></div><script src="entry.js"></script>');
 const probe=join(dir,'probe.cjs');await writeFile(probe,`
 const{app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(dir,'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await win.loadFile(${JSON.stringify(join(dir,'index.html'))});const run=code=>win.webContents.executeJavaScript(code);const until=async code=>{for(let i=0;i<250;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout '+code);};
await until("!!document.querySelector('[aria-label=\\"SMTP host for imap\\"]')");
await run("(()=>{const set=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};set(document.querySelector('[aria-label=\\"SMTP host for imap\\"]'),'smtp.example.com');set(document.querySelector('input[autocomplete=username]'),'synthetic');set(document.querySelector('input[type=password]'),'synthetic-password');})()");
await run("[...document.querySelectorAll('button')].find(el=>el.textContent==='Save outgoing settings').click()");await until("!!window.__smtp");assert.equal(await run("window.__smtp.security"),'tls');await until("document.querySelector('input[type=password]').value===''");
await run("window.__compose()");await until("window.__draft?.senderIdentityId==='self'");
assert.equal(await run("[...document.querySelectorAll('button')].find(el=>el.textContent==='Send').disabled"),true);
await run("(()=>{const el=document.querySelector('[aria-label=To]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'recipient@example.com');el.dispatchEvent(new Event('input',{bubbles:true}));})()");await until("window.__draft.to.length===1");
await until("[...document.querySelectorAll('button')].find(el=>el.textContent==='Send').disabled===false");
await run("(()=>{const el=[...document.querySelectorAll('button')].find(el=>el.textContent==='Send');el.click();el.click();})()");await until("!!document.querySelector('[aria-label=Outbox]')");assert.equal(await run("window.__queued"),1);assert.equal(await run("window.__pin.version.revision"),1);
await until("document.body.textContent.includes('will not resend automatically')");assert.equal(await run("[...document.querySelectorAll('button')].some(el=>el.textContent==='Retry rejected submission')"),false);
await run("[...document.querySelectorAll('button')].find(el=>el.textContent==='Check Sent for acceptance').click()");await until("window.__actions.length===1");assert.equal(await run("window.__actions[0].action"),'reconcile');
console.log('OUTBOX_PASS');win.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});`);
 const require=createRequire(resolve(app,'../desktop/package.json'));const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{const child=spawn(require('electron'),[probe],{env:{...process.env},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error(output+' renderer timeout'));},15000);child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});});if(result.code!==0)throw Error(result.output);expect(result.output).toContain('OUTBOX_PASS');
 }finally{await rm(dir,{recursive:true,force:true});}
},20000);
