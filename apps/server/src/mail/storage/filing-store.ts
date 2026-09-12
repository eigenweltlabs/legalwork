import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {filingInputSchema,filingItemSchema,filingSnapshotSchema,filingManifestSchema,canonicalFilingJson,type FilingInput,type FilingResult} from '../filing-view.js';
import {providerMessageKey} from '../model.js';
import {MailServiceError} from '../service-interface.js';
import {MailCredentialRepository} from './credentials.js';
import {MailContentStore} from './content-store.js';
import {MailReadStore} from './read-store.js';
import {MimeProjectionStore} from './mime-projection-store.js';
import {MailSearchStore} from './search.js';
import type {MailDatabase,MailSqlRow} from './database-interface.js';
const text=z.string(),number=z.number().int().nonnegative();
type Scope={ownerId:string;binding:string;expires:number;accounts:string[];generations:string[];ids:Set<string>};
const scopesByDatabase=new WeakMap<MailDatabase,Map<string,Scope>>();
/** Only the trusted host coordinator invokes this typed worker surface. */
export class MailFilingStore {
 constructor(private readonly db:MailDatabase,private readonly ownerId:string){}
 private account(accountId:string){
  const row=this.db.get('SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?',[accountId,this.ownerId]);
  if(!row)throw new MailServiceError('not_found');
  const access=new MailCredentialRepository(this.db,this.ownerId).status(accountId);
  if(row.provider!=='archive'&&(access.state!=='connected'||access.archiveLocked))throw new MailServiceError('locked');
  return access.state==='connected'?access.version.generation:'offline:'+accountId;
 }
 private quarantined(id:string){return !!this.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_recovery_quarantine'")&&!!this.db.get("SELECT 1 FROM mail_recovery_quarantine WHERE kind='filing' AND entity_id=?",[id]);}
 private item(row:MailSqlRow){return filingItemSchema.parse({id:row.id,snapshotId:row.snapshot_id,accountId:row.account_id,workspaceId:row.workspace_id,backendKey:row.backend_key,principalKey:row.principal_key,matterId:row.matter_id,state:row.state,remoteId:row.remote_id,receipt:row.receipt_json===null?null:JSON.parse(text.parse(row.receipt_json)),error:row.error,generation:row.generation,revision:row.revision,quarantined:this.quarantined(text.parse(row.id))});}
 private readItem(accountId:string,id:string){this.account(accountId);const row=this.db.get('SELECT f.*,s.account_id FROM mail_matter_filings f JOIN mail_filing_snapshots s ON s.id=f.snapshot_id WHERE f.id=? AND s.account_id=?',[id,accountId]);if(!row)throw new MailServiceError('not_found');return this.item(row);}
 private snapshot(accountId:string,id:string){this.account(accountId);const row=this.db.get('SELECT * FROM mail_filing_snapshots WHERE id=? AND account_id=?',[id,accountId]);if(!row)throw new MailServiceError('not_found');const serialized=text.parse(row.manifest_json);if(createHash('sha256').update(serialized).digest('hex')!==row.manifest_hash)throw new MailServiceError('unavailable');return filingSnapshotSchema.parse({id,accountId,messageKey:row.source_message_key,manifest:JSON.parse(serialized),manifestHash:row.manifest_hash});}
 execute(supplied:FilingInput):FilingResult{
  const input=filingInputSchema.parse(supplied);
  switch(input.action){
   case 'capture':return this.db.transaction(()=>{
    this.account(input.accountId);
    const read=new MailReadStore(this.db,this.ownerId).read(input.accountId,input.locator);
    const projection=new MimeProjectionStore(this.db,this.ownerId).read(input.accountId,input.locator);
    if(!projection||!('metadata' in projection)||read.removed)throw new MailServiceError('unavailable');
    const original=this.db.get("SELECT r.id,r.bytes,r.sha256 FROM mail_content_refs r WHERE r.account_id=? AND r.id=?",[input.accountId,projection.rawReferenceId]);
    if(!original)throw new MailServiceError('unavailable');
    const components=[{reference:{id:text.parse(original.id),bytes:number.parse(original.bytes),sha256:text.parse(original.sha256)},kind:'original',filename:'Original.eml',contentType:'message/rfc822',contentId:null},...projection.attachments.map(part=>({...part,kind:'attachment',filename:part.filename||'Attachment'}))];
    const headers:Record<string,string[]>={};for(const [key,value] of Object.entries(projection.metadata))if(value!==null)headers[key]=[value];
    const manifest=filingManifestSchema.parse({version:1,source_account:input.accountId,provider:input.locator.provider,locator:input.locator,headers,received_at:read.receivedAt==null?null:new Date(read.receivedAt).toISOString(),captured_at:new Date().toISOString(),parts:components.map(part=>({kind:part.kind,filename:part.filename,mime_type:part.contentType,size:part.reference.bytes,sha256:part.reference.sha256,content_id:part.contentId}))});
    const previous=this.db.get("SELECT id,manifest_json FROM mail_filing_snapshots WHERE account_id=? AND source_message_key=? AND json_extract(manifest_json,'$.parts[0].sha256')=? ORDER BY created_at DESC LIMIT 1",[input.accountId,providerMessageKey(input.locator),manifest.parts[0].sha256]);
    if(previous){const candidate=filingManifestSchema.parse(JSON.parse(text.parse(previous.manifest_json)));const quarantined=this.db.all('SELECT id,generation FROM mail_matter_filings WHERE snapshot_id=?',[text.parse(previous.id)]).some(row=>this.quarantined(text.parse(row.id))||row.generation!==this.account(input.accountId))||this.db.all('SELECT id,generation FROM mail_storage_saves WHERE snapshot_id=?',[text.parse(previous.id)]).some(row=>this.quarantined('storage-save:'+text.parse(row.id))||row.generation!==this.account(input.accountId));if(!quarantined&&canonicalFilingJson({...candidate,captured_at:''})===canonicalFilingJson({...manifest,captured_at:''}))return{action:'capture',snapshot:this.snapshot(input.accountId,text.parse(previous.id))};}
    const serialized=JSON.stringify(manifest);
    if(Buffer.byteLength(serialized)>48000||manifest.parts.reduce((sum,part)=>sum+part.size,0)>96*1024*1024)throw new MailServiceError('too_large');
    // Iterate every original/attachment to verify complete local custody before pinning.
    const content=new MailContentStore(this.db,this.ownerId);for(const part of components)for(const _chunk of content.read(input.accountId,part.reference.id)){/* iterator verifies size/hash */}
    const id=randomUUID(),now=Date.now();this.db.run('INSERT INTO mail_filing_snapshots(id,account_id,source_message_key,manifest_json,manifest_hash,created_at) VALUES(?,?,?,?,?,?)',[id,input.accountId,providerMessageKey(input.locator),serialized,createHash('sha256').update(serialized).digest('hex'),now]);
    components.forEach((part,ordinal)=>this.db.run('INSERT INTO mail_filing_parts(snapshot_id,ordinal,account_id,ref_id,kind,metadata_json,bytes,sha256) VALUES(?,?,?,?,?,?,?,?)',[id,ordinal,input.accountId,part.reference.id,part.kind,JSON.stringify(manifest.parts[ordinal]),part.reference.bytes,part.reference.sha256]));
    return{action:'capture',snapshot:this.snapshot(input.accountId,id)};
   });
   case 'snapshot':return{action:input.action,snapshot:this.snapshot(input.accountId,input.snapshotId)};
   case 'chunk':{
    this.snapshot(input.accountId,input.snapshotId);const part=this.db.get('SELECT ref_id,bytes FROM mail_filing_parts WHERE snapshot_id=? AND ordinal=? AND account_id=?',[input.snapshotId,input.part,input.accountId]);if(!part)throw new MailServiceError('not_found');
    const result=new MailContentStore(this.db,this.ownerId).readRange(input.accountId,text.parse(part.ref_id),input.offset,input.limit);return{action:'chunk',data:result.data,nextOffset:result.nextOffset??result.totalBytes,done:result.nextOffset===null};
   }
   case 'list':{
    for(const id of input.accountIds)this.account(id);
    const rows=this.db.all(`SELECT f.*,s.account_id FROM mail_matter_filings f JOIN mail_filing_snapshots s ON s.id=f.snapshot_id WHERE s.account_id IN (${input.accountIds.map(()=>'?').join(',')}) AND f.workspace_id=? AND f.backend_key=? AND (? IS NULL OR s.source_message_key=?) AND f.id>? ORDER BY f.id LIMIT ?`,[...input.accountIds,input.workspaceId,input.backendKey,input.locator?providerMessageKey(input.locator):null,input.locator?providerMessageKey(input.locator):null,input.after??'',input.limit+1]);
    const items=rows.slice(0,input.limit).map(row=>this.item(row));while(Buffer.byteLength(JSON.stringify(items))>48000&&items.length>1)items.pop();return{action:'list',items,nextCursor:rows.length>items.length?items.at(-1)?.id??null:null};
   }
   case 'create':return this.db.transaction(()=>{
    const generation=this.account(input.accountId);this.snapshot(input.accountId,input.snapshotId);
    const old=this.db.get('SELECT f.*,s.account_id FROM mail_matter_filings f JOIN mail_filing_snapshots s ON s.id=f.snapshot_id WHERE f.snapshot_id=? AND f.workspace_id=? AND f.backend_key=? AND f.principal_key=? AND f.matter_id=?',[input.snapshotId,input.workspaceId,input.backendKey,input.principalKey,input.matterId]);
    if(old){const item=this.item(old);if(item.quarantined)throw new MailServiceError('conflict');return{action:'create',item};}
    const id=randomUUID(),now=Date.now();this.db.run("INSERT INTO mail_matter_filings(id,snapshot_id,workspace_id,backend_key,principal_key,matter_id,state,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)",[id,input.snapshotId,input.workspaceId,input.backendKey,input.principalKey,input.matterId,generation,now,now]);return{action:'create',item:this.readItem(input.accountId,id)};
   });
   case 'update':return this.db.transaction(()=>{
    const old=this.readItem(input.accountId,input.id);if(old.quarantined||old.revision!==input.revision||old.generation!==input.generation||this.account(input.accountId)!==input.generation||old.state==='filed'||old.state==='cancelled')throw new MailServiceError('conflict');
    if(input.state==='filed'){
     const snapshot=this.snapshot(input.accountId,old.snapshotId),receipt=input.receipt;
     if(!receipt||receipt.id!==input.remoteId||receipt.matter_id!==old.matterId||receipt.manifest_hash!==createHash('sha256').update(canonicalFilingJson(snapshot.manifest)).digest('hex')||receipt.parts.length!==snapshot.manifest.parts.length||receipt.parts.some((part,index)=>part.ordinal!==index||part.sha256!==snapshot.manifest.parts[index]?.sha256||part.size!==snapshot.manifest.parts[index]?.size))throw new MailServiceError('invalid_input');
    }else if(input.receipt!==null)throw new MailServiceError('invalid_input');
    this.db.run('UPDATE mail_matter_filings SET state=?,remote_id=?,receipt_json=?,error=?,revision=revision+1,updated_at=? WHERE id=?',[input.state,input.remoteId,input.receipt?JSON.stringify(input.receipt):null,input.error,Date.now(),input.id]);return{action:'update',item:this.readItem(input.accountId,input.id)};
   });
   case 'scope-open':{
    let scopes=scopesByDatabase.get(this.db);if(!scopes){scopes=new Map();scopesByDatabase.set(this.db,scopes);}for(const [key,value] of scopes)if(value.expires<Date.now())scopes.delete(key);
    if(scopes.size>=4)throw new MailServiceError('unavailable');const id=randomUUID();scopes.set(id,{ownerId:this.ownerId,binding:canonicalFilingJson(input.binding),expires:Date.now()+120000,accounts:input.accountIds,generations:input.accountIds.map(id=>this.account(id)),ids:new Set()});return{action:'scope-open',scopeId:id};
   }
   case 'scope-drop':scopesByDatabase.get(this.db)?.delete(input.scopeId);return{action:'scope-drop'};
   case 'scope-add':{
    const scope=scopesByDatabase.get(this.db)?.get(input.scopeId);if(!scope||scope.expires<Date.now())throw new MailServiceError('unavailable');if(scope.ids.size+input.filingIds.length>50000)throw new MailServiceError('too_large');for(const id of input.filingIds)scope.ids.add(id);return{action:'scope-add'};
   }
   case 'search':{
    const scopes=scopesByDatabase.get(this.db),scope=scopes?.get(input.scopeId);scopes?.delete(input.scopeId);
    if(!scope||scope.ownerId!==this.ownerId||scope.binding!==canonicalFilingJson(input.binding)||scope.expires<Date.now()||JSON.stringify(input.input.accountIds)!==JSON.stringify(scope.accounts)||scope.accounts.some((id,index)=>this.account(id)!==scope.generations[index]))throw new MailServiceError('conflict');
    return{action:'search',search:new MailSearchStore(this.db,this.ownerId).search(input.input,{filingIds:[...scope.ids]})};
   }
  }
 }
}
