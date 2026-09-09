import { z } from "zod";
import { providerMessageKey, type ProviderMessageLocator } from "../model.js";
import type { MailDatabase } from "./database-interface.js";
import type { MailContentReference } from "./content-store.js";
const id=z.string().min(1).max(4096),text=z.string().max(65536).nullable();
export const mimeErrorSchema=z.enum(["invalid_input","limit","timeout","cancelled","malformed","unsupported","source_failed","sink_failed","hash_mismatch"]);
export const mimeMetadataSchema=z.object({subject:text,from:text,to:text,cc:text,bcc:text,replyTo:text,date:text,messageId:text}).strict();
const bodySchema=z.object({partId:id,contentType:z.enum(["text/plain","text/html"])}).strict();
const referenceSchema=z.object({id,bytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const partSchema=z.object({partId:id,filename:text,contentType:z.string().min(1).max(4096),disposition:z.enum(["inline","attachment"]),contentId:text,reference:referenceSchema}).strict();
const projectionSchema=z.object({metadata:mimeMetadataSchema,bodies:z.array(bodySchema).max(1000),body:referenceSchema,attachments:z.array(partSchema).max(1000)}).strict();
export type StoredMimeProjection=z.infer<typeof projectionSchema>;
export class MimeProjectionStorageError extends Error{constructor(readonly code:"invalid_input"|"not_found"|"stale_raw"|"storage_unavailable"){super(`mail_mime_projection_${code}`);}}
function safe<T>(body:()=>T):T{try{return body();}catch(error){if(error instanceof MimeProjectionStorageError)throw error;throw new MimeProjectionStorageError("storage_unavailable");}}
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new MimeProjectionStorageError("invalid_input");return result.data;}
/** Historical raw-bound metadata; current reads additionally require matching current manifests. */
export class MimeProjectionStore{
 private readonly ownerId:string;
 constructor(private readonly database:MailDatabase,ownerId:string){this.ownerId=parse(id,ownerId);}
 private account(accountId:string):void{if(!this.database.get("SELECT id FROM mail_accounts WHERE id=? AND owner_id=?",[parse(id,accountId),this.ownerId]))throw new MimeProjectionStorageError("not_found");}
 assertRaw(accountId:string,locator:ProviderMessageLocator,rawRefId:string):void{safe(()=>{
  this.account(accountId);parse(id,rawRefId);
  if(!this.database.get(`SELECT 1 AS found FROM mail_content_manifests m JOIN mail_blob_publications p ON p.account_id=m.account_id AND p.ref_id=m.ref_id
    WHERE m.account_id=? AND m.message_key=? AND m.kind='raw' AND m.state='stored' AND m.ref_id=?`,[accountId,providerMessageKey(locator),rawRefId]))throw new MimeProjectionStorageError("stale_raw");
 });}
 private assertPart(accountId:string,key:string,kind:"body"|"attachment",partId:string,reference:MailContentReference):void{
  if(!this.database.get(`SELECT 1 AS found FROM mail_content_manifests m JOIN mail_content_refs r ON r.account_id=m.account_id AND r.id=m.ref_id
    JOIN mail_blob_publications p ON p.account_id=r.account_id AND p.ref_id=r.id
    WHERE m.account_id=? AND m.message_key=? AND m.kind=? AND m.part_id=? AND m.state='stored' AND r.id=? AND r.bytes=? AND r.sha256=?`,[accountId,key,kind,partId,reference.id,reference.bytes,reference.sha256]))throw new MimeProjectionStorageError("storage_unavailable");
 }
 complete(accountId:string,locator:ProviderMessageLocator,rawRefId:string,supplied:StoredMimeProjection):void{safe(()=>this.database.transaction(()=>{
  this.assertRaw(accountId,locator,rawRefId);const value=parse(projectionSchema,supplied),key=providerMessageKey(locator);
  if(new Set(value.attachments.map(part=>part.partId)).size!==value.attachments.length)throw new MimeProjectionStorageError("invalid_input");
  this.assertPart(accountId,key,"body","",value.body);for(const part of value.attachments)this.assertPart(accountId,key,"attachment",part.partId,part.reference);
  this.database.run(`INSERT INTO mail_mime_projections(account_id,message_key,raw_ref_id,state,metadata_json,body_ref_id,error) VALUES(?,?,?,'complete',?,?,NULL)
    ON CONFLICT(account_id,message_key,raw_ref_id) DO UPDATE SET state='complete',metadata_json=excluded.metadata_json,body_ref_id=excluded.body_ref_id,error=NULL`,[accountId,key,rawRefId,JSON.stringify({metadata:value.metadata,bodies:value.bodies}),value.body.id]);
  this.database.run("DELETE FROM mail_mime_parts WHERE account_id=? AND message_key=? AND raw_ref_id=?",[accountId,key,rawRefId]);
  for(const {reference,...metadata} of value.attachments)this.database.run("INSERT INTO mail_mime_parts(account_id,message_key,raw_ref_id,part_id,metadata_json,content_ref_id) VALUES(?,?,?,?,?,?)",[accountId,key,rawRefId,metadata.partId,JSON.stringify(metadata),reference.id]);
  // Projection is an exact current attachment inventory; retain blobs/history, discard obsolete associations.
  const keep=new Set(value.attachments.map(part=>part.partId));
  for(const row of this.database.all("SELECT part_id FROM mail_content_manifests WHERE account_id=? AND message_key=? AND kind='attachment'",[accountId,key])){
   const partId=parse(id,row.part_id);if(!keep.has(partId))this.database.run("DELETE FROM mail_content_manifests WHERE account_id=? AND message_key=? AND kind='attachment' AND part_id=?",[accountId,key,partId]);
  }
  this.database.run("UPDATE mail_messages SET attachments_enumerated=1 WHERE account_id=? AND message_key=?",[accountId,key]);
 }));}
 error(accountId:string,locator:ProviderMessageLocator,rawRefId:string,code:z.infer<typeof mimeErrorSchema>):void{safe(()=>this.database.transaction(()=>{
  this.assertRaw(accountId,locator,rawRefId);const key=providerMessageKey(locator);parse(mimeErrorSchema,code);
  this.database.run(`INSERT INTO mail_mime_projections(account_id,message_key,raw_ref_id,state,metadata_json,body_ref_id,error) VALUES(?,?,?,'error',NULL,NULL,?)
    ON CONFLICT(account_id,message_key,raw_ref_id) DO UPDATE SET state='error',metadata_json=NULL,body_ref_id=NULL,error=excluded.error`,[accountId,key,rawRefId,code]);
  this.database.run("UPDATE mail_messages SET attachments_enumerated=0 WHERE account_id=? AND message_key=?",[accountId,key]);
 }));}
 read(accountId:string,locator:ProviderMessageLocator){return safe(()=>{
  this.account(accountId);const key=providerMessageKey(locator);
  const row=this.database.get(`SELECT p.* FROM mail_mime_projections p JOIN mail_content_manifests m ON m.account_id=p.account_id AND m.message_key=p.message_key AND m.ref_id=p.raw_ref_id
    WHERE p.account_id=? AND p.message_key=? AND m.kind='raw' AND m.state='stored'`,[accountId,key]);
  if(!row)return null;const rawReferenceId=parse(id,row.raw_ref_id);
  if(row.state==="error")return{state:"error",rawReferenceId,error:parse(mimeErrorSchema,row.error)};
  if(row.state!=="complete"||typeof row.metadata_json!=="string")throw new MimeProjectionStorageError("storage_unavailable");
  const metadata=parse(z.object({metadata:mimeMetadataSchema,bodies:z.array(bodySchema).max(1000)}).strict(),JSON.parse(row.metadata_json));
  const reference=(value:unknown):MailContentReference=>{const ref=this.database.get("SELECT id,bytes,sha256 FROM mail_content_refs WHERE account_id=? AND id=?",[accountId,parse(id,value)]);return parse(referenceSchema,ref);};
  if(!this.database.get("SELECT 1 AS found FROM mail_content_manifests WHERE account_id=? AND message_key=? AND kind='body' AND state='stored' AND ref_id=?",[accountId,key,parse(id,row.body_ref_id)]))return{state:"incomplete",rawReferenceId};
  const body=reference(row.body_ref_id);this.assertPart(accountId,key,"body","",body);
  const attachments=this.database.all("SELECT metadata_json,content_ref_id FROM mail_mime_parts WHERE account_id=? AND message_key=? AND raw_ref_id=? ORDER BY part_id",[accountId,key,rawReferenceId]).map(part=>{
   if(typeof part.metadata_json!=="string")throw new MimeProjectionStorageError("storage_unavailable");const value=parse(partSchema,{...JSON.parse(part.metadata_json),reference:reference(part.content_ref_id)});this.assertPart(accountId,key,"attachment",value.partId,value.reference);return value;
  });
  return{state:"complete",rawReferenceId,...metadata,body,attachments};
 });}
}
