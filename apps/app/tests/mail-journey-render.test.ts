import {build as buildFixtureStyle} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';
test('mail attachment opens internally, prepares a chosen chat and returns to its source',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mail-journey-ui-')),appRoot=resolve(import.meta.dir,'..'),fixtures=join(import.meta.dir,'fixtures/mail-journey');
 try{
  const built=await Bun.build({entrypoints:[join(fixtures,'entry.tsx')],target:'browser',outdir:directory,alias:{'@':join(appRoot,'src'),'react/jsx-dev-runtime':join(appRoot,'node_modules/react/jsx-dev-runtime.js'),'react/jsx-runtime':join(appRoot,'node_modules/react/jsx-runtime.js')},minify:true,plugins:[{name:'zod',setup(build){build.onResolve({filter:/^zod$/},()=>({path:join(appRoot,'node_modules/zod/index.js')}));}}]});
  await buildFixtureStyle({configFile:false,root:appRoot,plugins:tailwindcss(),logLevel:'error',build:{outDir:join(directory,'styles'),emptyOutDir:true,rollupOptions:{input:join(appRoot,'src/app/index.css'),output:{assetFileNames:'[name][extname]'}}}});
  if(!built.success)throw Error(built.logs.map(String).join('\n'));await writeFile(join(directory,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="styles/index.css"><link rel="stylesheet" href="entry.css"><style>body{margin:0}section[aria-label="Chosen workspace chat"]{padding:24px}textarea{width:90%;height:220px;border:1px solid #ccc;padding:12px}aside[aria-label="Internal attachment viewer"]{position:fixed;right:0;top:35%;width:50%;background:white;border:1px solid #ddd;padding:12px;box-shadow:0 4px 24px #0002}</style><div id="root"></div><script type="module" src="entry.js"></script>');
  const require=createRequire(resolve(appRoot,'../desktop/package.json'));
  const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{const child=spawn(require('electron'),[join(fixtures,'probe.cjs'),join(directory,'profile'),join(directory,'index.html'),resolve(appRoot,'../../docs/mail/evidence/eig-174')],{env:{HOME:process.env.HOME,PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error(output));},15000);child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);done({code,output});});});
  if(result.code!==0)throw Error(result.output);expect(result.output).toContain('MAIL_JOURNEY_PASS');
 }finally{await rm(directory,{recursive:true,force:true});}
},20000);
