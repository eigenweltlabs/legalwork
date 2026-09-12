import {SenderIdentityRepository} from './sender-identities.js';
import {mailUploadSchema,type MailUpload} from "../local-view.js";
import { GraphMailboxRepository } from './graph-mailboxes.js';
import {storedMutationPrecondition} from './mutation-precondition.js';
import {mailActionPageInputSchema,type MailActionPageInput} from '../local-view.js';
import {MailContentStore} from "./content-store.js";
import {mailDraftAttachmentSchema,mailDraftAttachmentViewSchema,type MailDraftAttachment} from "../local-view.js";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import type {MailDatabase} from "./database-interface.js";
import {MailActionJournal,MailActionError} from "./action-journal.js";
import {MailCredentialRepository} from "./credentials.js";
import {MailRepository} from "./repository.js";
import {providerMessageKey} from "../model.js";
import {mailDraftSaveSchema,mailDraftReadSchema,mailDraftDeleteSchema,mailLocalPageSchema,mailDraftViewSchema,mailDraftSummarySchema,mailSubmissionSchema,mailMutationSchema,mailActionReadSchema,mailActionCancelSchema,mailLocalActionSchema,mailEventQuerySchema,mailLocalEventSchema,
 type MailDraftSave,type MailDraftRead,type MailDraftDelete,type MailLocalPage,type MailSubmission,type MailMutation,type MailActionCancel,type MailEventQuery} from "../local-view.js";
export class MailLocalError extends Error{constructor(readonly code:'not_found'|'locked'|'conflict'|'invalid_input'|'unavailable'){super(`mail_local_${code}`);}}
const headSchema=z.object({id:z.string().uuid(),generation:z.string().uuid(),revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),updated_at:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),deleted:z.union([z.literal(0),z.literal(1)])});
const string=z.string();
function parse<T>(schema:z.ZodType<T>,input:unknown):T{const result=schema.safeParse(input);if(!result.success)throw new MailLocalError('invalid_input');return result.data;}
/** Local-only durable state; provider execution is deliberately absent from this API. */
export class MailLocalApiStore{
 private readonly journal:MailActionJournal;private readonly credentials:MailCredentialRepository;private readonly repository:MailRepository;
 constructor(private readonly db:MailDatabase,private readonly ownerId:string,private readonly now:()=>number=Date.now){this.journal=new MailActionJournal(db,ownerId,now);this.credentials=new MailCredentialRepository(db,ownerId,now);this.repository=new MailRepository(db,ownerId);}
 private safe<T>(fn:()=>T):T{try{return this.db.transaction(fn);}catch(error){if(error instanceof MailLocalError)throw error;if(error instanceof MailActionError){if(['replay_conflict','stale_version','invalid_state'].includes(error.code))throw new MailLocalError('conflict');if(error.code==='not_found'||error.code==='account_not_found')throw new MailLocalError('not_found');}throw new MailLocalError('unavailable');}}
 private account(accountId:string):void{if(!this.db.get('SELECT id FROM mail_accounts WHERE id=? AND owner_id=?',[accountId,this.ownerId]))throw new MailLocalError('not_found');if(this.credentials.status(accountId).state==='disconnected')throw new MailLocalError('locked');}
 private head(accountId:string,draftId:string){const row=this.db.get('SELECT * FROM mail_local_drafts WHERE account_id=? AND id=?',[accountId,draftId]);if(!row)throw new MailLocalError('not_found');return headSchema.parse(row);}
 private version(head:z.infer<typeof headSchema>){return{generation:head.generation,revision:head.revision};}
 private snapshot(accountId:string,id:string,version:{generation:string;revision:number}){const row=this.db.get('SELECT content_json FROM mail_local_draft_versions WHERE account_id=? AND draft_id=? AND generation=? AND revision=?',[accountId,id,version.generation,version.revision]);if(!row)throw new MailLocalError('not_found');return mailDraftSaveSchema.shape.content.parse(JSON.parse(string.parse(row.content_json)));}
 saveDraft(accountId:string,supplied:MailDraftSave){return this.safe(()=>{
  this.account(accountId);const input=parse(mailDraftSaveSchema,supplied),serialized=JSON.stringify(input.content);const found=this.db.get('SELECT * FROM mail_local_drafts WHERE account_id=? AND id=?',[accountId,input.draftId]);const old=found?headSchema.parse(found):null;
  if(old){
   if(old.deleted)throw new MailLocalError('conflict');
   const same=JSON.stringify(this.snapshot(accountId,input.draftId,this.version(old)))===serialized;
   if((input.expected===null&&old.revision===1&&same)||(input.expected&&old.generation===input.expected.generation&&old.revision===input.expected.revision+1&&same))return this.readDraft(accountId,{draftId:input.draftId});
   if(!input.expected||old.generation!==input.expected.generation||old.revision!==input.expected.revision||old.revision===Number.MAX_SAFE_INTEGER)throw new MailLocalError('conflict');
  }else if(input.expected!==null)throw new MailLocalError('conflict');
  const previous=old?this.snapshot(accountId,input.draftId,this.version(old)):null;
  for(const attachment of input.content.attachments){
   const key=attachment.locator?providerMessageKey(attachment.locator):null;const retained=previous?.attachments.some(part=>part.referenceId===attachment.referenceId&&part.partId===attachment.partId&&(part.locator?providerMessageKey(part.locator):null)===key);
   if(!retained&&attachment.locator&&!this.db.get("SELECT 1 FROM mail_content_manifests WHERE account_id=? AND message_key=? AND kind='attachment' AND part_id=? AND ref_id=? AND state='stored'",[accountId,key,attachment.partId,attachment.referenceId]))throw new MailLocalError('not_found');
   if(!this.db.get("SELECT 1 FROM mail_blob_publications p JOIN mail_blob_objects o ON o.account_id=p.account_id AND o.id=p.object_id WHERE p.account_id=? AND p.ref_id=? AND o.state='published'",[accountId,attachment.referenceId]))throw new MailLocalError('not_found');
  }
  let total=0;for(const part of input.content.attachments){
   if(!part.locator&&!part.referenceId.startsWith('draft:sha256:'))throw new MailLocalError('invalid_input');
   const bytes=z.number().parse(this.db.get('SELECT bytes FROM mail_content_refs WHERE account_id=? AND id=?',[accountId,part.referenceId])?.bytes);total+=bytes;if(part.bytes!==undefined&&part.bytes!==bytes)throw new MailLocalError('invalid_input');
   if(bytes>10*1024*1024||total>20*1024*1024)throw new MailLocalError('invalid_input');
  }
  const generation=old?.generation??randomUUID(),revision=(old?.revision??0)+1,updatedAt=parse(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),this.now());
  this.db.run('INSERT INTO mail_local_drafts(account_id,id,generation,revision,updated_at,deleted) VALUES(?,?,?,?,?,0) ON CONFLICT(account_id,id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at',[accountId,input.draftId,generation,revision,updatedAt]);
  this.db.run('INSERT INTO mail_local_draft_versions(account_id,draft_id,generation,revision,updated_at,content_json) VALUES(?,?,?,?,?,?)',[accountId,input.draftId,generation,revision,updatedAt,serialized]);
  input.content.attachments.forEach((part,index)=>this.db.run('INSERT INTO mail_local_draft_parts(account_id,draft_id,generation,revision,ordinal,ref_id) VALUES(?,?,?,?,?,?)',[accountId,input.draftId,generation,revision,index,part.referenceId]));
  return this.readDraft(accountId,{draftId:input.draftId});
 });}
 /** Upload chunks live only in the encrypted store. Offset CAS allows exact retries. */
 uploadDraft(accountId:string,supplied:MailUpload){return this.safe(()=>{
  this.account(accountId);const input=parse(mailUploadSchema,supplied),data=Buffer.from(input.data,'base64'),objectId='draft-upload:'+input.uploadId;
  if(input.cancel){this.db.run("DELETE FROM mail_blob_objects WHERE account_id=? AND id=? AND state='staging'",[accountId,objectId]);return{uploadId:input.uploadId,nextOffset:0,bytes:0,referenceId:null};}
  if(data.toString('base64')!==input.data||data.length>16384||input.offset+data.length>10*1024*1024||(!data.length&&!input.complete))throw new MailLocalError('invalid_input');
  let row=this.db.get('SELECT state,bytes,chunk_count FROM mail_blob_objects WHERE account_id=? AND id=?',[accountId,objectId]);
  // A duplicate publication removes its staging object. Recognize a retried final
  // chunk from the account-owned verified publication without recreating an orphan.
  if(!row&&input.complete&&input.offset+data.length===input.totalBytes){const referenceId='draft:sha256:'+input.sha256;const published=this.db.get('SELECT r.bytes FROM mail_blob_publications p JOIN mail_content_refs r ON r.account_id=p.account_id AND r.id=p.ref_id WHERE p.account_id=? AND p.ref_id=?',[accountId,referenceId]);if(published){if(published.bytes!==input.totalBytes)throw new MailLocalError('invalid_input');const store=new MailContentStore(this.db,this.ownerId);for(const _chunk of store.read(accountId,referenceId)){}const stored=store.readRange(accountId,referenceId,input.offset,Math.max(1,data.length));if(!Buffer.from(stored.data,'base64').equals(data))throw new MailLocalError('conflict');return{uploadId:input.uploadId,nextOffset:input.totalBytes,bytes:input.totalBytes,referenceId};}}
  if(!row){if(input.offset!==0)throw new MailLocalError('conflict');const used=z.number().parse(this.db.get("SELECT coalesce(sum(bytes),0) n FROM mail_blob_objects WHERE account_id=? AND state='staging'",[accountId])?.n);if(used+data.length>50*1024*1024)throw new MailLocalError('invalid_input');this.db.run("INSERT INTO mail_blob_objects(account_id,id,state) VALUES(?,?,'staging')",[accountId,objectId]);row={state:'staging',bytes:0,chunk_count:0};}
  const size=z.number().parse(row.bytes);
  const staged=z.number().parse(this.db.get("SELECT coalesce(sum(bytes),0) n FROM mail_blob_objects WHERE account_id=? AND state='staging'",[accountId])?.n);if(staged+Math.max(0,input.offset+data.length-size)>50*1024*1024)throw new MailLocalError('invalid_input');
  if(input.offset+data.length>input.totalBytes)throw new MailLocalError('invalid_input');
  const readSlice=(offset:number,length:number)=>{const parts:Uint8Array[]=[];for(let at=offset;at<offset+length;){const ordinal=Math.floor(at/65536),chunk=this.db.get('SELECT data FROM mail_blob_chunks WHERE account_id=? AND object_id=? AND ordinal=?',[accountId,objectId,ordinal])?.data;if(!(chunk instanceof Uint8Array))throw new MailLocalError('unavailable');const n=Math.min(offset+length-at,chunk.length-at%65536);if(n<=0)throw new MailLocalError('unavailable');parts.push(chunk.subarray(at%65536,at%65536+n));at+=n;}return Buffer.concat(parts);};
  if(input.offset<size){if(input.offset+data.length!==size||!readSlice(input.offset,data.length).equals(data))throw new MailLocalError('conflict');}
  else{if(input.offset!==size||(row.state!=='staging'&&!(input.complete&&size===0)))throw new MailLocalError('conflict');let at=0;while(at<data.length){const position=size+at,ordinal=Math.floor(position/65536),existing=position%65536?readSlice(ordinal*65536,position%65536):Buffer.alloc(0),amount=Math.min(65536-existing.length,data.length-at),chunk=Buffer.concat([existing,data.subarray(at,at+amount)]);this.db.run('INSERT INTO mail_blob_chunks(account_id,object_id,ordinal,data) VALUES(?,?,?,?) ON CONFLICT(account_id,object_id,ordinal) DO UPDATE SET data=excluded.data',[accountId,objectId,ordinal,chunk]);at+=amount;}}
  const bytes=input.offset+data.length;this.db.run('UPDATE mail_blob_objects SET bytes=?,chunk_count=? WHERE account_id=? AND id=?',[bytes,Math.ceil(bytes/65536),accountId,objectId]);
  let referenceId:string|null=null;
  if(input.complete){const hash=createHash('sha256');for(let at=0;at<bytes;at+=65536)hash.update(readSlice(at,Math.min(65536,bytes-at)));const digest=hash.digest('hex');if(bytes!==input.totalBytes||digest!==input.sha256)throw new MailLocalError('invalid_input');referenceId='draft:sha256:'+digest;
   this.db.run('INSERT INTO mail_content_refs(account_id,id,bytes,sha256) VALUES(?,?,?,?) ON CONFLICT(account_id,id) DO NOTHING',[accountId,referenceId,bytes,digest]);
   const published=this.db.get('SELECT object_id FROM mail_blob_publications WHERE account_id=? AND ref_id=?',[accountId,referenceId]);
   if(published){for(const _chunk of new MailContentStore(this.db,this.ownerId).read(accountId,referenceId)){}if(published.object_id!==objectId)this.db.run("DELETE FROM mail_blob_objects WHERE account_id=? AND id=? AND state='staging'",[accountId,objectId]);}
   else{this.db.run("UPDATE mail_blob_objects SET state='published' WHERE account_id=? AND id=?",[accountId,objectId]);this.db.run('INSERT INTO mail_blob_publications(account_id,ref_id,object_id) VALUES(?,?,?)',[accountId,referenceId,objectId]);}
  }
  return{uploadId:input.uploadId,nextOffset:bytes,bytes,referenceId};
 });}
 readDraft(accountId:string,supplied:MailDraftRead){return this.safe(()=>{this.account(accountId);const input=parse(mailDraftReadSchema,supplied),head=this.head(accountId,input.draftId);if(head.deleted&&!input.version)throw new MailLocalError('not_found');const version=input.version??this.version(head),content=this.snapshot(accountId,input.draftId,version);return mailDraftViewSchema.parse({id:head.id,version,updatedAt:this.db.get("SELECT updated_at FROM mail_local_draft_versions WHERE account_id=? AND draft_id=? AND generation=? AND revision=?",[accountId,head.id,version.generation,version.revision])?.updated_at,deleted:head.deleted===1,subject:content.subject,content});});}
 listDrafts(accountId:string,supplied:MailLocalPage){return this.safe(()=>{this.account(accountId);const page=parse(mailLocalPageSchema,supplied);const rows=this.db.all('SELECT id FROM mail_local_drafts WHERE account_id=? AND deleted=0 AND id>? ORDER BY id LIMIT ?',[accountId,page.after??'',page.limit+1]);const items=rows.slice(0,page.limit).map(row=>{const {content,...summary}=this.readDraft(accountId,{draftId:string.parse(row.id)});return mailDraftSummarySchema.parse(summary);});return{accountId,items,nextCursor:rows.length>page.limit?items.at(-1)?.id??null:null};});}
 deleteDraft(accountId:string,supplied:MailDraftDelete){return this.safe(()=>{this.account(accountId);const input=parse(mailDraftDeleteSchema,supplied),head=this.head(accountId,input.draftId);if(head.generation!==input.expected.generation||head.revision!==input.expected.revision||head.revision===Number.MAX_SAFE_INTEGER)throw new MailLocalError('conflict');const content=this.snapshot(accountId,head.id,this.version(head));const generation=randomUUID(),revision=head.revision+1,updatedAt=parse(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),this.now());this.db.run('UPDATE mail_local_drafts SET deleted=1,generation=?,revision=?,updated_at=? WHERE account_id=? AND id=?',[generation,revision,updatedAt,accountId,head.id]);return mailDraftSummarySchema.parse({id:head.id,version:{generation,revision},updatedAt,deleted:true,subject:content.subject});});}
 private action(accountId:string,actionId:string){
  const status=this.journal.read(accountId,actionId),row=this.db.get('SELECT payload_json FROM mail_action_jobs WHERE account_id=? AND id=?',[accountId,actionId]);
  let generation:unknown,mutation:unknown=null;
  try { const value=z.object({credentialGeneration:z.string(),intent:z.unknown()}).parse(JSON.parse(string.parse(row?.payload_json)));generation=value.credentialGeneration;
   const intent=z.object({kind:z.literal('mutation'),locator:mailMutationSchema.shape.locator,precondition:mailMutationSchema.shape.precondition,change:mailMutationSchema.shape.change}).safeParse(value.intent);
   if(intent.success){const {kind,...content}=intent.data;mutation=content;}
  }catch{/* Legacy opaque intent is not dispatchable by this API. */}
  const credentials=this.credentials.status(accountId);
  return mailLocalActionSchema.parse({...status,mutation,executionSupported:status.kind==='submission'&&!!this.db.get('SELECT action_id FROM mail_outbox WHERE account_id=? AND action_id=?',[accountId,actionId])||status.kind==='mutation'&&mutation!==null,providerResult:this.db.get('SELECT result FROM mail_imap_action_results WHERE account_id=? AND id=?',[accountId,actionId])?.result??null,credentialCurrent:credentials.state==='connected'&&generation===credentials.version.generation});
 }
 private enqueue(accountId:string,kind:'submission'|'mutation',replayKey:string,intent:object,validate:()=>void,precondition:string|null){
  this.account(accountId);const existing=this.db.get('SELECT id,kind,payload_json FROM mail_action_jobs WHERE account_id=? AND replay_key=?',[accountId,replayKey]);
  if(existing){const payload=z.object({version:z.literal(1),intent:z.unknown(),credentialGeneration:z.string().uuid()}).strict().safeParse(JSON.parse(string.parse(existing.payload_json)));if(existing.kind!==kind||!payload.success||JSON.stringify(payload.data.intent)!==JSON.stringify(intent))throw new MailLocalError('conflict');return this.action(accountId,string.parse(existing.id));}
  const credentials=this.credentials.status(accountId);if(credentials.state!=='connected')throw new MailLocalError('locked');validate();
  const status=this.journal.enqueue(accountId,{kind,replayKey,payloadJson:JSON.stringify({version:1,intent,credentialGeneration:credentials.version.generation}),precondition,conflictPolicy:'manual'});return this.action(accountId,status.id);
 }
 enqueueSubmission(accountId:string,supplied:MailSubmission){return this.safe(()=>{const input=parse(mailSubmissionSchema,supplied),intent={kind:'submission',draftId:input.draftId,version:input.version};const result=this.enqueue(accountId,'submission',input.replayKey,intent,()=>{const head=this.head(accountId,input.draftId);if(head.deleted)throw new MailLocalError('not_found');const content=this.snapshot(accountId,input.draftId,input.version);new SenderIdentityRepository(this.db,this.ownerId).assertSender(accountId,content);if(!content.to.length&&!content.cc.length&&!content.bcc.length)throw new MailLocalError('invalid_input');},null);this.db.run('INSERT INTO mail_local_action_drafts(account_id,action_id,draft_id,generation,revision) VALUES(?,?,?,?,?) ON CONFLICT(account_id,action_id) DO NOTHING',[accountId,result.id,input.draftId,input.version.generation,input.version.revision]);return result;});}
 enqueueMutation(accountId:string,supplied:MailMutation){return this.safe(()=>{
  const input=parse(mailMutationSchema,supplied),intent={kind:'mutation',locator:input.locator,precondition:input.precondition,change:input.change};
  return this.enqueue(accountId,'mutation',input.replayKey,intent,()=>{
   const provider=this.db.get('SELECT provider FROM mail_accounts WHERE id=?',[accountId])?.provider;
   if(provider==='graph')new GraphMailboxRepository(this.db,this.ownerId).assertWrite(accountId);
   if(input.change.kind==='mailbox'){
    if(input.locator||!['gmail','graph','imap'].includes(String(provider))||(input.change.operation==='rename'&&!input.change.destination))throw new MailLocalError('invalid_input');
    if((provider==='imap'||input.change.operation==='create')&&input.precondition!==provider+'-mailbox-v1')throw new MailLocalError('invalid_input');
    if(input.change.operation!=='create'&&!this.db.get('SELECT 1 FROM mail_folders WHERE account_id=? AND id=?',[accountId,input.change.path]))throw new MailLocalError('not_found');
   }else{
    if(!input.locator||provider!==input.locator.provider||!this.repository.readMessage(accountId,input.locator)||this.db.get('SELECT 1 FROM mail_tombstones WHERE account_id=? AND message_key=?',[accountId,providerMessageKey(input.locator)]))throw new MailLocalError('not_found');
    if(storedMutationPrecondition(this.db,accountId,input.locator)!==input.precondition)throw new MailLocalError('conflict');
   }
   if(input.change.kind==='memberships')for(const folder of [...input.change.add,...input.change.remove])if(!this.db.get('SELECT id FROM mail_folders WHERE account_id=? AND id=?',[accountId,folder]))throw new MailLocalError('not_found');
  },input.precondition);
 });}
 readAction(accountId:string,actionId:string){return this.safe(()=>{this.account(accountId);parse(mailActionReadSchema,{actionId});return this.action(accountId,actionId);});}
 listActions(accountId:string,supplied:MailActionPageInput){return this.safe(()=>{this.account(accountId);const page=parse(mailActionPageInputSchema,supplied);const rows=this.db.all("SELECT id FROM mail_action_jobs WHERE account_id=? AND id>? AND (?=0 OR state NOT IN ('succeeded','cancelled')) ORDER BY id LIMIT ?",[accountId,page.after??'',page.pendingOnly?1:0,page.limit+1]);const items=rows.slice(0,page.limit).map(row=>this.action(accountId,string.parse(row.id)));return{accountId,items,nextCursor:rows.length>page.limit?items.at(-1)?.id??null:null};});}
 cancelAction(accountId:string,supplied:MailActionCancel){return this.safe(()=>{this.account(accountId);const input=parse(mailActionCancelSchema,supplied);this.journal.cancel(accountId,input.actionId,input.expected);return this.action(accountId,input.actionId);});}
 readDraftAttachment(accountId:string,supplied:MailDraftAttachment){return this.safe(()=>{this.account(accountId);const input=parse(mailDraftAttachmentSchema,supplied),content=this.snapshot(accountId,input.draftId,input.version),part=content.attachments[input.ordinal];
  if(!part||part.referenceId!==input.referenceId||!this.db.get('SELECT 1 FROM mail_local_draft_parts WHERE account_id=? AND draft_id=? AND generation=? AND revision=? AND ordinal=? AND ref_id=?',[accountId,input.draftId,input.version.generation,input.version.revision,input.ordinal,input.referenceId]))throw new MailLocalError('not_found');
  return mailDraftAttachmentViewSchema.parse({draftId:input.draftId,version:input.version,ordinal:input.ordinal,chunk:{accountId,locator:part.locator,referenceId:input.referenceId,offset:input.offset,...new MailContentStore(this.db,this.ownerId).readRange(accountId,input.referenceId,input.offset,input.limit)}});
 });}
 events(accountId:string,supplied:MailEventQuery){return this.safe(()=>{this.account(accountId);const page=parse(mailEventQuerySchema,supplied),stream=string.parse(this.db.get('SELECT generation FROM mail_local_event_streams WHERE account_id=?',[accountId])?.generation);if(page.cursorOnly)return{accountId,stream,resetRequired:page.stream!==undefined&&page.stream!==stream,items:[],nextCursor:z.number().int().parse(this.db.get('SELECT coalesce(max(sequence),0) AS n FROM mail_local_events WHERE account_id=?',[accountId])?.n),hasMore:false};if(page.stream!==undefined&&page.stream!==stream)return{accountId,stream,resetRequired:true,items:[],nextCursor:z.number().int().parse(this.db.get('SELECT coalesce(max(sequence),0) AS n FROM mail_local_events WHERE account_id=?',[accountId])?.n),hasMore:false};const rows=this.db.all('SELECT * FROM mail_local_events WHERE account_id=? AND sequence>? ORDER BY sequence LIMIT ?',[accountId,page.after,page.limit+1]);const items=rows.slice(0,page.limit).map(row=>mailLocalEventSchema.parse({sequence:row.sequence,kind:row.kind,entityId:row.entity_id,state:row.state,version:row.generation===null?null:{generation:row.generation,revision:row.revision}}));return{accountId,stream,resetRequired:false,items,nextCursor:items.at(-1)?.sequence??page.after,hasMore:rows.length>page.limit};});}
}
