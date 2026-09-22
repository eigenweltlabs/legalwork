// Runs inside the signed production main process after its normal window loads.
// Uses production preload/IPC updater commands; only feed locations are replaced.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {createMailKeyStore} from './mail-key-store.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function qualifySignedApp({app,win,safeStorage}) {
  const profile=app.getPath('userData');
  const config=JSON.parse(await readFile(join(profile,'mail-signed-qualification.json'),'utf8'));
  const record=async(name,value)=>{const destination=join(config.evidence,name+'.json');await writeFile(destination+'.tmp',JSON.stringify(value)+'\n');await rename(destination+'.tmp',destination);};
  let stage='identity';
  try {
    assert.equal(app.isPackaged,true);assert.equal(process.platform,'darwin');assert.equal(process.arch,config.arch);
    assert.equal(app.getName(),'LegalWork');assert.equal(safeStorage.isEncryptionAvailable(),true);
    const version=app.getVersion();assert([config.baseVersion,config.targetVersion].includes(version));
    stage='retained-mail-store';
    // Separate fixture store in the real application profile: no account is
    // registered with the running app, so synthetic credentials cannot be sent.
    const directory=join(profile,'qualification-mail');await mkdir(directory,{recursive:true,mode:0o700});
    const key=await createMailKeyStore({directory,safeStorage}).load({allowCreate:config.phase==='install'});
    let db;
    try {
      const module=name=>import(pathToFileURL(join(process.resourcesPath,'app.asar/server/dist/mail/storage',name+'.js')).href);
      const {openEncryptedMailDatabase}=await module('database'),{migrateMailSchema,MAIL_SCHEMA_VERSION}=await module('schema');
      const {MailRepository}=await module('repository'),{MailCredentialRepository}=await module('credentials');
      const {SenderIdentityRepository}=await module('sender-identities'),{OutboxStore}=await module('outbox'),{MailContentStore}=await module('content-store');
      db=await openEncryptedMailDatabase({path:join(directory,'mail.sqlite'),key});migrateMailSchema(db);
      const owner='signed-qualification',account='synthetic',store=new OutboxStore(db,owner);
      if(config.phase==='install') {
        assert.equal(version,config.baseVersion);
        new MailRepository(db,owner).createAccount({id:account,provider:'gmail',displayName:'Synthetic offline qualification'});
        const credentials=new MailCredentialRepository(db,owner);
        credentials.connect(account,{provider:'gmail',clientId:'synthetic.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'synthetic'},null,{accessToken:'synthetic-never-sent',expiresAt:Date.now()+86400000,grantedScopes:['openid','email','https://www.googleapis.com/auth/gmail.modify'],refreshToken:{action:'replace',value:'synthetic-never-sent'}});
        const identity=new SenderIdentityRepository(db,owner).replace(account,credentials.status(account).version.generation,[{address:'sender@example.test',displayName:'Synthetic',primary:true,default:true}])[0];
        const draft=store.local.saveDraft(account,{draftId:randomUUID(),expected:null,content:{senderIdentityId:identity.id,from:identity.address,to:['recipient@example.test'],subject:'Signed upgrade retained draft',text:'synthetic_signed_retention_marker'}});
        const action=await store.queue(account,{draftId:draft.id,version:draft.version,replayKey:randomUUID()});
        const locator={provider:'gmail',messageId:'offline'};
        new MailRepository(db,owner).ingestMessage(account,{locator,subject:'Retained original',rfcMessageId:null,memberships:[]});
        const part=await new MailContentStore(db,owner).writePart(account,locator,{kind:'raw',maxBytes:1024},[Buffer.from('synthetic_signed_original')]);
        await writeFile(join(profile,'qualification-expectations.json'),JSON.stringify({draftId:draft.id,actionId:action.id,partId:part.id,draft:store.local.readDraft(account,{draftId:draft.id}),action:store.item(account,action.id),mimeHash:hash(store.row(account,action.id).mime_bytes),wrappedKeyHash:hash(await readFile(join(directory,'mail-key-v1.json')))}));
      }
      const expected=JSON.parse(await readFile(join(profile,'qualification-expectations.json'),'utf8'));
      assert.deepEqual(store.local.readDraft(account,{draftId:expected.draftId}),expected.draft);
      assert.deepEqual(store.item(account,expected.actionId),expected.action);assert.equal(expected.action.state,'queued');
      assert.equal(hash(store.row(account,expected.actionId).mime_bytes),expected.mimeHash);
      assert.equal(Buffer.concat([...new MailContentStore(db,owner).read(account,expected.partId)]).toString(),'synthetic_signed_original');
      assert.equal(hash(await readFile(join(directory,'mail-key-v1.json'))),expected.wrappedKeyHash);
      db.close();db=undefined;
      assert.equal((await readFile(join(directory,'mail.sqlite'))).includes(Buffer.from('synthetic_signed_retention_marker')),false);
      await record(config.phase==='update'&&version===config.targetVersion?'updated':config.phase,{passed:true,pid:process.pid,version,arch:process.arch,schema:MAIL_SCHEMA_VERSION,keychainReopened:true,draftRetained:true,queuedActionRetained:true,originalRetained:true});
    } finally {db?.close();key.fill(0);}
    if(config.phase==='update'&&version===config.baseVersion) {
      stage='updater-check';
      const run=expression=>win.webContents.executeJavaScript(expression);
      const check=await run("window.__LEGALWORK_ELECTRON__.updater.check('stable')");
      assert.equal(check.available,true);assert.equal(check.latestVersion,config.targetVersion);
      stage='updater-download';assert.equal((await run('window.__LEGALWORK_ELECTRON__.updater.download()')).ok,true);
      await record('update-downloaded',{passed:true,from:version,to:config.targetVersion});
      stage='updater-install';let quitting=false;app.once('before-quit',()=>{quitting=true;});try{assert.equal((await run('window.__LEGALWORK_ELECTRON__.updater.installAndRestart()')).ok,true);}catch(error){if(!quitting)throw error;}
      return;
    }
    app.quit();
  } catch(error) {
    await record('failure',{passed:false,stage,message:String(error?.message??error).slice(0,2000)});
    app.exit(1);
  }
}
