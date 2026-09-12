// Source-stamped, bounded CI evidence. Never archive profiles, keys or the built app.
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cpus,totalmem,release} from 'node:os';
const [name,command,...args]=process.argv.slice(2);
if(!/^[a-z][a-z0-9-]{0,63}$/.test(name??'')||!command)throw Error('Usage: qualification-step.mjs name command args...');
const directory='mail-qualification-evidence';await mkdir(directory,{recursive:true});
const log=join(directory,name+'.log'),started=new Date().toISOString();await writeFile(log,'');
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const dirty=execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim().length>0;
// Commands and arguments are fixed by the checked-in workflow, never user input.
const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],shell:process.platform==='win32'&&/^(pnpm|bun)$/.test(command)});
let bytes=0,overflow=false,spawnError=false,writes=Promise.resolve();
const record=(data,stream)=>{bytes+=data.length;if(bytes>32*1024*1024){overflow=true;child.kill('SIGKILL');return;}stream.write(data);writes=writes.then(()=>appendFile(log,data));};
child.stdout.on('data',data=>record(data,process.stdout));child.stderr.on('data',data=>record(data,process.stderr));
child.on('error',()=>{spawnError=true;});
const {code,signal}=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
await writes;
const result={name,source,dirty,started,finished:new Date().toISOString(),platform:process.platform,arch:process.arch,osRelease:release(),node:process.versions.node,memoryBytes:totalmem(),cpu:cpus()[0]?.model??null,command:[command,...args],code,signal,overflow,spawnError,passed:code===0&&!overflow&&!spawnError};
await writeFile(join(directory,name+'.json'),JSON.stringify(result,null,2)+'\n');
process.exitCode=result.passed?0:1;
