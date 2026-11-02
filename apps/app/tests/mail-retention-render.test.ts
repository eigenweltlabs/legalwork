import {buildBrowserFixture,electronDisplayEnvironment} from './fixtures/build-browser';
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';
test('retention Settings confirms deletion, pauses Mail and clears backup passphrase',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mail-retention-ui-')),appRoot=resolve(import.meta.dir,'..'),fixtures=join(import.meta.dir,'fixtures/mail-retention');
 try{
  await buildBrowserFixture({entrypoints:[join(fixtures,'entry.tsx')],outdir:directory,alias:{'@':join(appRoot,'src'),'react/jsx-dev-runtime':join(appRoot,'node_modules/react/jsx-dev-runtime.js'),'react/jsx-runtime':join(appRoot,'node_modules/react/jsx-runtime.js')},minify:true});await writeFile(join(directory,'index.html'),'<div id="root"></div><script src="entry.js"></script>');
  const require=createRequire(resolve(appRoot,'../desktop/package.json'));
  const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{const child=spawn(require('electron'),[join(fixtures,'probe.cjs'),join(directory,'profile'),join(directory,'index.html')],{env:{...electronDisplayEnvironment(),HOME:process.env.HOME,PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error(output));},15000);child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);done({code,output});});});
  if(result.code!==0)throw Error(result.output);expect(result.output).toContain('RETENTION_UI_PASS');
 }finally{await rm(directory,{recursive:true,force:true});}
},20000);
