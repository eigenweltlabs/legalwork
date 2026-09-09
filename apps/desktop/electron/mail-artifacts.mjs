import {createHash} from 'node:crypto';
import {mkdtemp,open,rm,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {z} from 'zod';
const id=z.string().min(1).max(4096);
const requestSchema=z.object({accountId:id,locator:z.union([z.object({provider:z.literal('gmail'),messageId:id}).strict(),z.object({provider:z.literal('graph'),messageId:id}).strict(),z.object({provider:z.literal('imap'),mailboxId:id,uidValidity:z.number().int().positive(),uid:z.number().int().positive()}).strict()]),kind:z.enum(['raw','attachment']),partId:z.string().max(4096),referenceId:id,operation:z.enum(['open','save'])}).strict();
const safeName=value=>{const name=value.replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g,'_').replace(/[. ]+$/g,'').slice(0,160);return !name||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)?'mail-'+(name||'attachment.bin'):name;};
/** Renderer supplies only an existing reference; the trusted main process re-reads bytes and metadata. */
export function createMailArtifacts({connection,dialog,shell,privateDirectory}){
  const pending=new Set();const temporary=new Set();
  async function perform(value){
    const input=requestSchema.parse(value);if(pending.size>=2)throw Error('mail_export_busy');
    const abort=new AbortController();pending.add(abort);const timer=setTimeout(()=>abort.abort(),120000);let directory;
    try{
      const info=await connection();if(!info.running||!info.hostToken||!/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(info.baseUrl))throw Error('mail_export_unavailable');
      const base=new URL(info.baseUrl).origin+'/mail/v1/accounts/'+encodeURIComponent(input.accountId)+'/messages/';
      const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'X-LegalWork-Host-Token':info.hostToken,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:abort.signal});if(!response.ok)throw Error('mail_export_unavailable');return response.json();};
      let part,next;let pages=0;
      do{const page=await post('parts',{locator:input.locator,page:{limit:100,...(next?{after:next}:{})}});if(!Array.isArray(page.items))throw Error('mail_export_invalid');part=page.items.find(part=>part.kind===input.kind&&part.partId===input.partId&&part.referenceId===input.referenceId);next=page.nextCursor;if(++pages>20)throw Error('mail_export_limit');}while(!part&&next);
      if(!part?.bytesAvailable||!Number.isSafeInteger(part.bytes)||part.bytes<0||part.bytes>64*1024*1024||!/^sha256:[0-9a-f]{64}$/.test(part.referenceId)||part.sha256!==part.referenceId.slice(7))throw Error('mail_export_unavailable');
      const name=safeName(input.kind==='raw'?'original.eml':typeof part.filename==='string'?part.filename:'attachment.bin');
      if(input.operation==='open'&&!/\.(pdf|txt|csv|png|jpe?g|gif|webp|docx|xlsx|pptx|odt|ods|odp|eml)$/i.test(name))throw Error('mail_open_type_unsupported_save_instead');
      let destination;
      if(input.operation==='save'){const choice=await dialog.showSaveDialog({title:'Save stored mail content',defaultPath:name});if(choice.canceled||!choice.filePath)return {cancelled:true};destination=choice.filePath;}
      directory=await mkdtemp(join(tmpdir(),'legalwork-mail-export-'));await privateDirectory(directory);
      const path=join(directory,name);const file=await open(path,'wx',0o600);const hash=createHash('sha256');let offset=0;
      try{do{const chunk=await post('content',{locator:input.locator,request:{kind:input.kind,partId:input.partId,referenceId:input.referenceId,offset,limit:24576}});if(typeof chunk.data!=='string'||chunk.data.length>32768)throw Error('mail_export_invalid');const bytes=Buffer.from(chunk.data,'base64');if(chunk.accountId!==input.accountId||chunk.referenceId!==input.referenceId||chunk.sha256!==part.sha256||chunk.totalBytes!==part.bytes||chunk.offset!==offset||offset+bytes.length>part.bytes||bytes.toString('base64')!==chunk.data||(!bytes.length&&part.bytes)||chunk.nextOffset!==(offset+bytes.length===part.bytes?null:offset+bytes.length))throw Error('mail_export_invalid');hash.update(bytes);await file.writeFile(bytes);offset+=bytes.length;if(chunk.nextOffset===null)break;}while(offset<part.bytes);await file.sync();}finally{await file.close();}
      if(hash.digest('hex')!==part.sha256)throw Error('mail_export_integrity');
      // A lock, reconnect or changed current reference during the dialog/download fails closed.
      await post('content',{locator:input.locator,request:{kind:input.kind,partId:input.partId,referenceId:input.referenceId,offset:0,limit:1}});
      if(abort.signal.aborted)throw Error('mail_export_cancelled');
      if(destination){await copyFile(path,destination);return {saved:true};}
      const result=await shell.openPath(path);if(result)throw Error('mail_open_failed');temporary.add(directory);directory=undefined;return {opened:true};
    }catch{throw Error('Unable to export this stored item. Unlock or refresh mail; unsupported file types can be saved instead.');}
    finally{clearTimeout(timer);pending.delete(abort);if(directory)await rm(directory,{recursive:true,force:true});}
  }
  async function close(){for(const abort of pending)abort.abort();await Promise.all([...temporary].map(path=>rm(path,{recursive:true,force:true})));temporary.clear();}
  return {perform,close,cancel:()=>{for(const abort of pending)abort.abort();}};
}
