import { projectMime, MimeProjectionError } from "../mime/project.js";
import { providerMessageKey, type ProviderMessageLocator } from "../model.js";
import type { MailSyncWork } from "../runtime/sync-executor.js";
import type { MailDatabase } from "./database-interface.js";
import { MailContentStore, MAIL_CONTENT_CHUNK_BYTES, type MailContentReference } from "./content-store.js";
import { MimeProjectionStore, mimeErrorSchema, type StoredMimeProjection } from "./mime-projection-store.js";
import { MailRepository } from "./repository.js";
export interface StoredMimeInput {
  accountId:string; locator:ProviderMessageLocator; reference:MailContentReference; work:MailSyncWork;
  /** Synchronous run-generation and credential fence only; must not reenter the sync journal. */
  assertCurrent:()=>void; signal?:AbortSignal; source?:AsyncIterable<Uint8Array>|Iterable<Uint8Array>;
}
/** Engine-only composition. Raw remains authoritative; final body publication also completes the job. */
export function createStoredMimeProjector({database,ownerId}:{database:MailDatabase;ownerId:string}) {
 const content=new MailContentStore(database,ownerId),projections=new MimeProjectionStore(database,ownerId),repository=new MailRepository(database,ownerId);
 return async function projectStoredGmailRaw(input:StoredMimeInput):Promise<void>{
  if(input.work.job.account_id!==input.accountId||input.work.job.message_key!==providerMessageKey(input.locator)||input.work.job.kind!=="body")throw new MimeProjectionError("invalid_input");
  const signal=input.signal?AbortSignal.any([input.signal,input.work.signal]):input.work.signal;
  const local=()=>{
   if(signal.aborted)throw new MimeProjectionError("cancelled");
   const result:unknown=input.assertCurrent();
   if(result!==null&&(typeof result==="object"||typeof result==="function")&&"then" in result&&typeof result.then==="function")throw new MimeProjectionError("invalid_input");
   projections.assertRaw(input.accountId,input.locator,input.reference.id);
  };
  const current=()=>{local();input.work.assertCurrent();};
  if(Object.prototype.toString.call(input.assertCurrent)==="[object AsyncFunction]")throw new MimeProjectionError("invalid_input");
  current();
  if(input.reference.id!==`sha256:${input.reference.sha256}`)throw new MimeProjectionError("invalid_input");
  const attachments=new Map<string,StoredMimeProjection["attachments"][number]>();
  try{
   database.transaction(()=>{current();repository.setAttachmentsEnumerated(input.accountId,input.locator,false);});
   const projection=await projectMime({source:input.source??content.read(input.accountId,input.reference.id),originalSha256:input.reference.sha256,signal,
    onAttachment:async(part,chunks,attachmentSignal)=>{
     current();if(attachments.has(part.partId))throw new MimeProjectionError("malformed");
     async function* guarded(){for await(const bytes of chunks){if(attachmentSignal.aborted||signal.aborted)throw new MimeProjectionError("cancelled");yield bytes;}}
     const reference=await content.writePart(input.accountId,input.locator,{kind:"attachment",partId:part.partId,maxBytes:32*1024*1024},guarded(),()=>current());
     attachments.set(part.partId,{...part,reference});
    }});
   current();
   const parts=projection.attachments.map(part=>{const found=attachments.get(part.partId);if(!found||found.reference.bytes!==part.bytes||found.reference.sha256!==part.sha256)throw new MimeProjectionError("sink_failed");return found;});
   if(parts.length!==attachments.size)throw new MimeProjectionError("malformed");
   const body=Buffer.from(JSON.stringify({version:1,bodies:projection.bodies}),"utf8");
   if(body.byteLength>32*1024*1024)throw new MimeProjectionError("limit");
   function* chunks(){for(let offset=0;offset<body.byteLength;offset+=MAIL_CONTENT_CHUNK_BYTES)yield body.subarray(offset,offset+MAIL_CONTENT_CHUNK_BYTES);}
   await content.writePart(input.accountId,input.locator,{kind:"body",maxBytes:body.byteLength,expectedBytes:body.byteLength},chunks(),bodyReference=>{
    current();
    input.work.complete(writer=>{
     local();
     const message=repository.readMessage(input.accountId,input.locator);if(!message)throw new MimeProjectionError("sink_failed");
     writer.ingestMessage({locator:input.locator,rfcMessageId:projection.metadata.messageId,subject:projection.metadata.subject??"",threadId:message.thread_id,memberships:message.memberships});
     projections.complete(input.accountId,input.locator,input.reference.id,{metadata:projection.metadata,bodies:projection.bodies.map(({partId,contentType})=>({partId,contentType})),body:bodyReference,attachments:parts});
     local();
    });
   });
  }catch(error){
   // Stale/closed jobs cannot overwrite a newer projection with an error either.
   current();
   const parsed=mimeErrorSchema.safeParse(error instanceof MimeProjectionError?error.code:"sink_failed");
   const code=parsed.success?parsed.data:"sink_failed";
   database.transaction(()=>{current();projections.error(input.accountId,input.locator,input.reference.id,code);});
   throw new MimeProjectionError(code);
  }
 };
}
