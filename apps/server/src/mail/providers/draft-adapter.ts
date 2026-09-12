import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {DraftRemoteRef} from '../draft-sync-view.js';
export type RemoteDraft={ref:DraftRemoteRef;raw:Uint8Array;hash:string};
export interface DraftAdapter{readonly replaceMode:'in_place'|'copy_then_delete';read(ref:DraftRemoteRef,signal:AbortSignal):Promise<RemoteDraft|null>;find(messageId:string,signal:AbortSignal):Promise<RemoteDraft[]>;create(raw:Uint8Array,signal:AbortSignal):Promise<RemoteDraft>;replace(ref:DraftRemoteRef,raw:Uint8Array,signal:AbortSignal):Promise<RemoteDraft>;remove(ref:DraftRemoteRef,signal:AbortSignal):Promise<void>;close?():void;}
export class DraftProviderError extends Error{constructor(readonly code:'permission'|'unsupported'|'retryable'|'provider_rejected'|'remote_changed'){super('mail_draft_provider_'+code);}}
const identifier=z.string().min(1).max(4096),record=z.record(z.string(),z.unknown()),MAX=42*1024*1024;
const hash=(raw:Uint8Array)=>createHash('sha256').update(raw).digest('hex');
function decode(value:unknown){const encoded=z.string().max(MAX).regex(/^[A-Za-z0-9_-]+={0,2}$/).parse(value),raw=Buffer.from(encoded,'base64url');if(raw.length>30*1024*1024)throw new DraftProviderError('unsupported');return raw;}
async function bounded(response:Response){if(!response.body)return Buffer.alloc(0);const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>MAX)throw new DraftProviderError('unsupported');chunks.push(next.value);}return Buffer.concat(chunks);}finally{await reader.cancel().catch(()=>{});}}
export class HttpDraftAdapter implements DraftAdapter{
 readonly replaceMode:'in_place'|'copy_then_delete';
 private readonly base:string;
 constructor(private provider:'gmail'|'graph',private accessToken:string,graphPath='/me',private transport:typeof fetch=fetch,private beforeMutation:()=>void=()=>{}){if(!/^\/(me|users\/[^/?#]+)$/.test(graphPath)||!accessToken||/[\r\n]/.test(accessToken))throw new DraftProviderError('permission');this.replaceMode=provider==='gmail'?'in_place':'copy_then_delete';this.base=provider==='gmail'?'https://gmail.googleapis.com/gmail/v1/users/me':'https://graph.microsoft.com/v1.0'+graphPath;}
 private async call(path:string,signal:AbortSignal,method='GET',body?:unknown,headers:Record<string,string>={}){if(method!=='GET')this.beforeMutation();const response=await this.transport(this.base+path,{method,headers:{Authorization:'Bearer '+this.accessToken,Prefer:'IdType="ImmutableId"',...(body===undefined?{}:{'Content-Type':typeof body==='string'?'text/plain':'application/json'}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});if(response.status===404)return null;if(!response.ok){await response.body?.cancel().catch(()=>{});throw new DraftProviderError(response.status===412?'remote_changed':[401,403].includes(response.status)?'permission':response.status===429||response.status>=500?'retryable':'provider_rejected');}const bytes=await bounded(response);return{bytes,etag:response.headers.get('etag')};}
 close(){this.accessToken='';}
 private json(bytes:Uint8Array){return record.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));}
 async read(ref:DraftRemoteRef,signal:AbortSignal):Promise<RemoteDraft|null>{
  if(this.provider==='gmail'){const value=await this.call('/drafts/'+encodeURIComponent(ref.id)+'?format=raw',signal);if(!value)return null;const draft=this.json(value.bytes),message=record.parse(draft.message),raw=decode(message.raw);return{ref:{id:identifier.parse(draft.id),version:identifier.parse(message.id)+':'+String(message.historyId??''),messageId:identifier.parse(message.id),folder:null,uidValidity:null},raw,hash:hash(raw)};}
  const path='/messages/'+encodeURIComponent(ref.id),metadata=await this.call(path+'?$select=id,isDraft,changeKey,internetMessageId',signal);if(!metadata)return null;const message=this.json(metadata.bytes);if(message.isDraft!==true)return null;const content=await this.call(path+'/$value',signal);if(!content)return null;if(content.bytes.length>30*1024*1024)throw new DraftProviderError('unsupported');return{ref:{id:identifier.parse(message.id),version:identifier.parse(metadata.etag??message['@odata.etag']??message.changeKey),messageId:typeof message.internetMessageId==='string'?message.internetMessageId:null,folder:null,uidValidity:null},raw:content.bytes,hash:hash(content.bytes)};
 }
 async find(messageId:string,signal:AbortSignal){const found:RemoteDraft[]=[];let next:string|undefined;for(let page=0;page<20;page++){
  const path=this.provider==='gmail'?'/drafts?maxResults=100&q='+encodeURIComponent('rfc822msgid:'+messageId)+(next?'&pageToken='+encodeURIComponent(next):''):next??'/mailFolders/drafts/messages?$top=100&$select=id&$filter='+encodeURIComponent("internetMessageId eq '"+messageId.replaceAll("'","''")+"'");const response=await this.call(path,signal);if(!response)return found;const data=this.json(response.bytes),items=z.array(z.object({id:identifier})).max(100).parse(this.provider==='gmail'?data.drafts??[]:data.value);
  for(const item of items){const draft=await this.read({id:item.id,version:'unknown',messageId:null,folder:null,uidValidity:null},signal);if(draft&&Buffer.from(draft.raw).toString('latin1').split(/\r?\n\r?\n/,1)[0].match(/^Message-ID:[ \t]*(.+)$/im)?.[1].trim()===messageId)found.push(draft);}
  if(this.provider==='gmail')next=typeof data.nextPageToken==='string'?data.nextPageToken:undefined;else if(typeof data['@odata.nextLink']==='string'){const url=data['@odata.nextLink'];if(!url.startsWith(this.base+'/mailFolders/drafts/messages?'))throw new DraftProviderError('provider_rejected');next=url.slice(this.base.length);}else next=undefined;if(!next)return found;
 }throw new DraftProviderError('unsupported');}
 async create(raw:Uint8Array,signal:AbortSignal){const response=await this.call(this.provider==='gmail'?'/drafts':'/messages',signal,'POST',this.provider==='gmail'?{message:{raw:Buffer.from(raw).toString('base64url')}}:Buffer.from(raw).toString('base64'));if(!response)throw new DraftProviderError('provider_rejected');const value=this.json(response.bytes),id=identifier.parse(value.id),draft=await this.read({id,version:'unknown',messageId:null,folder:null,uidValidity:null},signal);if(!draft)throw new DraftProviderError('provider_rejected');return draft;}
 async replace(ref:DraftRemoteRef,raw:Uint8Array,signal:AbortSignal){if(this.provider==='gmail'){const response=await this.call('/drafts/'+encodeURIComponent(ref.id),signal,'PUT',{id:ref.id,message:{raw:Buffer.from(raw).toString('base64url')}});if(!response)throw new DraftProviderError('remote_changed');}
  else{
   // Graph cannot replace arbitrary MIME with PATCH. Create the replacement first,
   // then remove only the tracked old draft; the engine persists both identities.
   throw new DraftProviderError('unsupported');
  }
  const draft=await this.read(ref,signal);if(!draft)throw new DraftProviderError('remote_changed');return draft;
 }
 async remove(ref:DraftRemoteRef,signal:AbortSignal){await this.call((this.provider==='gmail'?'/drafts/':'/messages/')+encodeURIComponent(ref.id),signal,'DELETE',undefined,this.provider==='graph'?{'If-Match':ref.version}:{});}
}
