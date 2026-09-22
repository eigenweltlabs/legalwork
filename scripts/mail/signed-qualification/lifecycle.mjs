// Runs only on a fresh GitHub-hosted Mac. Never copies or reads a user profile.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,readdir,stat,rm,access} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {signatureIdentity,assertUpdated} from './policy.mjs';
assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
const [artifacts,evidenceArgument]=process.argv.slice(2),evidence=resolve(evidenceArgument);
const appPath=join(homedir(),'Applications/LegalWork.app');
const profile=join(homedir(),'Library/Application Support/com.eigenweltlabs.legalwork');
for(const path of [appPath,profile])await assert.rejects(access(path),'Fresh runner required; existing app/profile must never be overwritten');
await mkdir(evidence,{recursive:true});await mkdir(profile,{recursive:true,mode:0o700});
await mkdir(join(homedir(),'Applications'),{recursive:true});
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const baseVersion='0.0.1',targetVersion='0.0.2';
const baseDir=join(artifacts,'base'),targetDir=join(artifacts,'target');
async function artifact(directory,suffix) {const entries=(await readdir(directory)).filter(name=>name.endsWith(suffix));assert.equal(entries.length,1,`${directory} ${suffix}`);return join(directory,entries[0]);}
const baseDmg=await artifact(baseDir,'.dmg'),targetDmg=await artifact(targetDir,'.dmg');
const zip=await artifact(targetDir,'.zip');
const manifest=await readFile(join(targetDir,'latest-mac.yml'));
const files=new Map([['/latest-mac.yml',{bytes:manifest}],['/'+encodeURIComponent(basename(zip)),{path:zip,size:(await stat(zip)).size}]]);
const requests=[];
const feed=createServer((request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');const file=files.get(url.pathname);
  if(!file||!['GET','HEAD'].includes(request.method)){response.writeHead(404).end();return;}
  requests.push({path:url.pathname,method:request.method});
  response.writeHead(200,{'Content-Length':file.bytes?.length??file.size,'Content-Type':file.bytes?'text/yaml':'application/zip'});
  if(request.method==='HEAD')response.end();else if(file.bytes)response.end(file.bytes);else createReadStream(file.path).pipe(response);
});
await new Promise(resolve=>feed.listen(0,'127.0.0.1',resolve));
const config={arch:process.arch,baseVersion,targetVersion,evidence,feed:`http://127.0.0.1:${feed.address().port}/`,phase:'install'};
const control=join(profile,'mail-signed-qualification.json');
const identity=[];
async function validateApp(version) {
  run('codesign',['--verify','--deep','--strict','--verbose=2',appPath]);
  // codesign emits public identity metadata on stderr, never private credentials.
  // execFileSync returns stdout; explicitly collect stderr for codesign metadata.
  const {spawnSync}=await import('node:child_process');
  const displayed=spawnSync('codesign',['--display','--verbose=4',appPath],{encoding:'utf8'});
  assert.equal(displayed.status,0);const signed=signatureIdentity(displayed.stderr);
  if(identity.length)assert.deepEqual(signed,identity[0]);else identity.push(signed);
  assert.equal(run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(appPath,'Contents/Info.plist')]).trim(),version);
  run('xcrun',['stapler','validate',appPath]);run('spctl',['--assess','--type','execute','--verbose=2',appPath]);
  return signed;
}
async function install(dmg,version) {
  const mount=join(evidence,'mount');await mkdir(mount,{recursive:true});
  run('hdiutil',['verify',dmg]);run('xcrun',['stapler','validate',dmg]);
  run('hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg]);
  try {await access(join(mount,'LegalWork.app'));run('ditto',[join(mount,'LegalWork.app'),appPath]);}
  finally {run('hdiutil',['detach',mount]);}
  // Launch Services must see quarantine; do not remove it or bypass Gatekeeper.
  run('xattr',['-w','com.apple.quarantine',`0081;${Math.floor(Date.now()/1000).toString(16)};LegalWorkQualification;`,appPath]);
  await validateApp(version);
}
async function waitResult(name,timeout=240000) {
  const until=Date.now()+timeout;
  while(Date.now()<until){
    try {const failure=JSON.parse(await readFile(join(evidence,'failure.json'),'utf8'));throw Error(JSON.stringify(failure));}catch(error){if(error.code!=='ENOENT')throw error;}
    try{return JSON.parse(await readFile(join(evidence,name+'.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error(`Timed out waiting for actual signed application stage ${name}; no acceptance inferred`);
}
async function launch(name) {
  await writeFile(control,JSON.stringify(config));
  const child=spawn('open',['-n','-W','--stdout',join(evidence,name+'-stdout.txt'),'--stderr',join(evidence,name+'-stderr.txt'),appPath],{stdio:'inherit'});child.once('error',error=>{void writeFile(join(evidence,'failure.json'),JSON.stringify({passed:false,stage:'launch-services',message:error.message}));});
  child.once('exit',(code,signal)=>{void writeFile(join(evidence,name+'-launch-services.json'),JSON.stringify({code,signal}));});
  const result=await waitResult(name);
  // The application records its PID; ensure it actually quits before changing files.
  const until=Date.now()+30000;
  while(Date.now()<until){try{process.kill(result.pid,0);}catch(error){if(error.code==='ESRCH')return result;throw error;}await new Promise(resolve=>setTimeout(resolve,200));}
  throw Error(`Signed app did not quit after ${name}`);
}
try {
  await install(baseDmg,baseVersion);const installed=await launch('install');
  assert.equal(installed.version,baseVersion);
  const retainedBefore=hash(await readFile(join(profile,'qualification-expectations.json')));
  config.phase='update';const updated=await launch('updated');assertUpdated(updated,config);
  await validateApp(targetVersion);
  assert(requests.some(request=>request.path==='/latest-mac.yml'));
  assert(requests.some(request=>request.path.endsWith('.zip')));
  assert.equal(hash(await readFile(join(profile,'qualification-expectations.json'))),retainedBefore);
  // DMG apps have no uninstaller: remove the installed bundle, preserving the
  // normal application-data directory, then reinstall from the notarized DMG.
  await rm(appPath,{recursive:true});await assert.rejects(access(appPath));
  assert.equal(hash(await readFile(join(profile,'qualification-expectations.json'))),retainedBefore);
  config.phase='reinstall';await install(targetDmg,targetVersion);
  const reinstalled=await launch('reinstall');assertUpdated(reinstalled,config);
  await writeFile(join(evidence,'acceptance.json'),JSON.stringify({passed:true,source:process.env.QUALIFICATION_SOURCE,arch:process.arch,identity:identity[0],baseVersion,targetVersion,distribution:'DMG mounted, installed, quarantined, assessed, launched',update:'production preload/IPC -> electron-updater -> Squirrel replacement and relaunch',retainedData:'synthetic encrypted mail fixture in normal application profile',uninstall:'bundle removal preserves application profile; reinstall reopens same wrapped key',limits:['same-source qualification versions, not a prior published release','synthetic mail fixture is isolated from provider runners','loopback updater feed; production feed routing not exercised','no actual suspend/login/power lifecycle']},null,2)+'\n');
} catch(error) {
  await writeFile(join(evidence,'controller-failure.json'),JSON.stringify({passed:false,message:String(error?.message??error).slice(0,4000)})+'\n');throw error;
} finally {
  feed.closeAllConnections();await new Promise(resolve=>feed.close(resolve));
  // The runner is disposable; never upload this profile, wrapped key or signed apps.
}
