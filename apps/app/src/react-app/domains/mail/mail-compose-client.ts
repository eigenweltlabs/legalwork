import {DraftRecoveryJournal,type DraftRecovery} from './mail-draft-recovery';
import { mailDraftViewSchema, mailDraftPageSchema, mailDraftAttachmentViewSchema, mailUploadViewSchema, type MailDraftView, type MailDraftSave } from '../../../../../server/src/mail/local-view';
import { MailClient } from './mail-client';
export const draftRead=(client:MailClient,account:string,id:string,signal:AbortSignal=new AbortController().signal)=>client.request(`/accounts/${encodeURIComponent(account)}/drafts/read`,mailDraftViewSchema,signal,{draftId:id});
export const draftPage=(client:MailClient,account:string,after?:string)=>client.request(`/accounts/${encodeURIComponent(account)}/drafts/query`,mailDraftPageSchema,new AbortController().signal,{limit:25,...(after?{after}:{})});
/** Serial CAS queue survives component navigation; never writes plaintext browser storage. */
export class ComposeSaveQueue {
 recoveryError=''; recovered=false; private journal:DraftRecoveryJournal;private journalWrite:ReturnType<DraftRecoveryJournal['write']>|undefined;
 version:MailDraftView['version']|null; pending:MailDraftSave['content']|undefined; running:Promise<void>|undefined; error='';
 constructor(private client:MailClient,readonly account:string,readonly id:string,version:MailDraftView['version']|null,private changed:()=>void,recovery?:Pick<DraftRecovery,'id'|'revision'>){this.version=version;this.journal=new DraftRecoveryJournal(account,id,recovery);}
 save(content:MailDraftSave['content']){this.pending=structuredClone(content);this.error='';this.recovered=false;this.recoveryError='';const journal=this.journal.write(this.pending,this.version);this.journalWrite=journal;void journal.then(token=>{if(this.journalWrite!==journal)return;this.recovered=!!token;this.changed();},()=>{if(this.journalWrite!==journal)return;this.recoveryError='Device recovery could not be saved. Keep this draft open until local saving succeeds.';this.changed();});if(!this.running){this.running=this.flush().finally(()=>{this.running=undefined;this.changed();if(this.pending&&!this.error)void this.save(this.pending);});}this.changed();return this.running;}
 private async flush(){while(this.pending){const content=this.pending,journal=this.journalWrite;this.pending=undefined;try{const token=await journal?.catch(()=>null);const saved=await this.client.request(`/accounts/${encodeURIComponent(this.account)}/drafts/save`,mailDraftViewSchema,new AbortController().signal,{draftId:this.id,expected:this.version,content});this.version=saved.version;await this.journal.acknowledge(token??null).catch(()=>{});this.recoveryError='';}catch(error){this.pending=this.pending??content;this.error=error instanceof Error?(error.message.includes('(409)')?'This draft changed elsewhere. Save a copy to keep your edits.':error.message):'Draft could not be saved.';break;}this.changed();}}
}
export async function uploadComposeFile(client:MailClient,account:string,file:File):Promise<MailDraftView['content']['attachments'][number]>{
 if(file.size>10*1024*1024)throw Error('Each attachment must be 10 MiB or smaller.');
 const bytes=new Uint8Array(await file.arrayBuffer()),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join(''),uploadId=crypto.randomUUID();let offset=0;
 const input={uploadId,totalBytes:bytes.length,sha256};
 try{do{const chunk=bytes.subarray(offset,offset+16384);let binary='';for(const byte of chunk)binary+=String.fromCharCode(byte);const complete=offset+chunk.length===bytes.length;
 const result=await client.request(`/accounts/${encodeURIComponent(account)}/drafts/upload`,mailUploadViewSchema,new AbortController().signal,{...input,offset,data:btoa(binary),complete});
 if(result.uploadId!==uploadId||result.nextOffset!==offset+chunk.length||result.bytes!==result.nextOffset)throw Error('Attachment upload did not match the file.');offset=result.nextOffset;
 if(complete){if(result.referenceId!==`draft:sha256:${sha256}`)throw Error('Attachment verification failed.');return{locator:null,bytes:file.size,partId:uploadId,referenceId:result.referenceId,filename:file.name.replace(/[\r\n]/g,' ').slice(0,512)||'attachment',contentType:file.type||'application/octet-stream',disposition:'attachment',contentId:null};}
 }while(offset<bytes.length);throw Error('Attachment upload was interrupted.');}
 catch(error){await client.request(`/accounts/${encodeURIComponent(account)}/drafts/upload`,mailUploadViewSchema,new AbortController().signal,{...input,offset:0,data:'',complete:false,cancel:true}).catch(()=>{});throw error;}
}

export async function composeAttachmentBytes(client:MailClient,account:string,draftId:string,version:MailDraftView['version'],ordinal:number,referenceId:string):Promise<Uint8Array<ArrayBuffer>>{
 let offset=0,output:Uint8Array<ArrayBuffer>|undefined,hash='';
 do{const value=await client.request(`/accounts/${encodeURIComponent(account)}/drafts/attachment`,mailDraftAttachmentViewSchema,new AbortController().signal,{draftId,version,ordinal,referenceId,offset,limit:24576}),chunk=value.chunk;
  if(value.draftId!==draftId||value.version.generation!==version.generation||value.version.revision!==version.revision||value.ordinal!==ordinal||chunk.accountId!==account||chunk.referenceId!==referenceId||chunk.offset!==offset||chunk.totalBytes>10*1024*1024)throw Error('Draft attachment changed.');
  if(!output){output=new Uint8Array(chunk.totalBytes);hash=chunk.sha256;}if(chunk.totalBytes!==output.length||chunk.sha256!==hash)throw Error('Draft attachment changed.');const bytes=Uint8Array.from(atob(chunk.data),char=>char.charCodeAt(0));output.set(bytes,offset);offset+=bytes.length;if(chunk.nextOffset===null)break;
 }while(true);
 if(!output||offset!==output.length||Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',output)),byte=>byte.toString(16).padStart(2,'0')).join('')!==hash)throw Error('Draft attachment integrity check failed.');return output;
}
