import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

test('Settings saves identity signatures and composer selects permitted aliases without arbitrary From',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shared-mail-ui-')),app=resolve(import.meta.dir,'..');
 try{
 const entry=join(dir,'entry.tsx');await writeFile(entry,`
 import React,{useState} from ${JSON.stringify(join(app,'node_modules/react/index.js'))};import{createRoot}from ${JSON.stringify(join(app,'node_modules/react-dom/client.js'))};
 import{MailSendersView}from ${JSON.stringify(join(app,'src/react-app/domains/settings/pages/mail-senders-view.tsx'))};import{MailComposer}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-composer.tsx'))};import{emptyCompose}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-compose-model.ts'))};import{MailClient}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-client.ts'))};
 const account={id:'gmail',provider:'gmail',displayName:'Mailbox'};
 let identities=[{id:'self',accountId:'gmail',address:'self@example.com',displayName:'',source:'provider_verified',available:true,signature:'Self signature',defaultNew:true,defaultReply:false,sendMode:'self'},{id:'alias',accountId:'gmail',address:'alias@example.com',displayName:'',source:'provider_verified',available:true,signature:'Alias signature',defaultNew:false,defaultReply:true,sendMode:'self'}];
 const client=new MailClient('http://127.0.0.1:43111','synthetic',async(url,init)=>{const body=init.body?JSON.parse(init.body):{};const path=new URL(url).pathname;
 if(path.endsWith('/senders/settings')){window.__settings=body;identities=identities.map(value=>value.id===body.identityId?{...value,signature:body.signature,defaultNew:body.defaultNew,defaultReply:body.defaultReply}:value);return Response.json(identities.map(({identityId,...value})=>value));}
 if(path.endsWith('/senders')||path.endsWith('/senders/refresh'))return Response.json(identities);
 if(path.endsWith('/drafts/query'))return Response.json({accountId:'gmail',items:[],nextCursor:null});
 if(path.endsWith('/drafts/save')){window.__draft=body.content;return Response.json({id:body.draftId,version:{generation:'11111111-1111-4111-8111-111111111111',revision:1},updatedAt:0,deleted:false,subject:body.content.subject,content:body.content});}
 throw Error('Unexpected fixture request');});
 function Fixture(){const[compose,setCompose]=useState(false);window.__compose=()=>setCompose(true);return compose?React.createElement(MailComposer,{client,accounts:[account],initial:{account:'gmail',id:'22222222-2222-4222-8222-222222222222',version:null,content:emptyCompose('')},onClose:()=>{},onSwitch:()=>{}}):React.createElement(MailSendersView,{client,accounts:[account]});}
 createRoot(document.getElementById('root')).render(React.createElement(Fixture));`);
 const builder=join(dir,'build.mjs');await writeFile(builder,`const built=await Bun.build({entrypoints:[${JSON.stringify(entry)}],outdir:${JSON.stringify(dir)},target:'browser',alias:{'@':${JSON.stringify(join(app,'src'))}},plugins:[{name:'fixture-zod',setup(build){build.onResolve({filter:/^zod$/},()=>({path:${JSON.stringify(join(app,'../server/node_modules/zod/index.js'))}}));}}],minify:true});if(!built.success)throw Error(built.logs.map(String).join('\\n'));`);
 const built=spawnSync(process.execPath,[builder],{encoding:'utf8',timeout:10000});if(built.status!==0)throw Error(built.stderr||built.stdout);
 await writeFile(join(dir,'index.html'),'<meta charset="utf-8"><div id="root"></div><script src="entry.js"></script>');
 const probe=join(dir,'probe.cjs');await writeFile(probe,`
 const{app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(dir,'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await win.loadFile(${JSON.stringify(join(dir,'index.html'))});const run=code=>win.webContents.executeJavaScript(code);const until=async code=>{for(let i=0;i<250;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout '+code);};
await until("!!document.querySelector('[aria-label=\\"Signature for self@example.com\\"]')");
await run("(()=>{const el=document.querySelector('[aria-label=\\"Signature for self@example.com\\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Saved signature');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
await run("[...document.querySelectorAll('button')].find(el=>el.textContent==='Save identity preferences').click()");
await until("!!window.__settings");assert.equal(await run("window.__settings.signature"),'Saved signature');
await run("window.__compose()");await until("!!document.querySelector('[aria-label=\\"Sender identity\\"]')");await until("window.__draft?.senderIdentityId==='self'");
assert.equal(await run("!!document.querySelector('input[aria-label=\\"Sender email\\"]')"),false);
await run("(()=>{const el=document.querySelector('[aria-label=\\"Sender identity\\"]');el.value='alias';el.dispatchEvent(new Event('change',{bubbles:true}));})()");await until("window.__draft?.senderIdentityId==='alias'");
assert.equal(await run("window.__draft.from"),'alias@example.com');assert.equal(await run("window.__draft.text.includes('Alias signature')"),true);
await run("document.querySelector('[aria-label=\\"Toggle rich text\\"]').click()");
await until("window.__draft.html!==null");
await run("(()=>{const el=document.querySelector('[aria-label=\\"Rich message body\\"]');el.insertAdjacentHTML('afterbegin','<p>Edited body</p>');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
await until("window.__draft.html.includes('Edited body')");
await run("(()=>{const el=document.querySelector('[aria-label=\\"Sender identity\\"]');el.value='self';el.dispatchEvent(new Event('change',{bubbles:true}));})()");
await until("window.__draft.senderIdentityId==='self'");
assert.equal(await run("window.__draft.html.includes('Alias signature')"),false);assert.equal(await run("window.__draft.html.includes('Edited body')"),true);
await run("document.querySelector('[aria-label=\\"Toggle rich text\\"]').click()");
await until("window.__draft.html===null");
await run("document.querySelector('[aria-label=\\"Toggle rich text\\"]').click()");
await until("window.__draft.html!==null");
await run("(()=>{const el=document.querySelector('[aria-label=\\"Sender identity\\"]');el.value='alias';el.dispatchEvent(new Event('change',{bubbles:true}));})()");
await until("window.__draft.senderIdentityId==='alias'");
assert.equal(await run("window.__draft.html.includes('Saved signature')"),false);
await run("(()=>{const el=document.querySelector('[aria-label=\\"Rich message body\\"]');el.innerHTML=el.innerHTML.replace('Alias signature','User-edited signature');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
await until("window.__draft.html.includes('User-edited signature')");
await run("(()=>{const el=document.querySelector('[aria-label=\\"Sender identity\\"]');el.value='self';el.dispatchEvent(new Event('change',{bubbles:true}));})()");
await until("window.__draft.senderIdentityId==='self'");
assert.equal(await run("window.__draft.html.includes('User-edited signature')"),true);
console.log('SENDER_IDENTITY_PASS');win.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});`);
 const require=createRequire(resolve(app,'../desktop/package.json'));const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{const child=spawn(require('electron'),[probe],{env:{...process.env},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error(output+' renderer timeout'));},15000);child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});});if(result.code!==0)throw Error(result.output);expect(result.output).toContain('SENDER_IDENTITY_PASS');
 }finally{await rm(dir,{recursive:true,force:true});}
},20000);
