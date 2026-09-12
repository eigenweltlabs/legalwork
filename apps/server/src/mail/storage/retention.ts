import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {MailDatabase} from './database-interface.js';
import {mailAccountTables} from './consistency.js';
import {retentionScopeSchema,retentionSettingsSchema,retentionPreviewSchema,retentionApplySchema,MailRetentionError,type RetentionScope,type RetentionPreview} from '../retention-view.js';
const text=z.string(),number=z.number().int().nonnegative();
/** All deletion and preview calculations run in the worker's same synchronous transaction. */
export class MailRetentionStore{
 private previews=new Map<string,{accountId:string;scope:RetentionScope;fingerprint:string;expiresAt:number}>();
 constructor(readonly db:MailDatabase,readonly ownerId:string){}
 private account(accountId:string){const row=this.db.get("SELECT a.provider,coalesce(c.state,i.state,'disconnected') state,coalesce(c.generation,i.generation,'offline') generation,coalesce(c.revision,i.revision,0) revision,parent.generation parent_generation,parent.revision parent_revision FROM mail_accounts a LEFT JOIN mail_account_access c ON c.account_id=a.id LEFT JOIN mail_imap_credentials i ON i.account_id=a.id LEFT JOIN mail_graph_mailboxes shared ON shared.account_id=a.id LEFT JOIN mail_account_credentials parent ON parent.account_id=shared.credential_account_id WHERE a.id=? AND a.owner_id=?",[accountId,this.ownerId]);if(!row)throw new MailRetentionError('not_found');return row;}
 settings(accountId:string,input?:z.infer<typeof retentionSettingsSchema>){this.account(accountId);if(input){const value=retentionSettingsSchema.parse(input);this.db.run('INSERT INTO mail_retention_settings(account_id,removed_days) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET removed_days=excluded.removed_days,revision=revision+1',[accountId,value.removedDays]);}return retentionSettingsSchema.parse({removedDays:this.db.get('SELECT removed_days FROM mail_retention_settings WHERE account_id=?',[accountId])?.removed_days??null});}
 private count(sql:string,accountId:string){return number.parse(this.db.get(sql,[accountId])?.n);}
 private plan(accountId:string,scope:RetentionScope,apply:boolean){
  const account=this.account(accountId),settings=this.settings(accountId),digest=createHash('sha256'),blockers:RetentionPreview['blockers']=[];
  const retainedRecords=this.count('SELECT count(*) n FROM mail_filing_snapshots WHERE account_id=?',accountId),drafts=this.count('SELECT count(*) n FROM mail_local_drafts WHERE account_id=?',accountId),submissions=this.count("SELECT count(*) n FROM mail_action_jobs WHERE account_id=? AND kind='submission'",accountId);
  if(account.provider==='archive'&&!scope.includeArchive)blockers.push('archive_not_selected');
  if(this.db.get("SELECT 1 FROM mail_action_jobs WHERE account_id=? AND state IN ('queued','running','dispatching','retry') LIMIT 1",[accountId])||this.db.get("SELECT 1 FROM mail_actions WHERE account_id=? AND state IN ('queued','running') LIMIT 1",[accountId])||this.db.get("SELECT 1 FROM mail_draft_sync WHERE account_id=? AND enabled=1 AND state IN ('queued','syncing') LIMIT 1",[accountId])||this.db.get("SELECT 1 FROM mail_portability_jobs WHERE account_id=? AND state='running' LIMIT 1",[accountId])||this.db.get("SELECT 1 FROM mail_attachment_extractions WHERE account_id=? AND state='running' LIMIT 1",[accountId]))blockers.push('active_work');
  if(scope.scope==='account'){
   if(account.state==='connected')blockers.push('connected');
   if(retainedRecords)blockers.push('retained_records');
   if(this.db.get('SELECT 1 FROM mail_graph_mailboxes WHERE credential_account_id=? LIMIT 1',[accountId]))blockers.push('shared_children');
   if(this.db.get("SELECT 1 FROM mail_portability_jobs WHERE account_id=? AND state<>'complete' LIMIT 1",[accountId]))blockers.push('unfinished_import');
  }
  digest.update(JSON.stringify([account,scope,settings,retainedRecords,drafts,submissions,blockers]));
  for(const table of ['mail_local_drafts','mail_action_jobs','mail_retention_settings']){let after=0;while(true){const rows=this.db.all(`SELECT rowid AS cursor,* FROM ${table} WHERE account_id=? AND rowid>? ORDER BY rowid LIMIT 100`,[accountId,after]);if(!rows.length)break;for(const row of rows){after=number.parse(row.cursor);digest.update(JSON.stringify(row));}}}
  this.db.exec('SAVEPOINT retention_calculation');
  let messages=0,references=0,bytes=0,protectedReferences=0;
  try{
   this.db.exec('CREATE TEMP TABLE retention_messages(message_key TEXT PRIMARY KEY);CREATE TEMP TABLE retention_refs(id TEXT PRIMARY KEY)');
   if(scope.scope==='removed'){
    if(!scope.before)throw new MailRetentionError('invalid_input');
    this.db.run('INSERT INTO retention_messages SELECT m.message_key FROM mail_messages m JOIN mail_tombstones t ON t.account_id=m.account_id AND t.message_key=m.message_key WHERE m.account_id=? AND t.observed_at<=?',[accountId,scope.before]);
   }else this.db.run('INSERT INTO retention_messages SELECT message_key FROM mail_messages WHERE account_id=?',[accountId]);
   messages=number.parse(this.db.get('SELECT count(*) n FROM retention_messages')?.n);
   let after='';while(true){const rows=this.db.all('SELECT m.message_key,m.subject,m.locator_json FROM mail_messages m JOIN retention_messages r ON r.message_key=m.message_key WHERE m.account_id=? AND m.message_key>? ORDER BY m.message_key LIMIT 100',[accountId,after]);if(!rows.length)break;for(const row of rows){after=text.parse(row.message_key);digest.update(JSON.stringify(row));}}
   if(scope.scope==='account')this.db.run('INSERT INTO retention_refs SELECT id FROM mail_content_refs WHERE account_id=?',[accountId]);
   else for(const [table,column] of [['mail_content_manifests','ref_id'],['mail_mime_projections','raw_ref_id'],['mail_mime_projections','body_ref_id'],['mail_mime_parts','content_ref_id'],['mail_graph_attachments','ref_id'],['mail_attachment_extractions','ref_id']])this.db.run(`INSERT OR IGNORE INTO retention_refs SELECT ${column} FROM ${table} WHERE account_id=? AND message_key IN (SELECT message_key FROM retention_messages) AND ${column} IS NOT NULL`,[accountId]);
   // Fingerprint exact bytes and identities before any deletion, including pinned references.
   after='';while(true){const rows=this.db.all('SELECT r.id,r.bytes,r.sha256 FROM mail_content_refs r JOIN retention_refs c ON c.id=r.id WHERE r.account_id=? AND r.id>? ORDER BY r.id LIMIT 100',[accountId,after]);if(!rows.length)break;for(const row of rows){after=text.parse(row.id);digest.update(JSON.stringify(row));}}
   if(!blockers.length){
    if(scope.scope==='account'){
     const counts=this.db.get('SELECT count(*) n,coalesce(sum(bytes),0) bytes FROM mail_content_refs WHERE account_id=?',[accountId]);references=number.parse(counts?.n);bytes=number.parse(counts?.bytes);
     // Deferral is transaction-local; the final FK check must pass before commit.
     this.db.exec('PRAGMA defer_foreign_keys=ON');
     for(const table of mailAccountTables)this.db.run(`DELETE FROM ${table} WHERE account_id=?`,[accountId]);
     this.db.run('DELETE FROM mail_accounts WHERE id=? AND owner_id=?',[accountId,this.ownerId]);
    }else{
     this.db.run('DELETE FROM mail_attachment_extractions WHERE account_id=? AND message_key IN (SELECT message_key FROM retention_messages)',[accountId]);
     this.db.run('DELETE FROM mail_messages WHERE account_id=? AND message_key IN (SELECT message_key FROM retention_messages)',[accountId]);
     after='';while(true){const rows=this.db.all('SELECT r.id,r.bytes,p.object_id FROM mail_content_refs r JOIN retention_refs c ON c.id=r.id LEFT JOIN mail_blob_publications p ON p.account_id=r.account_id AND p.ref_id=r.id WHERE r.account_id=? AND r.id>? ORDER BY r.id LIMIT 100',[accountId,after]);if(!rows.length)break;for(const row of rows){const id=text.parse(row.id);after=id;
      if(this.db.get("SELECT 1 FROM mail_portability_entries e JOIN mail_portability_jobs j ON j.id=e.job_id WHERE j.account_id=? AND j.state<>'complete' AND e.reference_id=? LIMIT 1",[accountId,id])){protectedReferences++;continue;}
      if(typeof row.object_id!=='string')throw new MailRetentionError('conflict');
      this.db.exec('SAVEPOINT retention_reference');try{this.db.run('DELETE FROM mail_blob_publications WHERE account_id=? AND ref_id=?',[accountId,id]);this.db.run('DELETE FROM mail_content_refs WHERE account_id=? AND id=?',[accountId,id]);this.db.run('DELETE FROM mail_blob_objects WHERE account_id=? AND id=?',[accountId,row.object_id]);this.db.exec('RELEASE retention_reference');references++;bytes+=number.parse(row.bytes);}catch(error){this.db.exec('ROLLBACK TO retention_reference;RELEASE retention_reference');if(error instanceof Error&&/FOREIGN KEY constraint failed/i.test(error.message))protectedReferences++;else throw error;}
     }}
    }
    if(this.db.get('SELECT 1 FROM pragma_foreign_key_check LIMIT 1'))throw new MailRetentionError('conflict');
   }
   digest.update(JSON.stringify([messages,references,bytes,protectedReferences]));
   this.db.exec('DROP TABLE retention_refs;DROP TABLE retention_messages');
   if(!apply)this.db.exec('ROLLBACK TO retention_calculation');this.db.exec('RELEASE retention_calculation');
  }catch(error){this.db.exec('ROLLBACK TO retention_calculation;RELEASE retention_calculation');throw error;}
  return {accountId,scope,messages,references,bytes,protectedReferences,retainedRecords,drafts,submissions,blockers,accountGeneration:text.parse(account.generation),settings,fingerprint:digest.digest('hex')};
 }
 preview(accountId:string,supplied:RetentionScope){const scope=retentionScopeSchema.parse(supplied),plan=this.db.transaction(()=>this.plan(accountId,scope,false)),token=randomBytes(32).toString('hex'),expiresAt=Date.now()+600000;for(const [key,value] of this.previews)if(value.expiresAt<Date.now())this.previews.delete(key);if(this.previews.size>=100)this.previews.clear();this.previews.set(token,{accountId,scope,fingerprint:plan.fingerprint,expiresAt});const {fingerprint,...result}=plan;return retentionPreviewSchema.parse({...result,token,expiresAt});}
 apply(accountId:string,supplied:z.infer<typeof retentionApplySchema>){const input=retentionApplySchema.parse(supplied),saved=this.previews.get(input.token);if(!saved||saved.accountId!==accountId||saved.expiresAt<Date.now())throw new MailRetentionError('conflict');const result=this.db.transaction(()=>{const current=this.plan(accountId,saved.scope,false);if(current.blockers.length)throw new MailRetentionError('locked');if(current.fingerprint!==saved.fingerprint)throw new MailRetentionError('conflict');const applied=this.plan(accountId,saved.scope,true);return{accountId,removedAccount:saved.scope.scope==='account',messages:applied.messages,references:applied.references,bytes:applied.bytes,protectedReferences:applied.protectedReferences};});this.previews.delete(input.token);return result;}
}
