import {randomUUID} from 'node:crypto';
import {basename,dirname,join} from 'node:path';
import {lstat,mkdir,open,readFile,writeFile,rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import type {MailDatabase} from './database-interface.js';
import {MailRepository} from './repository.js';
import {MailContentStore} from './content-store.js';
import {MailCredentialRepository} from './credentials.js';
import {MailSyncJournal} from './sync-journal.js';
import {MailSyncExecutor,MailSyncExecutionFailure} from '../runtime/sync-executor.js';
import {createStoredMimeProjector} from './mime-projection.js';
import {providerMessageKey,providerMessageLocatorSchema,type ProviderMessageLocator} from '../model.js';
import {archiveHeaderSchema,archiveEntrySchema,archiveFolderSchema,portabilityStatusSchema,type ArchiveEntry,type PortabilityStatus} from '../portability-view.js';
import {fileChunks,fingerprint,emlFiles,safeChild,mboxRanges,mboxTransform,jsonLines,writeAll,syncDirectory,requireMboxrd} from '../portability/formats.js';

const string=z.string(),integer=z.number().int().nonnegative();
const MAX_MESSAGE_BYTES=256*1024*1024;
const rowSchema=z.object({id:string,account_id:string,direction:z.enum(['import','export']),format:z.enum(['eml','mboxrd','bundle']),path:string,namespace:string,state:portabilityStatusSchema.shape.state,source_hash:string.nullable(),source_bytes:integer.nullable(),checkpoint:string.nullable(),output_offset:integer,manifest_offset:integer,completed:integer,bytes:integer,failed:integer,error:portabilityStatusSchema.shape.error,label:string});
type Job=z.infer<typeof rowSchema>;
type InputEntry={entry:ArchiveEntry;source:()=>AsyncIterable<Uint8Array>;checkpoint:string};
/** One serial, offline file job per worker. The owner and paths come from the trusted desktop process.
 * Untrusted archive identity is provenance only; a fresh local archive account owns every import. */
export class MailPortabilityStore{
 private readonly repository:MailRepository;
 private readonly content:MailContentStore;
 private running:{id:string;controller:AbortController;promise:Promise<void>}|undefined;
 private closed=false;
 private preparing=false;
 constructor(private readonly db:MailDatabase,private readonly ownerId:string){this.repository=new MailRepository(db,ownerId);this.content=new MailContentStore(db,ownerId);
  db.run("UPDATE mail_portability_jobs SET state='interrupted',error='interrupted' WHERE state='running' AND account_id IN (SELECT id FROM mail_accounts WHERE owner_id=?)",[ownerId]);
 }
 private job(id:string){return rowSchema.parse(this.db.get('SELECT j.* FROM mail_portability_jobs j JOIN mail_accounts a ON a.id=j.account_id WHERE j.id=? AND a.owner_id=?',[id,this.ownerId]));}
 list():PortabilityStatus[]{const items=this.db.all('SELECT j.* FROM mail_portability_jobs j JOIN mail_accounts a ON a.id=j.account_id WHERE a.owner_id=? ORDER BY j.rowid DESC LIMIT 100',[this.ownerId]).map(value=>{const row=rowSchema.parse(value);return portabilityStatusSchema.parse({id:row.id,accountId:row.account_id,direction:row.direction,format:row.format,state:row.state,completed:row.completed,bytes:row.bytes,failed:row.failed,error:row.error,label:row.label});});const result:PortabilityStatus[]=[];let bytes=2;for(const item of items){const length=Buffer.byteLength(JSON.stringify(item))+1;if(bytes+length>48*1024)break;result.push(item);bytes+=length;}return result;}
 async startImport(path:string,format:'eml'|'mboxrd'|'bundle',label:string){
  if(this.running||this.closed||this.preparing)throw Error('portability_busy');this.preparing=true;try{const stat=await lstat(path);if(this.closed||!stat.isFile()&&!stat.isDirectory())throw Error('invalid_archive');if(stat.isSymbolicLink()||format==='bundle'&&!stat.isDirectory()||format==='mboxrd'&&!stat.isFile())throw Error('invalid_archive');
  const id=randomUUID(),accountId=`archive:${randomUUID()}`,namespace=randomUUID();
  this.db.transaction(()=>{this.repository.createAccount({id:accountId,provider:'archive',displayName:label});this.db.run("INSERT INTO mail_portability_jobs(id,account_id,direction,format,path,namespace,state,label) VALUES(?,?,'import',?,?,?,'ready',?)",[id,accountId,format,path,namespace,label]);});this.resume(id);return this.list();}finally{this.preparing=false;}
 }
 async startExport(path:string,accountId:string,format:'eml'|'mboxrd'){
  if(this.running||this.closed||this.preparing)throw Error('portability_busy');this.preparing=true;try{this.readable(accountId);const parent=await lstat(path);if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('invalid_archive');
  const id=randomUUID(),destination=join(path,`legalwork-mail-${id}`),namespace=randomUUID();await mkdir(destination,{mode:0o700});await writeFile(join(destination,'.legalwork-export'),id,{flag:'wx',mode:0o600});await mkdir(join(destination,'messages'),{mode:0o700});
  const header=JSON.stringify({type:'legalwork-mail-archive',version:1,namespace,format})+'\n';await writeFile(join(destination,'manifest.ndjson'),header,{flag:'wx',mode:0o600});
  if(format==='mboxrd')await writeFile(join(destination,'messages.mbox'),'',{flag:'wx',mode:0o600});
  for(const name of ['.legalwork-export','manifest.ndjson',...(format==='mboxrd'?['messages.mbox']:[])]){const file=await open(join(destination,name),'r');try{await file.sync();}finally{await file.close();}}
  await syncDirectory(destination);await syncDirectory(path);
  if(this.closed)throw Error("portability_closed");
  this.db.transaction(()=>{this.readable(accountId);this.db.run("INSERT INTO mail_portability_jobs(id,account_id,direction,format,path,namespace,state,label,manifest_offset) VALUES(?,?,'export',?,?,?,'ready',?,?)",[id,accountId,format,destination,namespace,basename(destination),Buffer.byteLength(header)]);
  // Snapshot identities and immutable raw references inside one transaction. Bodies stay in encrypted storage.
  this.db.run(`INSERT INTO mail_portability_entries(job_id,entry_id,message_key,reference_id,manifest_json,state)
   SELECT ?,m.message_key,m.message_key,c.ref_id,json_object('locator',json(m.locator_json),'memberships',json((SELECT json_group_array(folder_id) FROM mail_memberships mm WHERE mm.account_id=m.account_id AND mm.message_key=m.message_key)),
    'receivedAt',coalesce(ar.received_at,im.internal_date,gm.internal_date,CAST(unixepoch(json_extract(gr.metadata_json,'$.receivedDateTime'),'subsec')*1000 AS INTEGER)),
    'isRead',CASE WHEN m.provider='gmail' THEN CASE WHEN EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.account_id=m.account_id AND mm.message_key=m.message_key AND mm.folder_id='UNREAD') THEN 0 ELSE 1 END ELSE m.is_read END,
    'origin',CASE WHEN ar.provenance_json IS NOT NULL THEN json_extract(ar.provenance_json,'$.origin') ELSE NULL END),'pending'
    FROM mail_messages m LEFT JOIN mail_content_manifests c ON c.account_id=m.account_id AND c.message_key=m.message_key AND c.kind='raw' AND c.state='stored'
    LEFT JOIN mail_archive_messages ar ON ar.account_id=m.account_id AND ar.message_key=m.message_key
    LEFT JOIN mail_imap_messages im ON im.account_id=m.account_id AND im.message_key=m.message_key
    LEFT JOIN mail_gmail_metadata gm ON gm.account_id=m.account_id AND gm.message_key=m.message_key
    LEFT JOIN mail_graph_messages gr ON gr.account_id=m.account_id AND gr.message_key=m.message_key WHERE m.account_id=?`,[id,accountId]);this.db.run("INSERT INTO mail_portability_folders(job_id,id,manifest_json,state) SELECT ?,id,json_object('id',id,'name',name,'kind',kind,'parentId',parent_id,'role',role),'pending' FROM mail_folders WHERE account_id=?",[id,accountId]);});this.resume(id);return this.list();}finally{this.preparing=false;}
 }
 pause(id:string){this.job(id);if(this.running?.id===id)this.running.controller.abort();else this.db.run("UPDATE mail_portability_jobs SET state='paused' WHERE id=? AND state!='complete'",[id]);return this.list();}
 resume(id:string){const job=this.job(id);if(this.closed||this.running&&this.running.id!==id)throw Error('portability_busy');if(this.running||job.state==='complete')return this.list();
  const controller=new AbortController();this.db.run("UPDATE mail_portability_jobs SET state='running',error=NULL WHERE id=?",[id]);
  const promise=this.perform(job,controller.signal).catch(error=>{this.db.run('UPDATE mail_portability_jobs SET state=?,error=? WHERE id=?',[controller.signal.aborted?'paused':'attention',controller.signal.aborted?null:error instanceof Error&&error.message==='source_changed'?'source_changed':'invalid_archive',id]);}).finally(()=>{if(this.running?.id===id)this.running=undefined;});this.running={id,controller,promise};return this.list();
 }
 async settled(){await this.running?.promise;}
 async close(){this.closed=true;this.running?.controller.abort();await this.running?.promise;}
 private readable(accountId:string){this.repository.listFoldersPage(accountId,{limit:1});const status=new MailCredentialRepository(this.db,this.ownerId).status(accountId);if(status.state==='disconnected')throw Error('content_unavailable');}
 private async perform(job:Job,signal:AbortSignal){if(job.direction==='import')await this.import(job,signal);else await this.export(job,signal);signal.throwIfAborted();this.db.run("UPDATE mail_portability_jobs SET state=CASE WHEN failed=0 THEN 'complete' ELSE 'attention' END,error=CASE WHEN failed=0 THEN NULL ELSE 'content_unavailable' END WHERE id=?",[job.id]);}
 private async sourceIdentity(job:Job,signal:AbortSignal){const path=job.format==='bundle'?await safeChild(job.path,'manifest.ndjson'):job.path;const stat=await lstat(path);if(stat.isSymbolicLink())throw Error('invalid_archive');
  if(stat.isDirectory())return;const identity=await fingerprint(path,signal);if(job.source_hash&&(job.source_hash!==identity.sha256||job.source_bytes!==identity.bytes))throw Error('source_changed');this.db.run('UPDATE mail_portability_jobs SET source_hash=?,source_bytes=? WHERE id=?',[identity.sha256,identity.bytes,job.id]);
 }
 private async *inputs(job:Job,signal:AbortSignal):AsyncGenerator<InputEntry>{
  const empty=(entryId:string):ArchiveEntry=>({type:'message',entryId,bytes:0,sha256:'0'.repeat(64),receivedAt:null,isRead:null,folders:[],memberships:[],origin:{provider:'archive',sourceAccountId:job.account_id,identity:entryId}});
  if(job.format==='bundle'){
   const records=jsonLines(await safeChild(job.path,'manifest.ndjson'),signal);try{const first=await records.next();const header=archiveHeaderSchema.parse(first.value);let ordinal=0,total=0,finished=false;
   for await(const record of records){if(finished)throw Error('invalid_archive');const end=z.object({type:z.literal('complete'),messages:integer,bytes:integer,failed:integer}).strict().safeParse(record);if(end.success){await this.applyFolders(job,signal);if(end.data.messages!==ordinal||end.data.bytes!==total)throw Error('invalid_archive');this.db.run("UPDATE mail_portability_jobs SET failed=(SELECT count(*) FROM mail_portability_entries WHERE job_id=? AND state='failed')+? WHERE id=?",[job.id,end.data.failed,job.id]);finished=true;continue;}const folder=z.object({type:z.literal('folder'),value:archiveFolderSchema}).strict().safeParse(record);if(folder.success){if(ordinal>0)throw Error('invalid_archive');this.repository.putFolder(job.account_id,{id:folder.data.value.id,name:folder.data.value.name,kind:folder.data.value.kind,parentId:null});this.db.run("INSERT INTO mail_portability_folders(job_id,id,manifest_json,state) VALUES(?,?,?,'pending') ON CONFLICT(job_id,id) DO UPDATE SET manifest_json=excluded.manifest_json,state='pending'",[job.id,folder.data.value.id,JSON.stringify(folder.data.value)]);continue;}await this.applyFolders(job,signal);const entry=archiveEntrySchema.parse(record);ordinal++;total+=entry.bytes;if(ordinal<=Number(job.checkpoint??0))continue;if(entry.bytes>MAX_MESSAGE_BYTES)throw Error('invalid_archive');
    if(header.format==='eml'){if(!entry.path||entry.start!==undefined||entry.end!==undefined)throw Error('invalid_archive');const path=await safeChild(job.path,entry.path);yield{entry,checkpoint:String(ordinal),source:()=>fileChunks(path,0,undefined,signal)};}
    else{if(entry.path!==undefined||entry.start===undefined||entry.end===undefined||entry.end<entry.start)throw Error('invalid_archive');const path=await safeChild(job.path,'messages.mbox'),start=entry.start,end=entry.end;yield{entry,checkpoint:String(ordinal),source:()=>mboxTransform(fileChunks(path,start,end,signal),false,entry.bytes)};}
   }if(!finished)throw Error('archive_manifest_incomplete');return;}finally{await records.return(undefined);}
  }
  if(job.format==='mboxrd'){
   for await(const range of mboxRanges(job.path,Number(job.checkpoint??0),signal)){const entry=empty(range.entryId);yield{entry,checkpoint:String(range.nextOffset),source:()=>requireMboxrd(mboxTransform(fileChunks(job.path,range.start,range.end,signal),false))};}return;
  }
  const stat=await lstat(job.path);const entries=stat.isDirectory()?emlFiles(job.path):(async function*(){yield{path:job.path,entryId:basename(job.path)};})();
  for await(const file of entries){signal.throwIfAborted();const entry=empty(file.entryId),folder=dirname(file.entryId).split('\\').join('/');if(folder!=='.'){const names=folder.split('/');entry.folders=names.map((name,index)=>({id:names.slice(0,index+1).join('/'),name,kind:'folder',parentId:index?names.slice(0,index).join('/'):null,role:null}));entry.memberships=[folder];}yield{entry,checkpoint:file.entryId,source:()=>fileChunks(file.path,0,undefined,signal)};}
 }
 private async applyFolders(job:Job,signal:AbortSignal){let completed=0;while(true){const row=this.db.get("SELECT id,manifest_json FROM mail_portability_folders WHERE job_id=? AND state='pending' ORDER BY id LIMIT 1",[job.id]);if(!row)break;const {role,...folder}=archiveFolderSchema.parse(JSON.parse(string.parse(row.manifest_json)));this.db.transaction(()=>{this.repository.putFolder(job.account_id,folder);this.db.run('UPDATE mail_folders SET role=? WHERE account_id=? AND id=?',[role,job.account_id,folder.id]);this.db.run("UPDATE mail_portability_folders SET state='complete' WHERE job_id=? AND id=?",[job.id,folder.id]);});if(++completed%32===0)await delay(1,undefined,{signal});}}
 private async import(job:Job,signal:AbortSignal){
  await this.sourceIdentity(job,signal);while(true){const staged=this.content.listStaging(job.account_id,100);if(!staged.length)break;for(const item of staged)this.content.discardStaging(job.account_id,item.id);await delay(1,undefined,{signal});}const journal=new MailSyncJournal(this.db,this.ownerId,Date.now,{maxAttempts:1}),scope={accountId:job.account_id,scopeId:'archive-import',generation:job.id};
  // Only this isolated import owns these jobs. A terminated worker cannot still publish into this connection.
  this.db.run("UPDATE mail_sync_jobs SET state='retry',lease_token=NULL,lease_until=NULL,available_at=0,max_attempts=20 WHERE account_id=? AND generation=? AND state='running'",[job.account_id,job.id]);
  const project=createStoredMimeProjector({database:this.db,ownerId:this.ownerId});
  for await(const input of this.inputs(job,signal)){
   signal.throwIfAborted();const {entry}=input;const locator:ProviderMessageLocator={provider:'archive',namespace:job.namespace,entryId:entry.entryId},key=providerMessageKey(locator);
   const previous=this.db.get('SELECT state,reference_id FROM mail_portability_entries WHERE job_id=? AND entry_id=?',[job.id,entry.entryId]);
   if(previous?.state==='complete'||previous?.state==='failed'){
    if(job.format==='bundle')throw Error('invalid_archive');
    if(job.format==='eml'){const hash=(await import('node:crypto')).createHash('sha256');for await(const chunk of input.source())hash.update(chunk);if(previous.reference_id!==`sha256:${hash.digest('hex')}`)throw Error('source_changed');}continue;
   }
   const checkpoint=journal.readCheckpoint(scope);
   journal.commitPage({...scope,expectedCursor:checkpoint.cursor,expectedRevision:checkpoint.revision,nextCursor:entry.entryId,discoveryComplete:false,jobs:[{kind:'body',locator}]},writer=>{
    // Imported folder IDs stay scoped to a newly allocated archive; no account/matter/credential fields exist in the format.
    for(const {role,...folder} of entry.folders){writer.putFolder(folder);this.db.run("UPDATE mail_folders SET role=? WHERE account_id=? AND id=?",[role,job.account_id,folder.id]);}
    for(const member of entry.memberships)if(!entry.folders.some(folder=>folder.id===member))throw Error('invalid_archive');
    writer.ingestMessage({locator,rfcMessageId:null,subject:entry.entryId,memberships:entry.memberships});
    this.db.run("INSERT INTO mail_portability_entries(job_id,entry_id,message_key,manifest_json,state) VALUES(?,?,?,?,'pending') ON CONFLICT DO NOTHING",[job.id,entry.entryId,key,JSON.stringify(entry)]);
   });
   let reference;
   if(typeof previous?.reference_id==='string'){const row=this.db.get('SELECT id,bytes,sha256 FROM mail_content_refs WHERE account_id=? AND id=?',[job.account_id,previous.reference_id]);reference={id:string.parse(row?.id),bytes:integer.parse(row?.bytes),sha256:string.parse(row?.sha256)};}
   else reference=await this.content.writePart(job.account_id,locator,{kind:'raw',maxBytes:MAX_MESSAGE_BYTES,...(job.format==='bundle'?{expectedBytes:entry.bytes,expectedSha256:entry.sha256}:{})},input.source(),value=>{signal.throwIfAborted();this.db.run('UPDATE mail_portability_entries SET reference_id=? WHERE job_id=? AND entry_id=?',[value.id,job.id,entry.entryId]);});
   const projected=this.db.get("SELECT state FROM mail_mime_projections WHERE account_id=? AND message_key=? AND raw_ref_id=?",[job.account_id,key,reference.id]);
   if(projected?.state!=='complete')this.db.run("UPDATE mail_sync_jobs SET state='queued',attempts=0,lease_token=NULL,lease_until=NULL,available_at=0,last_error=NULL WHERE account_id=? AND generation=? AND message_key=? AND kind='body' AND state!='running'",[job.account_id,job.id,key]);
   const executor=new MailSyncExecutor({journal,maxJobsPerRun:1,handler:async work=>{try{await project({accountId:job.account_id,locator,reference,work,signal,assertCurrent:()=>signal.throwIfAborted()});}catch{throw new MailSyncExecutionFailure('permanent');}}});
   let failed=false;try{if(projected?.state!=='complete'){const result=await executor.run(scope);failed=result.failed>0||result.succeeded!==1;}}finally{executor.close();}signal.throwIfAborted();
   this.db.transaction(()=>{const rawMetadata=this.db.get("SELECT metadata_json FROM mail_mime_projections WHERE account_id=? AND message_key=? AND state='complete'",[job.account_id,key])?.metadata_json;const parsedDate=typeof rawMetadata==='string'?Date.parse(JSON.parse(rawMetadata).metadata?.date??''):NaN;const date=entry.receivedAt??(Number.isFinite(parsedDate)&&parsedDate>=0?parsedDate:null);this.db.run('UPDATE mail_messages SET is_read=? WHERE account_id=? AND message_key=?',[entry.isRead===null?null:entry.isRead?1:0,job.account_id,key]);
    this.db.run('INSERT INTO mail_archive_messages(account_id,message_key,namespace,entry_id,received_at,provenance_json) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,message_key) DO UPDATE SET provenance_json=excluded.provenance_json',[job.account_id,key,job.namespace,entry.entryId,date,JSON.stringify({...entry,bytes:reference.bytes,sha256:reference.sha256})]);
    this.db.run('UPDATE mail_portability_entries SET state=? WHERE job_id=? AND entry_id=?',[failed?'failed':'complete',job.id,entry.entryId]);this.db.run('UPDATE mail_portability_jobs SET checkpoint=?,completed=completed+1,bytes=bytes+?,failed=failed+? WHERE id=?',[input.checkpoint,reference.bytes,failed?1:0,job.id]);});
   await delay(1,undefined,{signal});
  }
  await this.sourceIdentity(this.job(job.id),signal);
 }
 private async export(job:Job,signal:AbortSignal){
  if((await readFile(await safeChild(job.path,'.legalwork-export'),'utf8'))!==job.id)throw Error('invalid_archive');
  const manifest=await open(await safeChild(job.path,'manifest.ndjson'),'r+'),mbox=job.format==='mboxrd'?await open(await safeChild(job.path,'messages.mbox'),'r+'):undefined;
  try{await manifest.truncate(job.manifest_offset);await mbox?.truncate(job.output_offset);let manifestOffset=job.manifest_offset,outputOffset=job.output_offset;
   while(true){signal.throwIfAborted();const folder=this.db.get("SELECT id,manifest_json FROM mail_portability_folders WHERE job_id=? AND state='pending' ORDER BY id LIMIT 1",[job.id]);if(!folder)break;const line=Buffer.from(JSON.stringify({type:'folder',value:archiveFolderSchema.parse(JSON.parse(string.parse(folder.manifest_json)))})+'\n');manifestOffset=await writeAll(manifest,line,manifestOffset);await manifest.sync();this.db.transaction(()=>{this.db.run("UPDATE mail_portability_folders SET state='complete' WHERE job_id=? AND id=?",[job.id,string.parse(folder.id)]);this.db.run('UPDATE mail_portability_jobs SET manifest_offset=? WHERE id=?',[manifestOffset,job.id]);});}
   while(true){signal.throwIfAborted();this.readable(job.account_id);const row=this.db.get("SELECT * FROM mail_portability_entries WHERE job_id=? AND state='pending' ORDER BY entry_id LIMIT 1",[job.id]);if(!row)break;
    const entryId=string.parse(row.entry_id),key=string.parse(row.message_key);if(typeof row.reference_id!=='string'){this.db.run("UPDATE mail_portability_entries SET state='failed' WHERE job_id=? AND entry_id=?",[job.id,entryId]);this.db.run('UPDATE mail_portability_jobs SET failed=failed+1 WHERE id=?',[job.id]);continue;}
    const snapshot=z.object({locator:providerMessageLocatorSchema,memberships:z.array(string).max(256),receivedAt:integer.nullable(),isRead:z.union([z.literal(0),z.literal(1)]).nullable(),origin:archiveEntrySchema.shape.origin.nullable()}).parse(JSON.parse(string.parse(row.manifest_json))),locator=snapshot.locator;
    const ref=this.db.get('SELECT bytes,sha256 FROM mail_content_refs WHERE account_id=? AND id=?',[job.account_id,row.reference_id]);
    const folders=snapshot.memberships.map(id=>archiveFolderSchema.parse(JSON.parse(string.parse(this.db.get('SELECT manifest_json FROM mail_portability_folders WHERE job_id=? AND id=?',[job.id,id])?.manifest_json))));
    for(let n=0;n<folders.length;n++){const parent=folders[n].parentId;if(parent&&!folders.some(folder=>folder.id===parent)){folders.push(archiveFolderSchema.parse(JSON.parse(string.parse(this.db.get('SELECT manifest_json FROM mail_portability_folders WHERE job_id=? AND id=?',[job.id,parent])?.manifest_json))));}if(folders.length>256)throw Error('invalid_archive');}
    const entry:ArchiveEntry={type:'message',entryId,bytes:integer.parse(ref?.bytes),sha256:string.parse(ref?.sha256),receivedAt:snapshot.receivedAt,isRead:snapshot.isRead===null?null:snapshot.isRead===1,folders,memberships:snapshot.memberships,origin:snapshot.origin??{provider:locator.provider,sourceAccountId:job.account_id,identity:JSON.stringify(locator)}};
    if(mbox){const envelope=Buffer.from('From MAILER-DAEMON Sat Jan  1 00:00:00 2000\n');outputOffset=await writeAll(mbox,envelope,outputOffset);entry.start=outputOffset;
     for await(const chunk of mboxTransform(this.content.read(job.account_id,row.reference_id),true)){signal.throwIfAborted();outputOffset=await writeAll(mbox,chunk,outputOffset);}
     // A single framing newline is excluded by the manifest's exact raw byte count.
     outputOffset=await writeAll(mbox,Buffer.from('\n'),outputOffset);entry.end=outputOffset;await mbox.sync();
    }else{entry.path=`messages/${job.completed++}.eml`;const target=join(await safeChild(job.path,'messages'),`${job.completed-1}.eml`),temporary=join(await safeChild(job.path,'messages'),`${randomUUID()}.part`);const file=await open(temporary,'wx',0o600);let fileOffset=0;try{for(const chunk of this.content.read(job.account_id,row.reference_id)){signal.throwIfAborted();fileOffset=await writeAll(file,chunk,fileOffset);}await file.sync();}finally{await file.close();}await rename(temporary,target);await syncDirectory(dirname(target));}
    const line=Buffer.from(JSON.stringify(archiveEntrySchema.parse(entry))+'\n');manifestOffset=await writeAll(manifest,line,manifestOffset);await manifest.sync();
    this.db.transaction(()=>{this.readable(job.account_id);this.db.run("UPDATE mail_portability_entries SET state='complete',manifest_json=? WHERE job_id=? AND entry_id=?",[JSON.stringify(entry),job.id,entryId]);this.db.run('UPDATE mail_portability_jobs SET completed=completed+1,bytes=bytes+?,output_offset=?,manifest_offset=? WHERE id=?',[entry.bytes,outputOffset,manifestOffset,job.id]);});await delay(1,undefined,{signal});
   }
   const status=this.job(job.id),footer=Buffer.from(JSON.stringify({type:'complete',messages:status.completed,bytes:status.bytes,failed:status.failed})+'\n');await writeAll(manifest,footer,manifestOffset);await manifest.sync();
  }finally{await manifest.close();await mbox?.close();}
 }
}
