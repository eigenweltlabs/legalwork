import {linkTestModules} from '../../../scripts/mail/link-test-modules.mjs';
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {authorizationUrl} from '../src/react-app/domains/mail/mail-onboarding-client';
test('authorization links cannot escape fixed provider/account-type endpoints',()=>{
 const query='?response_type=code&code_challenge_method=S256';
 expect(authorizationUrl('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'+query,'outlook')).toContain('/consumers/');
 for(const url of ['https://evil.test/authorize','https://login.microsoftonline.com@evil.test/consumers/oauth2/v2.0/authorize','https://login.microsoftonline.com/common/oauth2/v2.0/authorize','https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize#fragment'])expect(()=>authorizationUrl(url+query,'outlook')).toThrow();
 expect(()=>authorizationUrl('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'+query,'microsoft-work')).toThrow();
});
test('actual renderer completes browser onboarding and confines iCloud passwords to the local request',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-onboarding-')),app=resolve(import.meta.dir,'..');const calls:{path:string;body:Record<string,unknown>}[]=[];let release:()=>void=()=>{};
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'X-LegalWork-Host-Token,Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  if(request.method==='OPTIONS')return new Response(null,{headers});expect(request.headers.get('X-LegalWork-Host-Token')).toBe('synthetic');
  const path=new URL(request.url).pathname,body=request.method==='POST'?await request.json().catch(()=>({})):{};calls.push({path,body});let value:unknown;
  if(path==='/mail/v1/connections')value={connectionId:'oauth-one',authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&code_challenge_method=S256',expiresAt:Date.now()+60000};
  else if(path==='/mail/v1/connections/oauth-one')value={state:'connected',connectionId:'oauth-one',expiresAt:Date.now()+60000,accountId:'gmail-one',renewable:true};
  else if(path==='/mail/v1/imap/connections'){await new Promise<void>(resolve=>{release=resolve;});value={accountId:'imap-one',provider:'imap'};}
  else value={cancelled:true};
  return Response.json(value,{headers});
 }});
 try {
  await linkTestModules(join(app,'node_modules'),join(root,'node_modules'));
  const entry=join(root,'entry.tsx');await writeFile(entry,`
    import React from ${JSON.stringify(join(app,'node_modules/react/index.js'))};
    import {createRoot} from ${JSON.stringify(join(app,'node_modules/react-dom/client.js'))};
    import {MailOnboarding} from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-onboarding.tsx'))};
    import {MailClient} from ${JSON.stringify(join(app,'src/react-app/domains/mail/mail-client.ts'))};
    window.__opened=[];window.__changed=0;window.__LEGALWORK_ELECTRON__={shell:{openExternal:async url=>window.__opened.push(url)}};
    createRoot(document.getElementById('root')).render(<MailOnboarding client={new MailClient('http://127.0.0.1:${server.port}','synthetic')} accounts={[]} onChanged={()=>window.__changed++} onClose={()=>{}}/>);
  `);
  const built=await Bun.build({entrypoints:[entry],outdir:root,target:'browser',alias:{'@':join(app,'src')},plugins:[{name:'fixture-zod',setup(build){build.onResolve({filter:/^zod$/},()=>({path:join(app,'node_modules/zod/index.js')}));}}],minify:true});if(!built.success)throw Error(built.logs.map(String).join('\n'));
  await writeFile(join(root,'index.html'),'<meta charset="utf-8"><div id="root"></div><script src="entry.js"></script>');
  const probe=join(root,'probe.cjs');await writeFile(probe,`
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(join(root,'profile'))});
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      await win.loadFile(${JSON.stringify(join(root,'index.html'))});const run=code=>win.webContents.executeJavaScript(code);
      const until=async code=>{for(let i=0;i<200;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout '+code)};
      await until("!!document.querySelector('form')");
      await run("document.querySelector('form').requestSubmit()");await until('window.__changed===1');
      assert.equal(await run('window.__opened.length'),1);
      await run("document.querySelector('select').value='icloud';document.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}))");
      await until("!!document.querySelector('input[type=password]')");
      await run("(()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [selector,value] of [['input[autocomplete=username]','demo@icloud.com'],['input[type=password]','synthetic-app-password']]){const el=document.querySelector(selector);setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}})()");
      await run("document.querySelector('form').requestSubmit()");await until("document.body.textContent.includes('Connecting…')");
      assert.equal(await run("document.querySelector('input[type=password]').value"),'');
      assert.equal(await run("JSON.stringify(localStorage).includes('synthetic-app-password')"),false);
      await new Promise(r=>setTimeout(r,100));
      await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel').click()");
      await until("document.body.textContent.includes('Cancellation requested.')");
      assert.equal(await run('window.__changed'),1);console.log('ONBOARDING_PASS');win.destroy();app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});
  `);
  const require=createRequire(resolve(app,'../desktop/package.json'));
  const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{
   const child=spawn(require('electron'),[probe],{env:{PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})},stdio:['ignore','pipe','pipe']});let output='';
   const timer=setTimeout(()=>{child.kill();reject(Error(output+' renderer timeout'));},15000);
   child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});
  });if(result.code!==0)throw Error(result.output);expect(result.output).toContain('ONBOARDING_PASS');
  const imap=calls.find(call=>call.path==='/mail/v1/imap/connections');expect(imap?.body.host).toBe('imap.mail.me.com');expect(imap?.body.port).toBe(993);expect(imap?.body.password).toBe('synthetic-app-password');expect(calls.some(call=>call.path===`/mail/v1/imap/connections/${imap?.body.requestId}/cancel`)).toBe(true);
 } finally {release();server.stop(true);await rm(root,{recursive:true,force:true});}
},20000);
