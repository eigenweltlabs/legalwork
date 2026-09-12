import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('Settings preserves explicit shared grants and composer binds the mailbox From identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shared-mail-ui-')),app=resolve(import.meta.dir,'..');
 try{
 const entry=join(dir,'entry.tsx');await writeFile(entry,`
 import React,{useState} from ${JSON.stringify(join(app,'node_modules/react/index.js'))};import{createRoot}from ${JSON.stringify(join(app,'node_modules/react-dom/client.js'))};
 import{GraphMailboxesView}from ${JSON.stringify(join(app,'src/react-app/domains/settings/pages/graph-mailboxes-view.tsx'))};import{MailComposer}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-composer.tsx'))};import{emptyCompose}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-compose-model.ts'))};import{MailClient}from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-client.ts'))};
 const parent={id:'parent',provider:'graph',displayName:'Signed in'};let selected;
 const client=new MailClient('http://127.0.0.1:43111','synthetic',async(url,init)=>{const body=init.body?JSON.parse(init.body):{};const path=new URL(url).pathname;
 if(path.endsWith('/graph/mailboxes')){window.__configured=body;selected={id:'shared',provider:'graph',displayName:body.address,identity:{address:body.address,kind:body.kind,credentialAccountId:'parent',state:'connected',read:true,write:body.writeConfirmed,writeConfirmed:body.writeConfirmed,sendAs:body.sendMode==='send_as',sendOnBehalf:body.sendMode==='send_on_behalf',sendMode:body.sendMode,sendAllowed:body.sendMode!=='none',sentItems:'signed_in_mailbox',capabilitySource:'administrator_confirmed',missingGrants:[],revision:1}};return Response.json({accountId:'shared',identity:selected.identity});}
 if(path.endsWith('/senders'))return Response.json([{id:'shared-sender',accountId:'shared',address:selected.identity.address,displayName:'',source:'administrator_confirmed',available:selected.identity.sendAllowed,signature:'',defaultNew:true,defaultReply:true,sendMode:'send_as'}]);
 if(path.endsWith('/drafts/query'))return Response.json({accountId:'shared',items:[],nextCursor:null});
 if(path.endsWith('/drafts/save'))return Response.json({id:body.draftId,version:{generation:'11111111-1111-4111-8111-111111111111',revision:1},updatedAt:0,deleted:false,subject:body.content.subject,content:body.content});
 throw Error('Unexpected fixture request');});
 function Fixture(){const[accounts,setAccounts]=useState([parent]),[compose,setCompose]=useState(false);window.__compose=()=>setCompose(true);return compose?React.createElement(MailComposer,{client,accounts,initial:{account:'shared',id:'22222222-2222-4222-8222-222222222222',version:null,content:emptyCompose(selected.identity.address)},onClose:()=>{},onSwitch:()=>{}}):React.createElement(GraphMailboxesView,{client,accounts,onChanged:()=>setAccounts([parent,selected])});}
 createRoot(document.getElementById('root')).render(React.createElement(Fixture));`);
 const built=await Bun.build({entrypoints:[entry],outdir:dir,target:'browser',alias:{'@':join(app,'src')},plugins:[{name:'fixture-zod',setup(build){build.onResolve({filter:/^zod$/},()=>({path:join(app,'../server/node_modules/zod/index.js')}));}}],minify:true});if(!built.success)throw Error(built.logs.map(String).join('\n'));
 await writeFile(join(dir,'index.html'),'<meta charset="utf-8"><div id="root"></div><script src="entry.js"></script>');
 const probe=join(dir,'probe.cjs');await writeFile(probe,`
 const{app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(dir,'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await win.loadFile(${JSON.stringify(join(dir,'index.html'))});const run=code=>win.webContents.executeJavaScript(code);const until=async code=>{for(let i=0;i<250;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout '+code);};
 await until("!!document.querySelector('form')");assert.equal(await run("document.querySelector('[aria-label=\\\"Administrator-confirmed sender permission\\\"]').value"),'none');
 await run("(()=>{const el=document.querySelector('input[type=email]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'team@example.com');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
 await run("document.querySelector('form').requestSubmit()");await until("!!window.__configured");assert.equal(await run('window.__configured.writeConfirmed'),false);assert.equal(await run('window.__configured.sendMode'),'none');
 await until("document.body.textContent.includes('Mailbox access verified')");await run('window.__compose()');await until("!!document.querySelector('[aria-label=\\\"Sender identity\\\"]')");assert.equal(await run("document.querySelector('[aria-label=\\\"Sender identity\\\"]').tagName"),'SELECT');assert.equal(await run("document.querySelector('[aria-label=\\\"Sender identity\\\"]').value"),'');assert.equal(await run("document.body.textContent.includes('Sending from this mailbox is not authorized')"),true);assert.equal(await run("document.body.textContent.includes('Sent Items are saved in the signed-in Microsoft account')"),true);console.log('SHARED_IDENTITY_PASS');win.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});`);
 const require=createRequire(resolve(app,'../desktop/package.json'));const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{const child=spawn(require('electron'),[probe],{env:{...process.env},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error(output+' renderer timeout'));},15000);child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});});if(result.code!==0)throw Error(result.output);expect(result.output).toContain('SHARED_IDENTITY_PASS');
 }finally{await rm(dir,{recursive:true,force:true});}
},20000);
