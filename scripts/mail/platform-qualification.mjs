import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile,mkdir,copyFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),server=join(root,'apps/server'),desktop=join(root,'apps/desktop');
const require=createRequire(join(desktop,'package.json')),serverRequire=createRequire(join(server,'package.json'));
const folder=await mkdtemp(join(tmpdir(),'legalwork-platform-')),build=join(folder,'build'),profile=join(folder,"profile space ü $ apostrophe'");
try {
  await mkdir(profile,{mode:0o700});await writeFile(join(folder,'package.json'),'{"type":"module"}');
  await symlink(join(server,'node_modules'),join(folder,'node_modules'),process.platform==='win32'?'junction':'dir');
  execFileSync(process.execPath,[serverRequire.resolve('typescript/bin/tsc'),'--outDir',build,'--rootDir','src','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--strict','--skipLibCheck','--types','node,bun-types','src/mail/runtime/maintenance-worker.ts','src/mail/storage/search.ts'],{cwd:server,stdio:'inherit',timeout:60000});
  for(const name of ['mail-key-store.mjs','mail-store-maintenance.mjs'])await copyFile(join(desktop,'electron',name),join(build,name));
  const electronEnv={};for(const name of ['HOME','USERPROFILE','SystemRoot','WINDIR','PATH','TMP','TEMP','TMPDIR','LOCALAPPDATA','APPDATA'])if(process.env[name])electronEnv[name]=process.env[name];
  execFileSync(require('electron'),[join(root,'scripts/mail/platform-probe.cjs'),build,profile,process.env.MAIL_EXPECT_ARCH??process.arch],{stdio:'inherit',timeout:180000,env:electronEnv});
  const result=JSON.parse(await readFile(join(profile,'qualification-result.json'),'utf8'));
  if(process.platform==='win32'){
    execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',join(root,'scripts/mail/windows-other-user.ps1')],{input:JSON.stringify({path:result.privatePath}),stdio:['pipe','inherit','inherit'],timeout:60000});
    result.otherUserDenied=true;
  }
  if(process.platform==='darwin' && process.env.GITHUB_ACTIONS==='true'){
    const control=join('/tmp',`legalwork-mail-control-${Date.now()}-${process.pid}`);
    try {
      await writeFile(control,'synthetic-readable-control',{mode:0o644});
      execFileSync('/usr/bin/sudo',['-n','-u','nobody','/bin/sh','-c','[ "$(cat "$1")" = "synthetic-readable-control" ] || exit 1; if cat "$2" >/dev/null 2>&1; then exit 1; fi; printf "mail_other_os_user_denied\\n"','mail-qualification',control,result.privatePath],{stdio:'inherit',timeout:20000});
      result.otherUserDenied=true;
    } finally {await rm(control,{force:true});}
  }
  delete result.privatePath;console.log(JSON.stringify(result));
} finally {await rm(folder,{recursive:true,force:true});}
