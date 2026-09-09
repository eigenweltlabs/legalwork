import { MailRepository } from "./repository.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { providerMessageKey, providerMessageLocatorSchema, type ProviderMessageLocator } from "../model.js";
import type { MailDatabase } from "./database-interface.js";
const id = z.string().min(1).max(4096), integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const state = z.enum(["active","paused","complete","attention"]);
const error = z.enum(["reconsent_required","configuration_invalid","provider_unavailable","rate_limited","message_unavailable","content_incomplete","storage_unavailable","sync_failed"]);
const stamp = z.object({generation:id,revision:integer.min(1)}).strict();
const runRow = z.object({account_id:id,generation:id,revision:integer.min(1),state,recent_after:integer,next_retry_at:integer.nullable(),failure_count:integer.max(5),error:error.nullable()});
const metadataInput = z.object({internalDate:integer,threadId:id,labelIds:z.array(id).max(10000)}).strict();
export type GmailRunError = z.infer<typeof error>;
export type GmailRunState = z.infer<typeof state>;
export type GmailRunVersion = z.infer<typeof stamp>;
export type GmailMetadata = z.infer<typeof metadataInput>;
export type GmailRun = {accountId:string;generation:string;revision:number;state:GmailRunState;recentAfter:number;failureCount:number;nextRetryAt:number|null;error:GmailRunError|null};
export class GmailStateError extends Error {
  constructor(readonly code:"invalid_input"|"not_found"|"provider_mismatch"|"stale_run"|"storage_unavailable") {super(`mail_gmail_state_${code}`);}
}
function safe<T>(body:()=>T):T{try{return body();}catch(error){if(error instanceof GmailStateError)throw error;throw new GmailStateError("storage_unavailable");}}
function input<T>(schema:z.ZodType<T>,value:unknown):T{const parsed=schema.safeParse(value);if(!parsed.success)throw new GmailStateError("invalid_input");return parsed.data;}
function view(row:z.infer<typeof runRow>):GmailRun{return{accountId:row.account_id,generation:row.generation,revision:row.revision,state:row.state,recentAfter:row.recent_after,failureCount:row.failure_count,nextRetryAt:row.next_retry_at,error:row.error};}
/** Current Gmail backfill generation. Journal scopes own cursors and distinct job progress. */
export class GmailRunStore {
  private readonly ownerId:string;
  constructor(private readonly database:MailDatabase,ownerId:string,private readonly now:()=>number=Date.now){this.ownerId=input(id,ownerId);}
  private account(accountId:string):void{const row=this.database.get("SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?",[input(id,accountId),this.ownerId]);if(!row)throw new GmailStateError("not_found");if(row.provider!=="gmail")throw new GmailStateError("provider_mismatch");}
  read(accountId:string):GmailRun|null{return safe(()=>{this.account(accountId);const row=this.database.get("SELECT * FROM mail_gmail_runs WHERE account_id=?",[accountId]);return row?view(runRow.parse(row)):null;});}
  startOrResume(accountId:string):GmailRun{return safe(()=>this.database.transaction(()=>{
    const old=this.read(accountId);if(old?.state==="complete")return old;
    if(old?.revision===Number.MAX_SAFE_INTEGER)throw new GmailStateError("stale_run");
    const generation=old?.generation??randomUUID(),revision=(old?.revision??0)+1,recentAfter=old?.recentAfter??Math.max(0,Math.floor(input(integer,this.now())/1000)-30*86400);
    this.database.run(`INSERT INTO mail_gmail_runs(account_id,generation,revision,state,recent_after,next_retry_at,error) VALUES(?,?,?,'active',?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,state='active'`,[accountId,generation,revision,recentAfter,old?.nextRetryAt??null,old?.error??null]);
    return {accountId,generation,revision,state:"active",recentAfter,failureCount:old?.failureCount??0,nextRetryAt:old?.nextRetryAt??null,error:old?.error??null};
  }));}
  assertCurrent(accountId:string,expected:GmailRunVersion):void{safe(()=>{const wanted=input(stamp,expected),current=this.read(accountId);if(!current||current.state!=="active"||current.generation!==wanted.generation||current.revision!==wanted.revision)throw new GmailStateError("stale_run");});}
  setState(accountId:string,expected:GmailRunVersion,next:GmailRunState,details:{failureCount?:number;nextRetryAt?:number|null;error?:GmailRunError|null}={}):GmailRun{return safe(()=>this.database.transaction(()=>{
    const wanted=input(stamp,expected),selected=input(state,next),info=input(z.object({failureCount:integer.max(5).optional(),nextRetryAt:integer.nullable().optional(),error:error.nullable().optional()}).strict(),details),old=this.read(accountId);
    if(!old||old.generation!==wanted.generation||old.revision!==wanted.revision||old.revision===Number.MAX_SAFE_INTEGER)throw new GmailStateError("stale_run");
    const result={...old,state:selected,revision:old.revision+1,failureCount:info.failureCount??old.failureCount,nextRetryAt:info.nextRetryAt??null,error:info.error??null};
    this.database.run("UPDATE mail_gmail_runs SET revision=?,state=?,next_retry_at=?,error=?,failure_count=? WHERE account_id=?",[result.revision,result.state,result.nextRetryAt,result.error,result.failureCount,accountId]);return result;
  }));}
  putGmailMetadata(accountId:string,locator:ProviderMessageLocator,supplied:GmailMetadata):void{safe(()=>this.database.transaction(()=>{
    this.account(accountId);const identity=input(providerMessageLocatorSchema,locator);if(identity.provider!=="gmail")throw new GmailStateError("provider_mismatch");const value=input(metadataInput,supplied);
    const repository=new MailRepository(this.database,this.ownerId),current=repository.readMessage(accountId,identity);
    if(!current)throw new GmailStateError("not_found");
    for(const labelId of new Set(value.labelIds))if(!this.database.get("SELECT id FROM mail_folders WHERE account_id=? AND id=?",[accountId,labelId]))repository.putFolder(accountId,{id:labelId,name:labelId,kind:"label"});
    repository.ingestMessage(accountId,{locator:identity,rfcMessageId:current.rfc_message_id,subject:current.subject,threadId:value.threadId,memberships:value.labelIds});
    this.database.run(`INSERT INTO mail_gmail_metadata(account_id,message_key,internal_date,thread_id,label_ids_json) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,message_key) DO UPDATE SET internal_date=excluded.internal_date,thread_id=excluded.thread_id,label_ids_json=excluded.label_ids_json`,[accountId,providerMessageKey(identity),value.internalDate,value.threadId,JSON.stringify([...new Set(value.labelIds)])]);
  }));}
  readGmailMetadata(accountId:string,locator:ProviderMessageLocator):GmailMetadata|null{return safe(()=>{this.account(accountId);const row=this.database.get("SELECT internal_date,thread_id,label_ids_json FROM mail_gmail_metadata WHERE account_id=? AND message_key=?",[accountId,providerMessageKey(locator)]);if(!row)return null;if(typeof row.label_ids_json!=="string")throw new GmailStateError("storage_unavailable");return input(metadataInput,{internalDate:row.internal_date,threadId:row.thread_id,labelIds:JSON.parse(row.label_ids_json)});});}
  progress(accountId:string,generation:string){return safe(()=>this.database.transaction(()=>{
    this.account(accountId);input(id,generation);
    const row=this.database.get(`SELECT count(*) AS enumerated,
      coalesce(sum(j.state='failed'),0) AS failed,coalesce(sum(j.state IN ('queued','running','retry')),0) AS pending,
      min(CASE WHEN j.state='retry' THEN j.available_at END) AS next_retry_at,
      coalesce(sum(EXISTS(SELECT 1 FROM mail_content_manifests m JOIN mail_blob_publications p ON p.account_id=m.account_id AND p.ref_id=m.ref_id WHERE m.account_id=j.account_id AND m.message_key=j.message_key AND m.kind='raw' AND m.state='stored')),0) AS downloaded,
      coalesce(sum(EXISTS(SELECT 1 FROM mail_mime_projections p JOIN mail_content_manifests m ON m.account_id=p.account_id AND m.message_key=p.message_key AND m.ref_id=p.raw_ref_id WHERE p.account_id=j.account_id AND p.message_key=j.message_key AND p.state='complete' AND m.kind='raw' AND m.state='stored' AND EXISTS(SELECT 1 FROM mail_content_manifests b JOIN mail_blob_publications bp ON bp.account_id=b.account_id AND bp.ref_id=b.ref_id WHERE b.account_id=p.account_id AND b.message_key=p.message_key AND b.kind='body' AND b.state='stored' AND b.ref_id=p.body_ref_id)
       AND EXISTS(SELECT 1 FROM mail_messages mm WHERE mm.account_id=p.account_id AND mm.message_key=p.message_key AND mm.attachments_enumerated=1)
       AND NOT EXISTS(SELECT 1 FROM mail_content_manifests bad LEFT JOIN mail_content_refs rr ON rr.account_id=bad.account_id AND rr.id=bad.ref_id
         LEFT JOIN mail_blob_publications pp ON pp.account_id=rr.account_id AND pp.ref_id=rr.id LEFT JOIN mail_blob_objects oo ON oo.account_id=pp.account_id AND oo.id=pp.object_id
         WHERE bad.account_id=p.account_id AND bad.message_key=p.message_key AND (bad.state!='stored' OR oo.state IS NOT 'published' OR oo.bytes IS NOT rr.bytes OR oo.chunk_count IS NOT (rr.bytes/65536+CASE WHEN rr.bytes%65536>0 THEN 1 ELSE 0 END)))
       AND NOT EXISTS(SELECT 1 FROM mail_mime_parts mp WHERE mp.account_id=p.account_id AND mp.message_key=p.message_key AND mp.raw_ref_id=p.raw_ref_id
         AND NOT EXISTS(SELECT 1 FROM mail_content_manifests am WHERE am.account_id=mp.account_id AND am.message_key=mp.message_key AND am.kind='attachment' AND am.part_id=mp.part_id AND am.ref_id=mp.content_ref_id AND am.state='stored')))),0) AS projected
      FROM mail_sync_jobs j WHERE j.account_id=? AND j.generation=? AND j.kind='raw'`,[accountId,generation]);
    const jobs=this.database.get("SELECT coalesce(sum(state='failed'),0) AS failed,coalesce(sum(state IN ('queued','running','retry')),0) AS pending,min(CASE WHEN state='retry' THEN available_at END) AS next_retry_at FROM mail_sync_jobs WHERE account_id=? AND generation=?",[accountId,generation]);
    const scopes=this.database.get("SELECT count(*) AS n FROM mail_sync_scopes WHERE account_id=? AND generation=? AND scope_id IN ('gmail:recent','gmail:all') AND discovery_complete=1",[accountId,generation]);
    return{enumerated:integer.parse(row?.enumerated),downloaded:integer.parse(row?.downloaded),failed:integer.parse(jobs?.failed),pending:integer.parse(jobs?.pending),projected:integer.parse(row?.projected),nextRetryAt:integer.nullable().parse(jobs?.next_retry_at),enumerationComplete:scopes?.n===2};
  }));}
}
