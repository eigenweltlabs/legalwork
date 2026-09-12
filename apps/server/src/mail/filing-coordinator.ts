import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from '../errors.js';
import {callLegalMemoryTool,type LegalMemoryServer} from '../legalmemory-fetch.js';
import {canonicalFilingJson,filingReceiptSchema,type FilingItem} from './filing-view.js';
import type {MailService} from './service-interface.js';
import type {ProviderMessageLocator} from './model.js';
import type {MailSearchInput} from './search-view.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const destinationPage=z.object({version:z.literal(1),principal_key:z.string().regex(/^[a-f0-9]{64}$/),results:z.array(z.object({id:z.string(),title:z.string(),project_id:z.string()})),next_offset:z.number().int().nonnegative().nullable()});
const progressSchema=z.object({id:z.string().uuid(),state:z.literal('uploading'),offsets:z.array(z.number().int().nonnegative()).max(101)});
const scopesSchema=z.object({receipts:z.array(z.object({id:z.string().uuid(),matter_id:z.string(),project_id:z.string(),manifest_hash:z.string()})).max(200)});
export type FilingBinding={server:LegalMemoryServer;bearer?:string};
export function filingBackendKey(binding:FilingBinding){return hash(canonicalFilingJson({name:binding.server.name,url:binding.server.url}));}
function bindingFence(binding:FilingBinding){return hash(canonicalFilingJson({name:binding.server.name,url:binding.server.url,headers:binding.server.headers??{},bearer:binding.bearer??null}));}
function unavailable(){return new ApiError(409,'mail_filing_attention','Filing needs attention. Check the account and matter access, then retry.');}
/** Host-authorized workspace closure; never accepts a caller credential or principal. */
export class MailFilingCoordinator {
 private readonly running=new Set<string>();
 constructor(private readonly mail:MailService){}
 async destinations(resolve:()=>Promise<FilingBinding>,offset=0){const binding=await resolve();return destinationPage.parse(await callLegalMemoryTool(binding.server,'list_mail_filing_destinations',{offset,limit:100},binding.bearer));}
 private async assertDestination(binding:FilingBinding,matterId:string){
  let offset:number|null=0,principal='';
  for(let pages=0;offset!==null&&pages<100;pages++){
   const page=destinationPage.parse(await callLegalMemoryTool(binding.server,'list_mail_filing_destinations',{offset,limit:100},binding.bearer));
   if(principal&&principal!==page.principal_key)throw unavailable();principal=page.principal_key;
   const matter=page.results.find(item=>item.id===matterId);if(matter)return{principal,matter};offset=page.next_offset;
  }
  throw unavailable();
 }
 async list(workspaceId:string,accountIds:string[],resolve:()=>Promise<FilingBinding>,after?:string){const binding=await resolve();const result=await this.mail.filing({action:'list',workspaceId,accountIds,backendKey:filingBackendKey(binding),after,limit:50});if(result.action!=='list')throw unavailable();return result;}
 async file(workspaceId:string,accountId:string,snapshotId:string,matterId:string,resolve:()=>Promise<FilingBinding>){
  const binding=await resolve(),destination=await this.assertDestination(binding,matterId);
  if(bindingFence(await resolve())!==bindingFence(binding))throw unavailable();
  const created=await this.mail.filing({action:'create',workspaceId,accountId,snapshotId,matterId,backendKey:filingBackendKey(binding),principalKey:destination.principal});
  if(created.action!=='create')throw unavailable();
  const item=created.item;if(item.quarantined)throw unavailable();
  if(!this.running.has(item.id)&&item.state!=='filed'&&item.state!=='cancelled'){
   this.running.add(item.id);
   void this.publish(item,binding,resolve).finally(()=>this.running.delete(item.id));
  }
  return item;
 }
 private async publish(initial:FilingItem,binding:FilingBinding,resolve:()=>Promise<FilingBinding>){
  let item=initial;
  const update=async(state:'uploading'|'uncertain'|'filed',remoteId:string|null=item.remoteId,receipt:ReturnType<typeof filingReceiptSchema.parse>|null=null)=>{
   const result=await this.mail.filing({action:'update',accountId:item.accountId,id:item.id,revision:item.revision,generation:item.generation,state,remoteId,receipt,error:state==='uncertain'?'retry_required':null});
   if(result.action!=='update')throw unavailable();item=result.item;
  };
  const call=async(name:string,args:Record<string,unknown>)=>{
   if(bindingFence(await resolve())!==bindingFence(binding))throw unavailable();
   // This durable preflight checks current account custody/generation before every mutation.
   await update('uploading');
   return callLegalMemoryTool(binding.server,name,args,binding.bearer);
  };
  try{
   const read=await this.mail.filing({action:'snapshot',accountId:item.accountId,snapshotId:item.snapshotId});if(read.action!=='snapshot')throw unavailable();
   const snapshot=read.snapshot;
   const started=await call('begin_mail_filing',{matter_id:item.matterId,replay_key:item.id,manifest:snapshot.manifest});
   const committed=filingReceiptSchema.safeParse(started);
   if(committed.success){await update('filed',committed.data.id,committed.data);return;}
   let progress=progressSchema.parse(started);await update('uploading',progress.id);
   if(progress.offsets.length!==snapshot.manifest.parts.length)throw unavailable();
   for(let part=0;part<snapshot.manifest.parts.length;part++){
    const metadata=snapshot.manifest.parts[part];let offset=progress.offsets[part];
    if(offset===undefined||offset>metadata.size)throw unavailable();
    while(offset<metadata.size){
     const chunks:Buffer[]=[];const start=offset;let bytes=0;
     while(offset<metadata.size&&bytes<256*1024){
      const chunk=await this.mail.filing({action:'chunk',accountId:item.accountId,snapshotId:item.snapshotId,part,offset,limit:Math.min(24576,256*1024-bytes)});
      if(chunk.action!=='chunk'||chunk.nextOffset<=offset)throw unavailable();
      const data=Buffer.from(chunk.data,'base64');if(data.length!==chunk.nextOffset-offset)throw unavailable();chunks.push(data);bytes+=data.length;offset=chunk.nextOffset;
     }
     progress=progressSchema.parse(await call('upload_mail_filing_chunk',{filing_id:progress.id,part,offset:start,data:Buffer.concat(chunks).toString('base64')}));
     if(progress.offsets[part]!==offset)throw unavailable();
    }
   }
   const receipt=filingReceiptSchema.parse(await call('commit_mail_filing',{filing_id:progress.id}));
   await update('filed',receipt.id,receipt);
  }catch{
   // A lost response may have committed remotely. Reuse the durable replay key only
   // after another explicit user request; reconnect and startup never republish.
   try{await update('uncertain');}catch{/* Account/recovery fence retains the original intent for review. */}
  }
 }
 async authorizeSource(workspaceId:string,accountId:string,locator:ProviderMessageLocator,matterId:string,resolve:()=>Promise<FilingBinding>):Promise<void>{
  const binding=await resolve(),backendKey=filingBackendKey(binding);let after:string|undefined;
  do{
   const result=await this.mail.filing({action:'list',accountIds:[accountId],workspaceId,backendKey,locator,after,limit:100});if(result.action!=='list')throw unavailable();
   const group=result.items.filter(item=>item.matterId===matterId&&item.state==='filed'&&item.receipt!==null);
   if(group.length){const scopes=scopesSchema.parse(await callLegalMemoryTool(binding.server,'authorized_mail_filings',{filing_ids:group.map(item=>item.remoteId)},binding.bearer));
    if(scopes.receipts.some(scope=>group.some(item=>item.remoteId===scope.id&&item.matterId===scope.matter_id&&item.receipt?.project_id===scope.project_id&&item.receipt.manifest_hash===scope.manifest_hash))){
     if(bindingFence(await resolve())!==bindingFence(binding))throw unavailable();
     await this.mail.filing({action:'list',accountIds:[accountId],workspaceId,backendKey,locator,limit:1});return;
    }
   }
   after=result.nextCursor??undefined;
  }while(after);
  throw new ApiError(404,'mail_filing_not_found','No currently readable matter association for this mail source.');
 }
 async search(workspaceId:string,accountIds:string[],matterId:string,input:MailSearchInput,resolve:()=>Promise<FilingBinding>){
  const binding=await resolve(),backendKey=filingBackendKey(binding),items:FilingItem[]=[];let after:string|undefined;
  // A complete bounded scope is required before any mail count/snippet is read.
  do{
   const result=await this.mail.filing({action:'list',workspaceId,accountIds,backendKey,after,limit:100});if(result.action!=='list')throw unavailable();
   items.push(...result.items.filter(item=>item.matterId===matterId&&item.state==='filed'&&item.receipt!==null));
   if(items.length>50000)throw new ApiError(409,'mail_filing_scope_limit','This matter exceeds the local scope processing budget. Narrow the selected accounts.');
   after=result.nextCursor??undefined;
  }while(after);
  const scopeBinding={workspaceId,backendKey,generation:bindingFence(binding)};
  const opened=await this.mail.filing({action:'scope-open',accountIds,binding:scopeBinding});if(opened.action!=='scope-open')throw unavailable();
  try{
   for(let offset=0;offset<items.length;offset+=200){
    const group=items.slice(offset,offset+200),scopes=scopesSchema.parse(await callLegalMemoryTool(binding.server,'authorized_mail_filings',{filing_ids:group.map(item=>item.remoteId)},binding.bearer));
    const allowed:string[]=[];
    for(const scope of scopes.receipts){const item=group.find(candidate=>candidate.remoteId===scope.id);if(item?.receipt&&item.matterId===scope.matter_id&&item.receipt.project_id===scope.project_id&&item.receipt.manifest_hash===scope.manifest_hash)allowed.push(item.id);}
    await this.mail.filing({action:'scope-add',scopeId:opened.scopeId,filingIds:allowed});
   }
   if(bindingFence(await resolve())!==bindingFence(binding))throw unavailable();
   const result=await this.mail.filing({action:'search',input:{...input,accountIds},scopeId:opened.scopeId,binding:scopeBinding});if(result.action!=='search')throw unavailable();
   if(bindingFence(await resolve())!==bindingFence(binding))throw unavailable();
   return result.search;
  }finally{await this.mail.filing({action:'scope-drop',scopeId:opened.scopeId}).catch(()=>{});}
 }
}
