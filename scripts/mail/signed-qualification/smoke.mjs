// Remote preparation only: actual production main/runtime in an ad-hoc --dir
// build. No signed distribution, Gatekeeper or updater acceptance is inferred.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
const [sourceApp,evidenceArgument]=process.argv.slice(2),evidence=resolve(evidenceArgument);
const profile=join(homedir(),'Library/Application Support/com.eigenweltlabs.legalwork');
const application=join(homedir(),'Applications/LegalWork.app');
for(const path of [profile,application])await assert.rejects(access(path));
await mkdir(profile,{recursive:true,mode:0o700});await mkdir(evidence,{recursive:true});
await mkdir(dirname(application),{recursive:true});
execFileSync('ditto',[sourceApp,application],{timeout:120000});
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
  assert(result,'Actual ad-hoc startup did not reach/complete fixture; inspect startup and LaunchServices logs');assert.equal(result.passed,true);
  await writeFile(join(evidence,'smoke-scope.json'),JSON.stringify({passed:true,scope:'actual main/runtime startup and retained-store fixture in fresh ad-hoc build',signedLifecycleAccepted:false})+'\n');
} catch(error) {
  await writeFile(join(evidence,'smoke-failure.txt'),String(error));throw error;
} finally {
  child.kill(); // Stops only this controller's open waiter, not a user app.
}
