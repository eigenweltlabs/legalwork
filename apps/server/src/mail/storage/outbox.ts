import {isRestoredMailWork} from './recovery-quarantine.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {MailDatabase} from './database-interface.js';
import {MailLocalApiStore} from './local-api.js';
import {MailCredentialRepository} from './credentials.js';
import {MailActionJournal} from './action-journal.js';
import {MailContentStore} from './content-store.js';
import {SenderIdentityRepository} from './sender-identities.js';
import {SmtpCustody} from './smtp-custody.js';
import {mailDraftPreview,mailDraftContentSchema} from '../local-view.js';
import {buildMailMime} from '../mime/compose.js';
import {OutboxError,outboxItemSchema,outboxResultSchema,outboxSubmissionSchema,outboxRescheduleSchema,type OutboxSubmission,type OutboxReschedule,type OutboxErrorCode,type OutboxResult} from '../outbox-view.js';
import {mailTimeSchema,validFutureMailTime,type MailTime} from '../scheduling-view.js';
const stored=z.object({account_id:z.string(),action_id:z.string(),draft_id:z.string(),draft_generation:z.string(),draft_revision:z.number(),message_id:z.string(),mime_bytes:z.instanceof(Uint8Array),api_mime_bytes:z.instanceof(Uint8Array),envelope_json:z.string(),content_json:z.string(),credential_generation:z.string(),smtp_generation:z.string().nullable(),preparation_json:z.string().nullable(),result_json:z.string().nullable(),error:z.string().nullable(),created_at:z.number(),updated_at:z.number()});
export type OutboxRow=z.infer<typeof stored>;
export class OutboxStore{
 readonly journal:MailActionJournal;readonly local:MailLocalApiStore;
 constructor(readonly db:MailDatabase,readonly ownerId:string,private readonly time:()=>number=Date.now){this.journal=new MailActionJournal(db,ownerId,time);this.local=new MailLocalApiStore(db,ownerId);}
 account(accountId:string){const row=this.db.get('SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?',[accountId,this.ownerId]);if(!row||!['gmail','graph','imap'].includes(String(row.provider)))throw new OutboxError('credentials_changed');return z.enum(['gmail','graph','imap']).parse(row.provider);}
 row(accountId:string,actionId:string){this.account(accountId);return stored.parse(this.db.get('SELECT * FROM mail_outbox WHERE account_id=? AND action_id=?',[accountId,actionId]));}
 restored(accountId:string,actionId:string){return isRestoredMailWork(this.db,accountId,'submission',actionId);}
 content(row:OutboxRow){return mailDraftContentSchema.parse(JSON.parse(row.content_json));}
 envelope(row:OutboxRow){return z.object({from:z.string(),to:z.array(z.string())}).parse(JSON.parse(row.envelope_json));}
 item(accountId:string,actionId:string){const row=this.row(accountId,actionId),job=this.journal.read(accountId,actionId),content=this.content(row);return outboxItemSchema.parse({id:actionId,accountId,draftId:row.draft_id,version:job.version,subject:content.subject,schedule:this.schedule(accountId,actionId),summary:mailDraftPreview(content),from:content.from,state:job.state==='succeeded'?'accepted':job.state==='running'||job.state==='dispatching'?'sending':job.state==='retry'?'queued':job.state,attempts:job.attempts,createdAt:row.created_at,updatedAt:row.updated_at,error:row.error,result:row.result_json?outboxResultSchema.parse(JSON.parse(row.result_json)):null,restored:this.restored(accountId,actionId),cancellationGuaranteed:['queued','retry','running'].includes(job.state)});}
 read(accountId:string,actionId:string){return{accountId,actionId,content:this.content(this.row(accountId,actionId))};}
 list(accountId:string){this.account(accountId);return this.db.all('SELECT action_id FROM mail_outbox WHERE account_id=? ORDER BY created_at DESC,action_id DESC LIMIT 100',[accountId]).map(row=>this.item(accountId,z.string().parse(row.action_id)));}
 async queue(accountId:string,supplied:OutboxSubmission,fence?:{check:()=>void;commit:(actionId:string)=>void}){fence?.check();const {schedule,...input}=outboxSubmissionSchema.parse(supplied),provider=this.account(accountId);const existing=this.db.get('SELECT action_id FROM mail_outbox WHERE account_id=? AND draft_id=? AND draft_generation=? AND draft_revision=?',[accountId,input.draftId,input.version.generation,input.version.revision]);if(existing){const actionId=z.string().parse(existing.action_id);this.sameSchedule(accountId,actionId,schedule);fence?.commit(actionId);return this.item(accountId,actionId);}
  if(schedule&&!validFutureMailTime(schedule,this.time()))throw new OutboxError('schedule_invalid');
  const credentials=new MailCredentialRepository(this.db,this.ownerId),status=credentials.status(accountId);if(status.state!=='connected'||status.archiveLocked)throw new OutboxError('credentials_changed');const draft=this.local.readDraft(accountId,{draftId:input.draftId,version:input.version});let identity;try{identity=new SenderIdentityRepository(this.db,this.ownerId).assertSender(accountId,draft.content);}catch{throw new OutboxError('sender_unavailable');}
  const smtp=provider==='imap'?new SmtpCustody(this.db,this.ownerId).read(accountId):null;
  const messageId='<'+createHash('sha256').update(JSON.stringify([accountId,input.draftId,input.version])).digest('hex')+'@legalwork.local>';
  let built;try{built=await buildMailMime(draft.content,{authorizedSenders:[identity.address],messageId,date:new Date(this.time()),attachment:async part=>Buffer.concat([...new MailContentStore(this.db,this.ownerId).read(accountId,part.referenceId)])});}catch{throw new OutboxError('invalid_message');}
  const api=Buffer.concat([Buffer.from(draft.content.bcc.length?'Bcc: '+draft.content.bcc.join(', ')+'\r\n':''),built.raw]);if(api.byteLength>30*1024*1024)throw new OutboxError('too_large');
  if(provider==='graph'&&api.byteLength*4/3>3900000){if(identity.source==='administrator_confirmed')throw new OutboxError('large_shared_unsupported');if(draft.content.attachments.some(part=>part.disposition==='inline'&&(part.bytes??0)>=3*1024*1024))throw new OutboxError('large_inline_unsupported');}
  return this.db.transaction(()=>{fence?.check();const current=credentials.status(accountId);if(current.state!=='connected'||current.archiveLocked||current.version.generation!==status.version.generation)throw new OutboxError('credentials_changed');new SenderIdentityRepository(this.db,this.ownerId).assertSender(accountId,draft.content);if(smtp)new SmtpCustody(this.db,this.ownerId).assert(accountId,smtp.generation);
   const raced=this.db.get('SELECT action_id FROM mail_outbox WHERE account_id=? AND draft_id=? AND draft_generation=? AND draft_revision=?',[accountId,input.draftId,input.version.generation,input.version.revision]);if(raced){const actionId=z.string().parse(raced.action_id);this.sameSchedule(accountId,actionId,schedule);fence?.commit(actionId);return this.item(accountId,actionId);}
   if(schedule&&!validFutureMailTime(schedule,this.time()))throw new OutboxError('schedule_invalid');
   const action=this.local.enqueueSubmission(accountId,input),now=this.time();this.db.run(`INSERT INTO mail_outbox(account_id,action_id,draft_id,draft_generation,draft_revision,message_id,mime_bytes,api_mime_bytes,envelope_json,content_json,credential_generation,smtp_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[accountId,action.id,input.draftId,input.version.generation,input.version.revision,messageId,built.raw,api,JSON.stringify(built.envelope),JSON.stringify(draft.content),status.version.generation,smtp?.generation??null,now,now]);if(schedule){this.db.run('INSERT INTO mail_outbox_schedules(account_id,action_id,scheduled_at,time_zone) VALUES(?,?,?,?)',[accountId,action.id,schedule.at,schedule.timeZone]);this.db.run('UPDATE mail_action_jobs SET available_at=? WHERE account_id=? AND id=?',[schedule.at,accountId,action.id]);}fence?.commit(action.id);return this.item(accountId,action.id);
  });
 }
 schedule(accountId:string,actionId:string):MailTime|undefined {
  this.account(accountId);
  const row=this.db.get('SELECT scheduled_at,time_zone FROM mail_outbox_schedules WHERE account_id=? AND action_id=?',[accountId,actionId]);
  return row?mailTimeSchema.parse({at:row.scheduled_at,timeZone:row.time_zone}):undefined;
 }
 private sameSchedule(accountId:string,actionId:string,time:MailTime|undefined){
  const current=this.schedule(accountId,actionId);
  if(current?.at!==time?.at||current?.timeZone!==time?.timeZone)throw new OutboxError('schedule_conflict');
 }
 reschedule(accountId:string,supplied:OutboxReschedule){
  const input=outboxRescheduleSchema.parse(supplied);
  if(!validFutureMailTime(input.time,this.time()))throw new OutboxError('schedule_invalid');
  return this.db.transaction(()=>{
   const row=this.row(accountId,input.actionId),job=this.journal.read(accountId,input.actionId);
   if(job.version.generation!==input.expected.generation||job.version.revision!==input.expected.revision||job.version.revision>=Number.MAX_SAFE_INTEGER||!['queued','retry'].includes(job.state)||job.cancelRequested||!this.schedule(accountId,input.actionId)||row.preparation_json&&JSON.parse(row.preparation_json).uncertain)throw new OutboxError('schedule_conflict');
   this.assert(row);
   this.db.run('UPDATE mail_outbox_schedules SET scheduled_at=?,time_zone=? WHERE account_id=? AND action_id=?',[input.time.at,input.time.timeZone,accountId,input.actionId]);
   this.db.run('UPDATE mail_action_jobs SET available_at=?,revision=revision+1,last_error=NULL WHERE account_id=? AND id=?',[input.time.at,accountId,input.actionId]);
   this.db.run('UPDATE mail_outbox SET error=NULL,updated_at=? WHERE account_id=? AND action_id=?',[this.time(),accountId,input.actionId]);
   return this.item(accountId,input.actionId);
  });
 }
 assertDue(row:OutboxRow){this.assert(row);const time=this.schedule(row.account_id,row.action_id);if(time&&time.at>this.time())throw new OutboxError('retryable');}
 assert(row:OutboxRow){if(this.restored(row.account_id,row.action_id))throw new OutboxError('credentials_changed');const current=new MailCredentialRepository(this.db,this.ownerId).status(row.account_id);if(current.state!=='connected'||current.archiveLocked||current.version.generation!==row.credential_generation)throw new OutboxError('credentials_changed');try{new SenderIdentityRepository(this.db,this.ownerId).assertSender(row.account_id,this.content(row));}catch{throw new OutboxError('sender_unavailable');}if(row.smtp_generation)new SmtpCustody(this.db,this.ownerId).assert(row.account_id,row.smtp_generation);}
 preparation(row:OutboxRow,value:unknown){this.db.run('UPDATE mail_outbox SET preparation_json=?,updated_at=? WHERE account_id=? AND action_id=?',[JSON.stringify(value),this.time(),row.account_id,row.action_id]);}
 result(row:OutboxRow,value:OutboxResult){this.db.run('UPDATE mail_outbox SET result_json=?,error=NULL,updated_at=? WHERE account_id=? AND action_id=?',[JSON.stringify(outboxResultSchema.parse(value)),this.time(),row.account_id,row.action_id]);}
 error(row:OutboxRow,error:OutboxErrorCode|null){this.db.run('UPDATE mail_outbox SET error=?,updated_at=? WHERE account_id=? AND action_id=?',[error,this.time(),row.account_id,row.action_id]);}
 attempt(row:OutboxRow,attempt:number,phase:'preparing'|'dispatching'|'accepted'|'failed'|'uncertain',error:OutboxErrorCode|null=null){this.db.run(`INSERT INTO mail_outbox_attempts(account_id,action_id,attempt,started_at,phase,error) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,action_id,attempt) DO UPDATE SET phase=excluded.phase,error=excluded.error,finished_at=?`,[row.account_id,row.action_id,attempt,this.time(),phase,error,['accepted','failed','uncertain'].includes(phase)?this.time():null]);}
 cancel(accountId:string,actionId:string){this.row(accountId,actionId);return this.db.transaction(()=>{const status=this.journal.read(accountId,actionId);if(status.state==='failed'){this.db.run("UPDATE mail_action_jobs SET state='cancelled',cancel_requested=1,revision=revision+1,last_error='cancelled' WHERE account_id=? AND id=?",[accountId,actionId]);}else this.journal.cancel(accountId,actionId,status.version);return this.item(accountId,actionId);});}
 retry(accountId:string,actionId:string){if(this.restored(accountId,actionId))throw new OutboxError('credentials_changed');return this.db.transaction(()=>{const row=this.row(accountId,actionId),status=this.journal.read(accountId,actionId);if(status.state!=='failed'||status.cancelRequested||row.preparation_json&&JSON.parse(row.preparation_json).uncertain)throw new OutboxError('outcome_unknown');const current=new MailCredentialRepository(this.db,this.ownerId).status(accountId);if(current.state!=='connected'||current.archiveLocked)throw new OutboxError('credentials_changed');new SenderIdentityRepository(this.db,this.ownerId).assertSender(accountId,this.content(row));const smtp=this.account(accountId)==='imap'?new SmtpCustody(this.db,this.ownerId).read(accountId):null;this.db.run("UPDATE mail_outbox SET credential_generation=?,smtp_generation=?,error=NULL,updated_at=? WHERE account_id=? AND action_id=?",[current.version.generation,smtp?.generation??null,this.time(),accountId,actionId]);this.db.run("UPDATE mail_action_jobs SET state='queued',revision=revision+1,available_at=?,max_attempts=attempts+5,last_error=NULL,payload_json=json_set(payload_json,'$.credentialGeneration',?) WHERE account_id=? AND id=?",[this.time(),current.version.generation,accountId,actionId]);return this.item(accountId,actionId);});}
}
