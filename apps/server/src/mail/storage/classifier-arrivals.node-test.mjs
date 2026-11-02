import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {LocalMailService} from '../service.js';
import {GMAIL_MAIL_SCOPES} from '../provider-config.js';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {MailRepository} from './repository.js';
import {MailCredentialRepository} from './credentials.js';
import {MailContentStore} from './content-store.js';
import {MimeProjectionStore} from './mime-projection-store.js';
import {MailClassifierStore} from './classifier.js';
import {MailClassifierArrivals} from './classifier-arrivals.js';
import {MailProjectAssociations} from './project-associations.js';
import {captureMailArrival} from './arrivals.js';
import {quarantineRestoredMail} from './recovery-quarantine.js';
import {removeLaterMailSchema} from '../testing/legacy-schema.mjs';

const project={id:'project-one',binding:'a'.repeat(64)},other={id:'project-two',binding:'b'.repeat(64)};
const rule={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic reference',enabled:true,order:1,project,criteria:{sender:'sender@example.test',domain:'',reference:'MAT-123',subject:''}};
const definition={mode:'automatic',rules:[rule],exclusions:{senders:[],domains:[],subjects:[]}};
async function fixture(run){
  const dir=await mkdtemp(join(tmpdir(),'mail-auto-project-')),path=join(dir,'mail.sqlite'),key=randomBytes(32),db=await openEncryptedMailDatabase({path,key});
  try{
    migrateMailSchema(db);let clock=100000,active=true;const now=()=>clock,advance=(ms=1)=>{clock+=ms;};
    const repo=new MailRepository(db,'owner'),credentials=new MailCredentialRepository(db,'owner',now),configs=new MailClassifierStore(db,'owner',now,()=>active),arrivals=new MailClassifierArrivals(db,'owner',now,()=>active),projects=new MailProjectAssociations(db,'owner',now);
    const binding=id=>({provider:'gmail',clientId:'synthetic.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:id});
    const tokens=()=>({accessToken:'synthetic',expiresAt:now()+3600000,grantedScopes:['https://www.googleapis.com/auth/gmail.readonly'],refreshToken:{action:'clear'}});
    for(const account of ['a','b']){repo.createAccount({id:account,provider:'gmail',displayName:account});for(const id of ['INBOX','SPAM','TRASH','SENT'])repo.putFolder(account,{id,name:id,kind:'label'});credentials.connect(account,binding(account),null,tokens());db.run("INSERT INTO mail_gmail_runs(account_id,generation,revision,state,recent_after,phase,history_id) VALUES(?,?,1,'active',0,'history','1')",[account,randomUUID()]);}
    const save=(value=definition,account='a')=>{const current=configs.read(account);return configs.save(account,{expected:current.version,definition:value});};
    async function projectMessage(account,locator,options={}){
      const subject=options.subject??'Re: [MAT-123] contract',from=options.from??'Sender <sender@example.test>',content=new MailContentStore(db,'owner');
      const raw=await content.writePart(account,locator,{kind:'raw',maxBytes:20000},[Buffer.from('Subject: '+subject+'\r\n\r\n'+(options.body??'Synthetic'))]);
      const body=await content.writePart(account,locator,{kind:'body',maxBytes:1000},[Buffer.from('{"version":1,"bodies":[]}')]);
      new MimeProjectionStore(db,'owner').complete(account,locator,raw.id,{metadata:{subject,from,to:null,cc:null,bcc:null,replyTo:null,date:null,messageId:null},bodies:[],body,attachments:[]});
    }
    async function add(id,options={}){
      const account=options.account??'a',locator={provider:'gmail',messageId:id},memberships=options.memberships??['INBOX'];
      db.transaction(()=>{if(options.capture!==false)captureMailArrival(db,'owner',account,locator,now());repo.ingestMessage(account,{locator,subject:options.subject??'Synthetic',rfcMessageId:null,memberships});db.run('INSERT INTO mail_gmail_metadata(account_id,message_key,internal_date,thread_id,label_ids_json) VALUES(?,?,?,?,?)',[account,JSON.stringify(['gmail',id]),options.received??now(),id,JSON.stringify(memberships)]);});
      if(options.project!==false)await projectMessage(account,locator,options);return locator;
    }
    await run({db,path,key,repo,credentials,configs,arrivals,projects,now,advance,save,add,projectMessage,binding,tokens,pause:value=>{active=!value;}});
  }finally{db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
}
const count=(db,table)=>db.get(`SELECT count(*) n FROM ${table}`).n;

test('only opted-in new identities captured at the shared incremental boundary can enter automatic assignment',()=>fixture(async f=>{
  await f.add('off');f.save({...definition,mode:'suggestions'});await f.add('on-demand');assert.equal(count(f.db,'mail_project_arrivals'),0);
  f.save();f.advance();await f.add('backfill',{capture:false});captureMailArrival(f.db,'owner','a',{provider:'gmail',messageId:'backfill'},f.now());
  const current=await f.add('future');captureMailArrival(f.db,'owner','a',current,f.now());captureMailArrival(f.db,'other','a',{provider:'gmail',messageId:'foreign'},f.now());
  assert.equal(count(f.db,'mail_project_arrivals'),1);assert.equal(f.arrivals.pending().items[0].locator.messageId,'future');
  f.repo.createAccount({id:'archive',provider:'archive',displayName:'Synthetic import'});assert.throws(()=>f.save(definition,'archive'),{code:'unavailable'});
}));
test('capture and provider message insertion roll back together when an incremental page fails',()=>fixture(async f=>{
  f.save();const locator={provider:'gmail',messageId:'rollback'};
  assert.throws(()=>f.db.transaction(()=>{captureMailArrival(f.db,'owner','a',locator,f.now());f.repo.ingestMessage('a',{locator,subject:'Synthetic',rfcMessageId:null,memberships:['INBOX']});throw Error('synthetic page rollback');}));
  assert.equal(count(f.db,'mail_project_arrivals'),0);assert.equal(f.repo.readMessage('a',locator),undefined);
}));
test('a current host-validated decision assigns once with immutable rule provenance and no provider or filing action',()=>fixture(async f=>{
  const config=f.save();f.advance();const locator=await f.add('one'),before=f.db.all('SELECT * FROM mail_messages'),memberships=f.db.all('SELECT * FROM mail_memberships');
  const plan=f.arrivals.pending().items[0];assert.equal(f.arrivals.commit(plan,project).outcome,'assigned');
  const assigned=f.projects.read('a',locator);assert.equal(assigned.source,'automatic');assert.deepEqual(assigned.project,project);assert.deepEqual(assigned.evidence.configVersion,config.version);assert.equal(assigned.evidence.rules[0].name,rule.name);assert.deepEqual(assigned.evidence.rules[0].reasons,['sender','reference']);
  assert.throws(()=>f.arrivals.commit(plan,project),{code:'conflict'});assert.equal(f.arrivals.pending().items.length,0);assert.equal(f.projects.history('a',{locator}).items.length,1);
  for(const table of ['mail_action_jobs','mail_storage_saves','mail_matter_filings','mail_local_drafts','mail_local_rules','mail_rule_arrivals'])assert.equal(count(f.db,table),0);
  assert.deepEqual(f.db.all('SELECT * FROM mail_messages'),before);assert.deepEqual(f.db.all('SELECT * FROM mail_memberships'),memberships);
}));
test('manual choices made before or after preparation always win, including explicit No project decisions',()=>fixture(async f=>{
  f.save();f.advance();const first=await f.add('before');f.projects.dismissUnassigned('a',first);assert.equal(f.arrivals.pending().items.length,0);assert.equal(f.projects.read('a',first).source,'manual');
  const second=await f.add('after'),plan=f.arrivals.pending().items[0];f.projects.set('a',{locator:second,expected:null,project:other});
  assert.equal(f.arrivals.commit(plan,project).outcome,'skipped');assert.deepEqual(f.projects.read('a',second).project,other);
}));
test('settings changes, Off and credential reconnect fence earlier arrivals rather than applying new rules retroactively',()=>fixture(async f=>{
  f.save();f.advance();const locator=await f.add('changed'),plan=f.arrivals.pending().items[0];
  f.save({...definition,rules:[{...rule,project:other}]});assert.equal(f.arrivals.commit(plan,project).outcome,'skipped');assert.equal(f.projects.read('a',locator).version,null);
  const off=await f.add('off');f.save({...definition,mode:'off'});assert.equal(f.arrivals.pending().items.length,0);assert.equal(f.projects.read('a',off).version,null);
  f.save();f.advance();const reconnect=await f.add('reconnect');const credential=f.credentials.status('a');f.credentials.connect('a',f.binding('a'),credential.version,f.tokens());assert.equal(f.configs.read('a').automaticStatus,'connection_changed');assert.equal(f.arrivals.pending().items.length,0);assert.equal(f.projects.read('a',reconnect).version,null);
  f.save();f.advance();await f.add('fresh');assert.equal(f.arrivals.pending().items[0].locator.messageId,'fresh');
}));
test('paused lifecycle or sync keeps pending work inert until current checks can run',()=>fixture(async f=>{
  f.save();f.advance();await f.add('paused');f.pause(true);assert.equal(f.arrivals.pending().items.length,0);assert.equal(f.configs.read('a').automaticStatus,'paused');
  f.pause(false);f.advance(31000);f.db.run("UPDATE mail_gmail_runs SET state='paused' WHERE account_id='a'");assert.equal(f.arrivals.pending().items.length,0);
  f.db.run("UPDATE mail_gmail_runs SET state='active' WHERE account_id='a'");f.advance(31000);assert.equal(f.arrivals.pending().items.length,1);
}));
test('thresholds and conflicting projects route to review while explicit weaker policies apply only to future arrivals',()=>fixture(async f=>{
  const senderOnly={...definition,rules:[{...rule,criteria:{...rule.criteria,reference:''}}]};f.save(senderOnly);f.advance();await f.add('weak');assert.equal(f.arrivals.pending().items.length,0);assert.equal(f.arrivals.activity('a',{filter:'review'}).items[0].outcome,'below_threshold');
  f.save({...senderOnly,automaticThreshold:'any_rule'});f.advance();await f.add('explicit');assert.equal(f.arrivals.pending().items[0].locator.messageId,'explicit');
  f.save({...definition,rules:[rule,{...rule,id:'22222222-2222-4222-8222-222222222222',project:other}]});f.advance();await f.add('ambiguous');f.arrivals.pending();assert.equal(f.arrivals.activity('a',{filter:'review'}).items[0].outcome,'ambiguous');
}));
test('backfill dates, non-Inbox mail, exclusions and removed sources cannot acquire an automatic project',()=>fixture(async f=>{
  f.save({...definition,exclusions:{senders:[],domains:[],subjects:['excluded']}});f.advance();
  await f.add('historical',{received:1});await f.add('sent',{memberships:['SENT']});await f.add('spam',{memberships:['INBOX','SPAM']});await f.add('excluded',{subject:'MAT-123 excluded'});const removed=await f.add('removed');
  f.db.run('INSERT INTO mail_tombstones(account_id,message_key,reason,observed_at) VALUES(?,?,?,?)',['a',JSON.stringify(['gmail','removed']),'removed',new Date(0).toISOString()]);
  assert.equal(f.arrivals.pending().items.length,0);assert.equal(count(f.db,'mail_project_associations'),0);assert.equal(count(f.db,'mail_project_changes'),0);assert.equal(removed.messageId,'removed');
}));
test('late MIME changes invalidate prepared fingerprints and missing or revoked projects require review',()=>fixture(async f=>{
  f.save();f.advance();const locator=await f.add('mime'),plan=f.arrivals.pending().items[0];await f.projectMessage('a',locator,{body:'New synthetic original'});
  assert.equal(f.arrivals.commit(plan,project).outcome,'pending');assert.equal(f.projects.read('a',locator).version,null);f.advance(31000);
  const fresh=f.arrivals.pending().items[0];assert.notEqual(fresh.fingerprint,plan.fingerprint);assert.equal(f.arrivals.commit(fresh,null).outcome,'review');assert.equal(f.arrivals.activity('a',{filter:'review'}).items[0].outcome,'unavailable');
}));
test('undo and dismiss are versioned manual decisions and stale actions cannot erase later corrections',()=>fixture(async f=>{
  f.save();f.advance();const locator=await f.add('undo'),plan=f.arrivals.pending().items[0];f.arrivals.commit(plan,project);
  const item=f.arrivals.activity('a',{filter:'assigned'}).items[0];assert.equal(item.canUndo,true);
  const input={id:item.id,expected:item.version,assignmentVersion:item.assignmentVersion};assert.equal(f.arrivals.action('a',input,'undo').outcome,'undone');assert.equal(f.projects.read('a',locator).project,null);assert.equal(f.projects.read('a',locator).source,'manual');assert.throws(()=>f.arrivals.action('a',input,'undo'),{code:'conflict'});
  const next=await f.add('confirm'),nextPlan=f.arrivals.pending().items[0];f.arrivals.commit(nextPlan,project);const old=f.arrivals.activity('a',{filter:'assigned'}).items[0];const assigned=f.projects.read('a',next);f.projects.set('a',{locator:next,expected:assigned.version,project});assert.equal(f.projects.read('a',next).source,'manual');assert.equal(f.projects.history('a',{locator:next}).items.length,2);assert.throws(()=>f.arrivals.action('a',{id:old.id,expected:old.version,assignmentVersion:old.assignmentVersion},'undo'),{code:'conflict'});
  f.save({...definition,rules:[{...rule,criteria:{...rule.criteria,reference:''}}]});f.advance();const review=await f.add('dismiss');f.arrivals.pending();const pending=f.arrivals.activity('a',{filter:'review'}).items[0];assert.equal(pending.canDismiss,true);f.arrivals.action('a',{id:pending.id,expected:pending.version,assignmentVersion:null},'dismiss');assert.equal(f.projects.read('a',review).source,'manual');assert.notEqual(f.projects.read('a',review).version,null);assert.equal(f.arrivals.activity('a',{filter:'review'}).items.length,0);
}));
test('automatic annotation, audit and arrival completion roll back as one transaction',()=>fixture(async f=>{
  f.save();f.advance();const locator=await f.add('atomic'),plan=f.arrivals.pending().items[0];
  f.db.exec("CREATE TRIGGER reject_auto_completion BEFORE UPDATE ON mail_project_arrivals WHEN NEW.state='assigned' BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END");assert.throws(()=>f.arrivals.commit(plan,project));assert.equal(f.projects.read('a',locator).version,null);assert.equal(f.db.get('SELECT state FROM mail_project_arrivals').state,'pending');assert.equal(count(f.db,'mail_project_changes'),0);
  f.db.exec('DROP TRIGGER reject_auto_completion');assert.equal(f.arrivals.commit(plan,project).outcome,'assigned');
}));
test('restore switches automation Off, preserves provenance and invalidates earlier review/undo versions',()=>fixture(async f=>{
  f.save();f.advance();const locator=await f.add('restore'),plan=f.arrivals.pending().items[0];f.arrivals.commit(plan,project);const item=f.arrivals.activity('a',{filter:'assigned'}).items[0];
  quarantineRestoredMail(f.db);assert.equal(f.configs.read('a').definition.mode,'off');assert.equal(f.projects.read('a',locator).source,'automatic');assert.deepEqual(f.projects.read('a',locator).evidence.rules[0].reasons,['sender','reference']);assert.throws(()=>f.arrivals.action('a',{id:item.id,expected:item.version,assignmentVersion:item.assignmentVersion},'undo'),{code:'conflict'});assert.equal(f.arrivals.pending().items.length,0);
}));
test('activity pages remain bounded, account isolated and complete when provider identities are large',()=>fixture(async f=>{
  f.save();f.advance();for(let i=0;i<25;i++)await f.add(String(i)+'x'.repeat(3900),{subject:'Other message'});f.arrivals.pending();
  let beforeId,ids=[];do{const page=f.arrivals.activity('a',{filter:'all',...(beforeId?{beforeId}:{})});assert.ok(Buffer.byteLength(JSON.stringify(page))<60000);ids.push(...page.items.map(item=>item.id));beforeId=page.nextCursor;}while(beforeId);
  assert.equal(ids.length,25);assert.equal(new Set(ids).size,25);assert.equal(f.arrivals.activity('b',{filter:'all'}).items.length,0);assert.throws(()=>new MailClassifierArrivals(f.db,'other').activity('a',{filter:'all'}),{code:'not_found'});
  f.db.run("DELETE FROM mail_messages WHERE account_id='a'");assert.equal(count(f.db,'mail_project_arrivals'),0);
}));
test('schema40 migration rolls back all new columns, indexes and triggers atomically',()=>fixture(async f=>{
  removeLaterMailSchema(f.db,39);f.db.run('UPDATE mail_schema_version SET version=39');const failing={...f.db,exec(sql){f.db.exec(sql);if(sql.includes('CREATE TABLE mail_project_arrivals'))throw Error('synthetic migration failure');}};
  assert.throws(()=>migrateMailSchema(failing));assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,39);assert.equal(f.db.get("SELECT name FROM sqlite_schema WHERE name='mail_project_arrivals'"),undefined);assert.equal(f.db.all('PRAGMA table_info(mail_project_associations)').some(row=>row.name==='source'),false);migrateMailSchema(f.db);assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);
}));

test('the real private worker and parent coordinator assign synthetic arrivals, fence suspend, and preserve confirmation across lock',()=>fixture(async f=>{
  f.advance(Date.now()-f.now());
  f.credentials.connect('a',f.binding('a'),f.credentials.status('a').version,f.tokens());
  f.save();f.advance();const locator=await f.add('worker');
  const entry=join(dirname(f.path),'network-blocked-worker.mjs');
  await writeFile(entry,'globalThis.fetch=Object.assign(async input=>{const url=new URL(String(input));if(url.origin==="https://gmail.googleapis.com"&&url.pathname.endsWith("/history"))return Response.json({historyId:"1"});throw Error("synthetic_network_blocked");},globalThis.fetch);await import('+JSON.stringify(new URL('../runtime/worker.js',import.meta.url).href)+');');
  const service=new LocalMailService({ownerId:'owner',databasePath:f.path,loadKey:async()=>Buffer.from(f.key),executable:{kind:'node',path:process.execPath},entryPoint:entry,loadProviderSettings:async()=>({provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-secret',scopes:GMAIL_MAIL_SCOPES})});
  let release,lookups=0,gate=new Promise(done=>{release=done;});
  const destination={...project,name:'Synthetic project'};
  service.configureAutomaticClassification({writable:()=>true,resolve:async()=>{lookups++;return gate;}});
  const wait=async check=>{const until=Date.now()+10000;while(!await check()){if(Date.now()>until)throw Error('Synthetic worker did not settle');await new Promise(done=>setTimeout(done,10));}};
  const read=()=>service.projectAssociation({operation:'mail.project.read',accountId:'a',input:{locator}});
  try{
    await service.setLifecycleSuspended(true);await service.unlock();assert.equal((await read()).projectAssociation.version,null);assert.equal(lookups,0);
    await service.setLifecycleSuspended(false);await wait(()=>lookups===1);await service.setLifecycleSuspended(true);release(destination);await new Promise(done=>setTimeout(done,20));assert.equal((await read()).projectAssociation.version,null);
    gate=Promise.resolve(destination);await service.setLifecycleSuspended(false);await wait(async()=>((await read()).projectAssociation.source==='automatic'));
    const automatic=(await read()).projectAssociation;assert.deepEqual(automatic.project,project);assert.deepEqual(automatic.evidence.rules[0].reasons,['sender','reference']);
    const kept=await service.projectAssociation({operation:'mail.project.set',accountId:'a',input:{locator,expected:automatic.version,project}});assert.equal(kept.projectAssociation.source,'manual');
    const activity=await service.classifier({operation:'mail.classifier.activity',accountId:'a',input:{filter:'assigned'}});assert.equal(activity.classifierActivity.items[0].canUndo,false);
    await service.lock();await assert.rejects(read(),{code:'locked'});await service.unlock();assert.equal((await read()).projectAssociation.source,'manual');assert.deepEqual((await read()).projectAssociation.project,project);
  }finally{release(destination);await service.stop();}
}));
