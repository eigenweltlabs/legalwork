import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {animatedGif,animatedPng} from '../../desktop/electron/testing/mail-animation-fixtures.mjs';

test('actual Chromium decodes the safe two-frame GIF and APNG security fixtures',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-animation-security-')),appRoot=resolve(import.meta.dir,'..');
 try {
  const png=await readFile(resolve(appRoot,'../server/src/mail/testing/html-fixtures/brand.png'));
  const fixtures=[{type:'image/gif',data:animatedGif().toString('base64')},{type:'image/png',data:animatedPng(png).toString('base64')}];
  await writeFile(join(root,'index.html'),'<!doctype html><title>Synthetic animation fixture</title>');
  const probe=join(root,'probe.cjs');await writeFile(probe,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await win.loadFile(${JSON.stringify(join(root,'index.html'))});const results=await win.webContents.executeJavaScript(${JSON.stringify('(async()=>{const results=[];for(const fixture of '+JSON.stringify(fixtures)+'){const decoder=new ImageDecoder({type:fixture.type,data:Uint8Array.from(atob(fixture.data),c=>c.charCodeAt(0))});await decoder.tracks.ready;const result=await decoder.decode({frameIndex:1});results.push({frames:decoder.tracks.selectedTrack.frameCount,width:result.image.displayWidth,height:result.image.displayHeight});result.image.close();decoder.close();}return results;})()')});assert.deepEqual(results,[{frames:2,width:1,height:1},{frames:2,width:72,height:40}]);console.log('MAIL_ANIMATION_SECURITY_PASS');win.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});`);
  const executable=process.env.LEGALWORK_TEST_ELECTRON??createRequire(join(appRoot,'../desktop/package.json'))('electron');
  const result=await new Promise<{code:number|null,output:string}>((done,reject)=>{const child=spawn(executable,[probe],{env:{HOME:process.env.HOME,PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,output});});});if(result.code!==0)throw Error(result.output);expect(result.output).toContain('MAIL_ANIMATION_SECURITY_PASS');
 }finally{await rm(root,{recursive:true,force:true});}
},20000);
