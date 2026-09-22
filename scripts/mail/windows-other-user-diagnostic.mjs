import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true');
const shell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const root=await mkdtemp(join(tmpdir(),'mail-second-user-probe-'));
const protect=String.raw`
$ErrorActionPreference='Stop'
Import-Module ($PSHOME + '/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
Import-Module ($PSHOME + '/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$path=[Console]::In.ReadToEnd() | ConvertFrom-Json
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')
$acl.SetAccessRule($rule);Set-Acl -LiteralPath $path -AclObject $acl
`;
try {
 const short=join(root,'short.sqlite'),long=join(root,"space ü $ apostrophe'",'x'.repeat(100),'y'.repeat(100),'z'.repeat(30),'long.sqlite');
 await mkdir(join(long,'..'),{recursive:true});
 for(const path of [short,long])await writeFile(path,'synthetic-private-file');
 assert(long.length>260);
 execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(protect,'utf16le').toString('base64')],{input:JSON.stringify(root),timeout:15000,stdio:['pipe','pipe','pipe']});
 for(const environmentKind of ['native'])for(const variant of ['instrumented'])for(const loadProfile of ['true','false'])for(const shortCommand of ['false','true'])for(const [label,path] of [['short',short],['long',long]]){
  const script=variant==='original'?'windows-other-user.ps1':variant==='directory'?'windows-other-user-directory.ps1':'windows-other-user-probe.ps1';
  const started=Date.now();
  const result=spawnSync(shell,['-NoProfile','-NonInteractive','-File',join('scripts/mail',script)],{input:JSON.stringify({path}),encoding:'utf8',timeout:45000,stdio:['pipe','pipe','pipe'],env:{...process.env,MAIL_OTHER_USER_LOAD_PROFILE:loadProfile,MAIL_OTHER_USER_SHORT_COMMAND:shortCommand,...(environmentKind==='native'?{PSModulePath:join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules')}:{})}});
  const ok=result.status===0&&!result.error,stdout=result.stdout??'',stderr=result.stderr??'';
  // Print only fixed diagnostic phases/types and the exact assertion result, never raw errors.
  const safe=(stdout+'\n'+stderr).split(/\r?\n/).filter(line=>/^(command_characters=[0-9]+|exception_(native_code|hresult)=-?[0-9]+|error_id=[A-Za-z0-9_,.+-]{1,256}|exception_file=[A-Za-z0-9_.-]{1,128}|module_probe=[A-Za-z.]+ directory=(?:True|False) manifest=(?:True|False)|mail_other_(os_user_denied|user_phase=[A-Za-z.-]+|user_qualification_failed(?: stage=[A-Za-z.-]+ exception=[A-Za-z0-9]+)?)|child_(exit=-?\d+ stdout_chars=\d+ stderr_chars=\d+|phase=[a-z-]+|(?:inner_)?exception=[A-Za-z0-9]+))$/.test(line));
  console.log(JSON.stringify({environmentKind,variant,loadProfile,shortCommand,pathKind:label,pathCharacters:path.length,ok,elapsedMs:Date.now()-started,diagnostics:safe}));
 }
}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
