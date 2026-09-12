// Hosted-runner-only, synthetic filesystem/ACL diagnostics; never touch a real profile.
import {mkdtemp,mkdir,writeFile,readFile,realpath,readlink,readdir,symlink,rm,cp} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {linkTestModules} from './link-test-modules.mjs';
import {MAIL_WINDOWS_ACL_PROGRAM,enforceMailWindowsAcl} from '../../apps/server/src/mail/storage/windows-acl.ts';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true')throw Error('Hosted Windows runner required');
const root=await mkdtemp(join(tmpdir(),'mail-prerequisites-'));
const code=error=>typeof error?.code==='string'?error.code:'unknown';
try{
 const target=await realpath('apps/server/node_modules'),link=join(root,'node_modules');await symlink(target,link,'junction');
 const probe=join(root,'probe.mjs');await writeFile(probe,"import {z} from 'zod'; console.log(JSON.stringify({resolved:!!z.string}));");
 console.log(JSON.stringify({stage:'link-layout',linkTarget:await readlink(link),targetEntries:(await readdir(target)).slice(0,100)}));
 const direct={};for(const name of ['zod','fflate','better-sqlite3-multiple-ciphers']){try{direct[name]={real:await realpath(join(target,name)),link:await readlink(join(target,name)),manifest:JSON.parse(await readFile(join(target,name,'package.json'),'utf8')).name};}catch(error){direct[name]={error:code(error)};}}console.log(JSON.stringify({stage:'direct-layout',direct}));
 const found={};for(const name of ['zod','fflate','better-sqlite3-multiple-ciphers']){try{found[name]={real:await realpath(join(link,name)),manifest:JSON.parse(await readFile(join(link,name,'package.json'),'utf8')).name};}catch(error){found[name]={error:code(error)};}}
 const result=spawnSync(process.execPath,[probe],{encoding:'utf8',timeout:15000});console.log(JSON.stringify({stage:'junction',target,found,exit:result.status,stdout:result.stdout,stderr:result.stderr}));
 const repaired=join(root,'repaired');await mkdir(repaired);await linkTestModules(target,join(repaired,'node_modules'));await writeFile(join(repaired,'probe.mjs'),"import {z} from 'zod';import {zipSync} from 'fflate';console.log(JSON.stringify({resolved:!!z.string&&!!zipSync}));");const linked=spawnSync(process.execPath,[join(repaired,'probe.mjs')],{encoding:'utf8',timeout:15000});console.log(JSON.stringify({stage:'resolved-package-links',exit:linked.status,stdout:linked.stdout,stderr:linked.stderr}));if(linked.status!==0)process.exitCode=1;
 const nativeSource=await realpath(join(target,'better-sqlite3-multiple-ciphers'));const nativeCopy=join(root,'native-copy');await cp(nativeSource,nativeCopy,{recursive:true,filter:path=>!path.startsWith(join(nativeSource,'node_modules'))});console.log(JSON.stringify({stage:'native-copy',original:await readdir(join(nativeSource,'prebuilds')),copied:await readdir(join(nativeCopy,'prebuilds'))}));
 const directory=join(root,'private');await mkdir(directory);
 const started=Date.now();try{await enforceMailWindowsAcl(directory,true);const file=join(directory,'synthetic.txt');await writeFile(file,'synthetic');await enforceMailWindowsAcl(file,false);console.log(JSON.stringify({stage:'production-helper',passed:true,milliseconds:Date.now()-started}));}catch(error){console.log(JSON.stringify({stage:'production-helper',passed:false,error:code(error),milliseconds:Date.now()-started}));process.exitCode=1;}
 // Preserve the exact production operations, exposing only typed failure identifiers.
 const diagnostic=MAIL_WINDOWS_ACL_PROGRAM.replace("} catch { [Console]::Out.Write('failed'); exit 1 }","} catch { [Console]::Out.Write($_.Exception.GetType().FullName + ';' + $_.FullyQualifiedErrorId + ';' + $_.InvocationInfo.MyCommand.Name); exit 1 }");
 const executable=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 for(const environment of ['production','inherited','trusted-modules']){
  const tested=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(environment==='trusted-modules'?"Import-Module ($PSHOME + '/Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1') -ErrorAction Stop; Import-Module ($PSHOME + '/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; Import-Module ($PSHOME + '/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop;\n"+diagnostic:diagnostic,'utf16le').toString('base64')],{input:JSON.stringify({path:directory,directory:true}),encoding:'utf8',timeout:15000,env:environment==='production'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot}:environment==='inherited'?process.env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,TEMP:tmpdir(),TMP:tmpdir(),PSModulePath:join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules')}});
  console.log(JSON.stringify({stage:'acl',environment,exit:tested.status,signal:tested.signal,error:tested.error?code(tested.error):null,stdout:tested.stdout,stderr:tested.stderr.slice(0,8192)}));
 }
}finally{await rm(root,{recursive:true,force:true});}
