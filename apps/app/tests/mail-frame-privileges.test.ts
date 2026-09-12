import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('opaque mail frame has no production preload, Node, parent storage or native mail privileges',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-frame-privileges-')),appRoot=resolve(import.meta.dir,'..'),name='.mail-frame-'+randomUUID(),entry=join(appRoot,'tests',name+'.ts');
 try{
  await writeFile(entry,`import {mailDocument} from '../src/react-app/domains/mail/mail-html';const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.srcdoc=mailDocument('<script>window.senderRan=true</script><p>Untrusted message</p><img src="https://tracker.invalid/a" onerror="window.senderRan=true">',new Map(),new Map(),crypto.randomUUID()).html;document.body.append(frame);window.fixtureReady=true;`);
  const build=await Bun.build({entrypoints:[entry],outdir:root,target:'browser',format:'esm'});if(!build.success)throw Error(String(build.logs));
  await writeFile(join(root,'index.html'),'<body><script type="module" src="./'+name+'.js"></script>');
  const probe=join(root,'probe.cjs');await writeFile(probe,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(resolve(appRoot,'../desktop/electron/preload.mjs'))},sandbox:false,contextIsolation:true,nodeIntegration:false}});const requests=[];win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,callback)=>{requests.push(request.url);callback({cancel:true});});await win.loadFile(${JSON.stringify(join(root,'index.html'))});let frame;for(let i=0;i<100;i++){frame=win.webContents.mainFrame.frames.find(frame=>frame.url==='about:srcdoc');if(frame&&await win.webContents.executeJavaScript('!!window.__LEGALWORK_ELECTRON__&&!!window.fixtureReady'))break;await new Promise(r=>setTimeout(r,20));}assert(frame);assert.equal(await win.webContents.executeJavaScript('typeof window.__LEGALWORK_ELECTRON__.mailImages'),'function');const result=await frame.executeJavaScript('(()=>{let parentDenied=false;try{parent.localStorage.getItem(\"probe\")}catch{parentDenied=true}return{node:typeof require,process:typeof process,bridge:typeof window.__LEGALWORK_ELECTRON__,senderRan:!!window.senderRan,parentDenied}})()');assert.deepEqual(result,{node:'undefined',process:'undefined',bridge:'undefined',senderRan:false,parentDenied:true});assert.deepEqual(requests,[]);console.log('MAIL_FRAME_PRIVILEGES_PASS');win.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});`);
  const executable=process.env.LEGALWORK_TEST_ELECTRON??createRequire(join(appRoot,'../desktop/package.json'))('electron');
  const result=await new Promise<{code:number|null,output:string}>((done,reject)=>{const child=spawn(executable,[probe],{env:{HOME:process.env.HOME,PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});});if(result.code!==0)throw Error(result.output);expect(result.output).toContain('MAIL_FRAME_PRIVILEGES_PASS');
 }finally{await rm(entry,{force:true});await rm(root,{recursive:true,force:true});}
},20000);
