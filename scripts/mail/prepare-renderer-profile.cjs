// Separate OS-vault preparation; the measured app keeps its normal ESM startup.
const {app,safeStorage}=require('electron');
const {readFile,writeFile,mkdir}=require('node:fs/promises');
const {join}=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
(async()=>{
 const config=JSON.parse(await readFile(process.argv[2],'utf8'));app.setPath('userData',config.profile);
 await app.whenReady();assert.equal(safeStorage.isEncryptionAvailable(),true,'real OS vault required');
 const metadata=JSON.parse(await readFile(join(config.profile,'benchmark-profile.json'),'utf8'));
 assert.equal(metadata.kind,'legalwork-synthetic-benchmark');assert.equal(metadata.ownerId,'desktop-local');
 const {enforceMailWindowsAcl}=await import(pathToFileURL(join(config.repository,'apps/desktop/server/dist/mail/storage/windows-acl.js')).href);
 await enforceMailWindowsAcl(join(config.profile,'mail'),true);
 const keyPath=join(config.profile,'mail/mail-key-v1.json');
 await writeFile(keyPath,JSON.stringify({version:1,wrappedKey:safeStorage.encryptString(metadata.key).toString('base64')}),{mode:0o600,flag:'wx'});metadata.key='';await enforceMailWindowsAcl(keyPath,false);
 const workspace=join(config.profile,'synthetic-workspace');await mkdir(workspace,{recursive:true});
 await writeFile(join(config.profile,'legalwork-workspaces.json'),JSON.stringify({selectedId:'benchmark-workspace',activeId:'benchmark-workspace',watchedId:null,workspaces:[{id:'benchmark-workspace',name:'Synthetic benchmark',path:workspace,workspaceType:'local',preset:'starter'}]}));
 console.log('MAIL_RENDERER_PROFILE_PREPARED');app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
