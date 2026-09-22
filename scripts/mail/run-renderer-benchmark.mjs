/** Parent for the actual built desktop runtime; never uses a user profile. */
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const [profileArg,outputArg]=process.argv.slice(2);assert(profileArg&&outputArg);
const profile=resolve(profileArg),output=resolve(outputArg),repository=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const metadata=JSON.parse(await readFile(join(profile,'benchmark-profile.json'),'utf8'));
assert.equal(metadata.kind,'legalwork-synthetic-benchmark');assert.equal(metadata.ownerId,'desktop-local');assert.equal(metadata.database,'mail/mail.sqlite');assert([100,100000].includes(metadata.count));
const baseline=JSON.parse(await readFile(resolve(profile,metadata.report),'utf8'));assert.equal(baseline.corpus.count,metadata.count);assert.equal(baseline.corpus.version,'legal-100k-v3');
const scratch=await mkdtemp(join(tmpdir(),'mail-renderer-probe-'));
const config=join(scratch,'probe.json');await writeFile(config,JSON.stringify({profile,output,repository,count:metadata.count,corpusSha256:baseline.corpus.sha256,sourceSha256:baseline.sourceSha256}));
const env={};for(const name of ['PATH','SystemRoot','WINDIR','TMP','TEMP','TMPDIR','GITHUB_SHA'])if(process.env[name])env[name]=process.env[name];
Object.assign(env,{LEGALWORK_ELECTRON_USERDATA:profile,LEGALWORK_DATA_DIR:join(profile,'runtime'),LEGALWORK_SERVER_CONFIG:join(profile,'runtime/server.json'),LEGALWORK_RUNTIME_DB:join(profile,'runtime/runtime.sqlite'),LEGALWORK_ENV_STORE:join(profile,'runtime/env.json'),LEGALWORK_TOKEN_STORE:join(profile,'runtime/tokens.json'),LEGALWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY:'1',HOME:join(profile,'home'),USERPROFILE:join(profile,'home'),APPDATA:join(profile,'os-roaming'),LOCALAPPDATA:join(profile,'os-local')});
try{
 const electron=createRequire(join(repository,'apps/desktop/package.json'))('electron');
 await new Promise((done,reject)=>{
  const child=spawn(electron,[join(repository,'scripts/mail/renderer-benchmark.cjs'),config],{env,stdio:'inherit'});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'}).on('error',()=>child.kill('SIGKILL'));else child.kill('SIGKILL');},20*60000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);code===0&&!timedOut?done():reject(Error(`renderer exit ${code}; deadline=${timedOut}`));});
 });
}finally{await rm(scratch,{recursive:true,force:true});}
