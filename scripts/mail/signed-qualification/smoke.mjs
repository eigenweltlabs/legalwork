// Remote first-launch diagnostic of the actual production main/runtime.
// --signed requires distribution verification and quarantine. Neither mode
// qualifies DMG installation, updates, uninstall or cross-version retention.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {signatureIdentity} from './policy.mjs';
const signed=process.argv.includes('--signed');
assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
const [sourceApp,evidenceArgument]=process.argv.slice(2),evidence=resolve(evidenceArgument);
const profile=join(homedir(),'Library/Application Support/com.eigenweltlabs.legalwork');
const application=join(homedir(),'Applications/LegalWork.app');
for(const path of [profile,application])await assert.rejects(access(path));
await mkdir(profile,{recursive:true,mode:0o700});await mkdir(evidence,{recursive:true});
await mkdir(dirname(application),{recursive:true});
execFileSync('ditto',[sourceApp,application],{timeout:120000});
if(signed) {
  execFileSync('xattr',['-w','com.apple.quarantine',`0081;${Math.floor(Date.now()/1000).toString(16)};LegalWorkQualification;`,application]);
  execFileSync('codesign',['--verify','--deep','--strict','--verbose=2',application]);
  const {spawnSync}=await import('node:child_process');
  const displayed=spawnSync('codesign',['--display','--verbose=4',application],{encoding:'utf8'});
  assert.equal(displayed.status,0);const identity=signatureIdentity(displayed.stderr);
  assert.equal(execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(application,'Contents/Info.plist')],{encoding:'utf8'}).trim(),'0.0.1');
  execFileSync('xcrun',['stapler','validate',application],{timeout:120000});
  execFileSync('spctl',['--assess','--type','execute','--verbose=2',application],{timeout:120000});
  await writeFile(join(evidence,'signed-assessment.json'),JSON.stringify({passed:true,identity,quarantine:execFileSync('xattr',['-p','com.apple.quarantine',application],{encoding:'utf8'}).trim()})+'\n');
}
await writeFile(join(profile,'mail-signed-qualification.json'),JSON.stringify({phase:'install',arch:process.arch,baseVersion:'0.0.1',targetVersion:'0.0.2',evidence,feed:'http://127.0.0.1:1/'}));
const child=spawn('open',['-n','-W','--stdout',join(evidence,'smoke-stdout.txt'),'--stderr',join(evidence,'smoke-stderr.txt'),application],{stdio:'inherit'});
child.once('error',error=>{void writeFile(join(evidence,'launch-error.txt'),String(error));});
child.once('exit',(code,signal)=>{void writeFile(join(evidence,'launch-exit.json'),JSON.stringify({code,signal}));});
try {
  const deadline=Date.now()+120000;
  let result;
  while(Date.now()<deadline) {
    try {const failure=JSON.parse(await readFile(join(evidence,'failure.json'),'utf8'));throw Error(JSON.stringify(failure));}catch(error){if(error.code!=='ENOENT')throw error;}
    try {result=JSON.parse(await readFile(join(evidence,'install.json'),'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!result) {
    // Names and PIDs only: never command arguments or environment values.
    const processes=execFileSync('ps',['-axo','pid,ppid,comm'],{encoding:'utf8',timeout:5000});
    for(const line of processes.split('\n')) {
      const match=line.match(/^\s*(\d+)\s+\d+\s+(.+)$/);
      if(match?.[2]===join(application,'Contents/MacOS/LegalWork')) {
        try {execFileSync('sample',[match[1],'1','-file',join(evidence,'timeout-main-sample.txt')],{timeout:5000});}
        catch(error) {await writeFile(join(evidence,'timeout-sample-error.txt'),String(error.message));}
      }
    }
    try {execFileSync('/usr/sbin/screencapture',['-x',join(evidence,'timeout-screen.png')],{timeout:5000});}
    catch(error) {await writeFile(join(evidence,'timeout-screen-error.txt'),String(error.message));}
    await writeFile(join(evidence,'timeout-processes.txt'),processes.split('\n').filter((line,index)=>index===0||/LegalWork|ShipIt|\/open$/.test(line)).join('\n')+'\n');
  }
  assert(result,'Actual packaged startup did not reach/complete fixture; inspect startup and LaunchServices logs');assert.equal(result.passed,true);
  await writeFile(join(evidence,'smoke-scope.json'),JSON.stringify({passed:true,scope:signed?'actual signed/notarized directory app, quarantined first launch and synthetic encrypted fixture':'actual main/runtime startup and retained-store fixture in fresh ad-hoc build',signedFirstLaunchAccepted:signed,signedLifecycleAccepted:false})+'\n');
} catch(error) {
  await writeFile(join(evidence,'smoke-failure.txt'),String(error));throw error;
} finally {
  child.kill(); // Stops only this controller's open waiter, not a user app.
}
