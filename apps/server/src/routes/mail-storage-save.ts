import {z} from 'zod';
import {ApiError} from '../errors.js';
import {providerMessageLocatorSchema} from '../mail/model.js';
import {MailStorageSaveCoordinator,type ConnectedStorageRequest} from '../mail/storage-save-coordinator.js';
import type {MailService} from '../mail/service-interface.js';
import {addRoute,type Route} from './registry.js';
import {isMailLoopback,readMailBody} from './mail.js';
const id=z.string().min(1).max(4096),uuid=z.string().uuid();
const input=z.discriminatedUnion('action',[
 z.object({action:z.literal('workspaces')}).strict(),
 z.object({action:z.literal('roots'),workspaceId:id}).strict(),
 z.object({action:z.literal('folders'),workspaceId:id,storageId:id,path:z.string().max(2048),cursor:z.string().max(16384).optional()}).strict(),
 z.object({action:z.literal('capture'),workspaceId:id,accountId:id,locator:providerMessageLocatorSchema}).strict(),
 z.object({action:z.literal('snapshot'),workspaceId:id,accountId:id,snapshotId:uuid}).strict(),
 z.object({action:z.literal('chunk'),workspaceId:id,accountId:id,snapshotId:uuid,part:z.number().int().min(0).max(100),offset:z.number().int().nonnegative(),limit:z.number().int().min(1).max(24576)}).strict(),
 z.object({action:z.literal('save'),workspaceId:id,accountId:id,snapshotId:uuid,storageId:id,rootRevision:z.string().min(1).max(4096),folderPath:z.string().max(2048),selection:z.array(z.number().int().min(0).max(100)).min(1).max(101),fresh:z.boolean().optional()}).strict(),
 z.object({action:z.literal('cancel'),workspaceId:id,accountId:id,id:uuid}).strict(),
 z.object({action:z.literal('list'),workspaceId:id,accountIds:z.array(id).min(1).max(100),after:uuid.optional()}).strict(),
]);
export function registerMailStorageSaveRoutes(options:{routes:Route[];host:string;mail?:MailService;workspaces:()=>Array<{id:string;name:string}>;resolveWorkspace:(id:string)=>Promise<void>;request:ConnectedStorageRequest}){
 const {mail}=options;if(!mail||!isMailLoopback(options.host))return;const coordinator=new MailStorageSaveCoordinator(mail,options.request);
 addRoute(options.routes,'POST','/mail/v1/storage-save','host-token',async ctx=>{
  if(ctx.actor?.type!=='host')throw new ApiError(401,'unauthorized','Invalid host token');
  let value:unknown;try{value=JSON.parse(await readMailBody(ctx.request,24000));}catch{throw new ApiError(400,'mail_storage_invalid','Invalid mail save request');}const parsed=input.safeParse(value);if(!parsed.success)throw new ApiError(400,'mail_storage_invalid','Invalid mail save request');const request=parsed.data;
  try{
   if(request.action==='workspaces')return Response.json({items:options.workspaces()},{headers:{'Cache-Control':'no-store'}});
   await options.resolveWorkspace(request.workspaceId);let result:unknown;
   switch(request.action){
    case 'roots':result=await coordinator.roots(request.workspaceId);break;
    case 'folders':result=await coordinator.folders(request.workspaceId,request.storageId,request.path,request.cursor);break;
    case 'capture':result=await mail.filing({action:'capture',accountId:request.accountId,locator:request.locator});break;
    case 'snapshot':result=await mail.filing({action:'snapshot',accountId:request.accountId,snapshotId:request.snapshotId});break;
    case 'chunk':result=await mail.filing({action:'chunk',accountId:request.accountId,snapshotId:request.snapshotId,part:request.part,offset:request.offset,limit:request.limit});break;
    case 'cancel':result={save:await coordinator.cancel(request.workspaceId,request.accountId,request.id)};break;
    case 'save':result={save:await coordinator.save(request)};break;
    case 'list':result=await mail.storageSave(request);break;
   }
   return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(409,'mail_storage_attention','Save needs attention. Check the destination, account access, and existing files before retrying.');}
 });
 return coordinator;
}
