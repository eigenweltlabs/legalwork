// Hosted-runner-only, synthetic filesystem/ACL diagnostics; never touch a real profile.
import {mkdtemp,mkdir,writeFile,readFile,realpath,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {MAIL_WINDOWS_ACL_PROGRAM} from '../../apps/server/src/mail/storage/windows-acl.ts';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true')throw Error('Hosted Windows runner required');
const root=await mkdtemp(join(tmpdir(),'mail-prerequisites-'));
const code=error=>typeof error?.code==='string'?error.code:'unknown';
try{
 const target=await realpath('apps/server/node_modules'),link=join(root,'node_modules');await symlink(target,link,'junction');
 const probe=join(root,'probe.mjs');await writeFile(probe,"import {z} from 'zod'; console.log(JSON.stringify({resolved:!!z.string}));");
 const found={};for(const name of ['zod','fflate','better-sqlite3-multiple-ciphers']){try{found[name]={real:await realpath(join(link,name)),manifest:JSON.parse(await readFile(join(link,name,'package.json'),'utf8')).name};}catch(error){found[name]={error:code(error)};}}
 const result=spawnSync(process.execPath,[probe],{encoding:'utf8',timeout:15000});console.log(JSON.stringify({stage:'junction',target,found,exit:result.status,stdout:result.stdout,stderr:result.stderr}));
 const directory=join(root,'private');await mkdir(directory);
 // Preserve the exact production operations, exposing only typed failure identifiers.
 const diagnostic=MAIL_WINDOWS_ACL_PROGRAM.replace("} catch { [Console]::Out.Write('failed'); exit 1 }","} catch { [Console]::Out.Write($_.Exception.GetType().FullName + ';' + $_.FullyQualifiedErrorId); exit 1 }");
 const executable=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 for(const environment of ['production','inherited']){
  const tested=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(diagnostic,'utf16le').toString('base64')],{input:JSON.stringify({path:directory,directory:true}),encoding:'utf8',timeout:15000,env:environment==='production'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot}:process.env});
  console.log(JSON.stringify({stage:'acl',environment,exit:tested.status,stdout:tested.stdout,stderr:tested.stderr.slice(0,8192)}));
 }
}finally{await rm(root,{recursive:true,force:true});}
