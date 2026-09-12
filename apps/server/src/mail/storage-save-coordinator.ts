import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from '../errors.js';
import {storageRootsViewSchema,storageFolderViewSchema,storageSaveFolder,type StorageSave} from './storage-save-view.js';
import type {MailService} from './service-interface.js';
/** Only a server-owned fixed-loopback transport is supplied; never provider credentials. */
export type ConnectedStorageRequest=(path:string,input?:{method?:string;body?:ReadableStream<Uint8Array>;contentType?:string;signal?:AbortSignal})=>Promise<Response>;
const savedSchema=z.object({ok:z.literal(true),version:z.string().min(1).max(1000)});
export class MailStorageSaveCoordinator {
 private readonly running=new Map<string,{abort:AbortController;done:Promise<void>}>();
 private closed=false;
 private epoch=0;
 private lifecycleAbort=new AbortController();
 private readonly unsubscribe:()=>void;
 constructor(private readonly mail:MailService,private readonly request:ConnectedStorageRequest){this.unsubscribe=mail.onLock?.(()=>this.suspend())??(()=>{});}
 suspend(){this.epoch++;this.lifecycleAbort.abort();this.lifecycleAbort=new AbortController();for(const job of this.running.values())job.abort.abort();}
 async close(){this.closed=true;this.unsubscribe();this.suspend();await Promise.allSettled([...this.running.values()].map(job=>job.done));}
 async cancel(workspaceId:string,accountId:string,id:string){const result=await this.mail.storageSave({action:'read',accountId,id});if(result.action!=='read'||result.save.workspaceId!==workspaceId)throw Error('Save unavailable');this.running.get(id)?.abort.abort();const cancelled=await this.mail.storageSave({action:'cancel',accountId,id});if(cancelled.action!=='cancel')throw Error('Save unavailable');return cancelled.save;}

 private base(workspaceId:string){return '/workspace/'+encodeURIComponent(workspaceId)+'/storage';}
 async roots(workspaceId:string,signal?:AbortSignal){const response=await this.request(this.base(workspaceId)+'/roots',{signal});if(!response.ok)throw new ApiError(409,'mail_storage_unavailable','Connected file storage is unavailable. Configure it in Settings.');return storageRootsViewSchema.parse(await response.json());}
 async folders(workspaceId:string,storageId:string,path:string,cursor?:string){storageSaveFolder(path);const response=await this.request(this.base(workspaceId)+'/'+encodeURIComponent(storageId)+'/children?'+new URLSearchParams({path,...cursor?{cursor}:{}}));if(!response.ok)throw Error('Storage folder unavailable');return storageFolderViewSchema.parse(await response.json());}
 private async current(workspaceId:string,storageId:string,revision:string,signal?:AbortSignal){const root=(await this.roots(workspaceId,signal)).roots.find(root=>root.id===storageId);if(!root?.writable||!root.revision||root.revision!==revision)throw new ApiError(409,'mail_storage_changed','The selected storage connection changed. Choose the destination again.');return root;}
 async save(input:{accountId:string;snapshotId:string;workspaceId:string;storageId:string;rootRevision:string;folderPath:string;selection:number[];fresh?:boolean}){
  const epoch=this.epoch,signal=this.lifecycleAbort.signal,active=()=>{if(this.closed||epoch!==this.epoch||signal.aborted)throw Error('Storage save stopped');};active();
  await this.current(input.workspaceId,input.storageId,input.rootRevision,signal);active();storageSaveFolder(input.folderPath);
  const created=await this.mail.storageSave({...input,action:'create'});if(created.action!=='create')throw Error('Storage save unavailable');
  const save=created.save;try{active();}catch(error){if(save.state==='queued')await this.mail.storageSave({action:'cancel',id:save.id,accountId:save.accountId}).catch(()=>{});throw error;}if(!save.quarantined&&save.state!=='complete'&&save.state!=='cancelled'&&!this.running.has(save.id)){const abort=new AbortController();const done=this.publish(save,abort.signal).finally(()=>this.running.delete(save.id));this.running.set(save.id,{abort,done});}return save;
 }
 private async publish(initial:StorageSave,signal:AbortSignal){let save=initial,ordinal=0;
  const active=()=>{if(signal.aborted||this.closed)throw Error('Save stopped');};
  const partState=async(state:'uploading'|'uncertain'|'saved',version:string|null=null,error:string|null=null)=>{const current=await this.mail.storageSave({action:'read',id:save.id,accountId:save.accountId});if(current.action!=='read')throw Error('Save unavailable');save=current.save;const result=await this.mail.storageSave({action:'part',id:save.id,accountId:save.accountId,revision:save.revision,generation:save.generation,ordinal,state,version,error});if(result.action!=='part')throw Error('Storage save unavailable');save=result.save;};
  try{
   active();const snapshot=await this.mail.filing({action:'snapshot',accountId:save.accountId,snapshotId:save.snapshotId});if(snapshot.action!=='snapshot')throw Error('Snapshot unavailable');
   for(ordinal=0;ordinal<save.parts.length;ordinal++){
    active();const part=save.parts[ordinal];if(part.state==='saved')continue;
    await this.current(save.workspaceId,save.storageId,save.rootRevision,signal);
    active();await partState('uploading');active();
    let offset=0;const digest=createHash('sha256'),manifest=part.partIndex===-1?Buffer.from(JSON.stringify(snapshot.snapshot.manifest)):null;
    const body=new ReadableStream<Uint8Array>({pull:async controller=>{
     try{active();
      // Recheck owner-bound account custody while streaming; the shared route stages
      // the complete body and verifies it before invoking its provider adapter.
      const current=await this.mail.storageSave({action:'read',accountId:save.accountId,id:save.id});if(current.action!=='read'||current.save.currentGeneration!==save.generation||current.save.quarantined||current.save.state==='cancelled')throw Error('Account access changed');
      let bytes:Uint8Array;
      if(manifest){bytes=manifest.subarray(offset,offset+24576);offset+=bytes.length;}else{
       const chunk=await this.mail.filing({action:'chunk',accountId:save.accountId,snapshotId:save.snapshotId,part:part.partIndex,offset,limit:24576});if(chunk.action!=='chunk')throw Error('Snapshot unavailable');bytes=Buffer.from(chunk.data,'base64');if(chunk.nextOffset!==offset+bytes.length)throw Error('Snapshot range differs');offset=chunk.nextOffset;
      }
      digest.update(bytes);if(bytes.length)controller.enqueue(bytes);
      if(offset===part.bytes){if(digest.digest('hex')!==part.sha256)throw Error('Snapshot hash differs');controller.close();}else if(!bytes.length||offset>part.bytes)throw Error('Snapshot size differs');
     }catch(error){controller.error(error);}
    }});
    const path=[save.folderPath,part.path].filter(Boolean).join('/');
    const response=await this.request(this.base(save.workspaceId)+'/'+encodeURIComponent(save.storageId)+'/content?'+new URLSearchParams({path}),{method:'POST',body,contentType:part.mimeType,signal});
    if(!response.ok)throw new ApiError(response.status===409?409:502,'mail_storage_uncertain','Save needs review. Existing files are never overwritten.');
    const accepted=savedSchema.parse(await response.json());
    await partState('saved',accepted.version);
    // Preserve accepted per-file evidence even if a later connection fence changes.
    active();await this.current(save.workspaceId,save.storageId,save.rootRevision,signal);
   }
  }catch{
   if(save.parts[ordinal]?.state!=='saved')try{await partState('uncertain',null,'review_destination');}catch{/* Restart/account fences retain the last durable dispatch state. */}
  }
 }
}
