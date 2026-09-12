import {z} from 'zod';
import {buildMailMime,type MailComposeContent} from '../mime/compose.js';
import {SubmissionFailure} from './smtp-submit.js';
import type {OutboxResult} from '../outbox-view.js';
const graph='https://graph.microsoft.com/v1.0/me',gmail='https://gmail.googleapis.com/gmail/v1/users/me';
const record=z.record(z.string(),z.unknown()),identifier=z.string().min(1).max(4096),preparation=z.object({draftId:identifier.optional(),ready:z.boolean().default(false),uncertain:z.boolean().default(false)}).strict();
async function json(response:Response){if(!response.body)throw new SubmissionFailure('outcome_unknown');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>1024*1024)throw new SubmissionFailure('outcome_unknown');chunks.push(chunk.value);}return record.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));}finally{void reader.cancel().catch(()=>{});}}
/** Fixed provider hosts only. Upload-session URLs are encrypted state and never renderer values. */
export class HttpSubmission{
 constructor(private readonly provider:'gmail'|'graph',private readonly accessToken:string,private readonly signal:AbortSignal,private readonly fetcher:typeof fetch=fetch){}
 private async request(url:string,method:string,body?:string|Uint8Array,contentType='application/json',accepted=[200]){
  let response:Response;try{response=await this.fetcher(url,{method,redirect:'error',signal:this.signal,headers:{Authorization:'Bearer '+this.accessToken,Accept:'application/json',Prefer:'IdType="ImmutableId"',...(body===undefined?{}:{'Content-Type':contentType})},body:body instanceof Uint8Array?Buffer.from(body):body});}catch{throw new SubmissionFailure('outcome_unknown');}
  if(!accepted.includes(response.status)){void response.body?.cancel().catch(()=>{});throw new SubmissionFailure(response.status===401?'authentication':response.status===403?'permission':response.status===413?'too_large':response.status===429?'retryable':response.status>=400&&response.status<500?'rejected':'outcome_unknown',response.status>=400&&response.status<500&&response.status!==408);}
  return response;
 }
 async prepare(input:{raw:Uint8Array;content:MailComposeContent;messageId:string;previous:unknown;attachment:(part:MailComposeContent['attachments'][number])=>Uint8Array;persist:(value:unknown)=>void;fence:()=>void}){
  if(this.provider!=='graph'||input.raw.byteLength*4/3<=3900000)return null;
  const old=preparation.parse(input.previous??{});if(old.ready&&old.draftId)return old.draftId;if(old.uncertain)throw new SubmissionFailure('preparation_unknown');
  // Large attachment preparation cannot deliver mail. Persist uncertainty before creating a remote draft.
  input.fence();input.persist({uncertain:true});
  try{
   const slim=await buildMailMime({...input.content,attachments:[]},{authorizedSenders:[input.content.from??''],messageId:input.messageId,attachment:async()=>{throw new SubmissionFailure('invalid_message');}});
   const bytes=Buffer.concat([Buffer.from(input.content.bcc.length?'Bcc: '+input.content.bcc.join(', ')+'\r\n':''),slim.raw]);input.fence();const created=await json(await this.request(graph+'/messages','POST',bytes.toString('base64'),'text/plain',[201]));const draftId=identifier.parse(created.id);input.persist({draftId,uncertain:true});
   for(const part of input.content.attachments){input.fence();const data=input.attachment(part);if(data.byteLength<3*1024*1024){await this.request(graph+'/messages/'+encodeURIComponent(draftId)+'/attachments','POST',JSON.stringify({'@odata.type':'#microsoft.graph.fileAttachment',name:part.filename,contentType:part.contentType,contentBytes:Buffer.from(data).toString('base64'),isInline:part.disposition==='inline',...(part.contentId?{contentId:part.contentId}:{})}),'application/json',[201]);continue;}
    if(part.disposition==='inline')throw new SubmissionFailure('large_inline_unsupported');
    const session=await json(await this.request(graph+'/messages/'+encodeURIComponent(draftId)+'/attachments/createUploadSession','POST',JSON.stringify({AttachmentItem:{attachmentType:'file',name:part.filename,size:data.byteLength}}),'application/json',[201]));const upload=identifier.max(32768).parse(session.uploadUrl),url=new URL(upload);
    if(url.protocol!=='https:'||url.hostname!=='outlook.office.com'||url.port||url.username||url.password||url.hash||!url.pathname.startsWith('/api/'))throw new SubmissionFailure('preparation_unknown');
    for(let offset=0;offset<data.byteLength;offset+=2*1024*1024){input.fence();const chunk=data.subarray(offset,Math.min(data.byteLength,offset+2*1024*1024));const response=await this.fetcher(upload,{method:'PUT',redirect:'error',signal:this.signal,headers:{'Content-Type':'application/octet-stream','Content-Length':String(chunk.byteLength),'Content-Range':`bytes ${offset}-${offset+chunk.byteLength-1}/${data.byteLength}`},body:Buffer.from(chunk)});
     const final=offset+chunk.byteLength===data.byteLength;if(response.status!==(final?201:200)){void response.body?.cancel().catch(()=>{});throw new SubmissionFailure('preparation_unknown');}
     if(!final){const value=await json(response);if(!Array.isArray(value.nextExpectedRanges)||value.nextExpectedRanges.length!==1||value.nextExpectedRanges[0]!==String(offset+chunk.byteLength)&&value.nextExpectedRanges[0]!==String(offset+chunk.byteLength)+'-')throw new SubmissionFailure('preparation_unknown');}else void response.body?.cancel().catch(()=>{});
    }
   }
   input.fence();input.persist({draftId,ready:true,uncertain:false});return draftId;
  }catch(error){if(error instanceof SubmissionFailure&&error.code==='large_inline_unsupported')throw error;throw new SubmissionFailure('preparation_unknown');}
 }
 async send(raw:Uint8Array,envelope:{from:string;to:string[]},draftId:string|null):Promise<OutboxResult>{
  if(this.provider==='gmail'){const data=await json(await this.request('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media','POST',raw,'message/rfc822',[200]));return{accepted:envelope.to,rejected:[],providerId:identifier.parse(data.id),sentCopy:'provider',delivery:'unknown',reconciled:false};}
  const response=draftId?await this.request(graph+'/messages/'+encodeURIComponent(draftId)+'/send','POST',undefined,'application/json',[202]):await this.request(graph+'/sendMail','POST',Buffer.from(raw).toString('base64'),'text/plain',[202]);void response.body?.cancel().catch(()=>{});return{accepted:envelope.to,rejected:[],providerId:draftId,sentCopy:'provider',delivery:'unknown',reconciled:false};
 }
 async reconcile(messageId:string,from:string):Promise<OutboxResult|null>{
  if(this.provider==='gmail'){
   const url=new URL(gmail+'/messages');url.searchParams.set('q','in:sent rfc822msgid:'+messageId);url.searchParams.set('maxResults','2');const data=await json(await this.request(url.href,'GET'));if(!Array.isArray(data.messages)||data.messages.length!==1||data.nextPageToken)return null;const id=identifier.parse(record.parse(data.messages[0]).id);
   const message=await json(await this.request(gmail+'/messages/'+encodeURIComponent(id)+'?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From','GET'));const payload=record.parse(message.payload);if(!Array.isArray(message.labelIds)||!message.labelIds.includes('SENT')||!Array.isArray(payload.headers))return null;const headers=z.array(z.object({name:z.string(),value:z.string()})).parse(payload.headers);const actualId=headers.find(value=>value.name.toLowerCase()==='message-id')?.value,actualFrom=headers.find(value=>value.name.toLowerCase()==='from')?.value;if(actualId!==messageId||(actualFrom?.match(/<([^<>]+)>/)?.[1]??actualFrom)?.toLowerCase()!==from.toLowerCase())return null;return{accepted:[],rejected:[],providerId:id,sentCopy:'saved',delivery:'unknown',reconciled:true};
  }
  const url=new URL(graph+'/mailFolders/sentitems/messages');url.searchParams.set('$filter',"internetMessageId eq '"+messageId.replaceAll("'","''")+"'");url.searchParams.set('$select','id,internetMessageId,from,isDraft');url.searchParams.set('$top','2');const data=await json(await this.request(url.href,'GET'));if(!Array.isArray(data.value)||data.value.length!==1||data['@odata.nextLink'])return null;const value=z.object({id:identifier,internetMessageId:z.literal(messageId),isDraft:z.literal(false),from:z.object({emailAddress:z.object({address:z.string()})})}).parse(data.value[0]);if(value.from.emailAddress.address.toLowerCase()!==from.toLowerCase())return null;return{accepted:[],rejected:[],providerId:value.id,sentCopy:'saved',delivery:'unknown',reconciled:true};
 }
}
