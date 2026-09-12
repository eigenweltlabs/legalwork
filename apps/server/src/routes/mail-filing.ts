import {z} from 'zod';
import {ApiError} from '../errors.js';
import {providerMessageLocatorSchema} from '../mail/model.js';
import {mailSearchInputSchema} from '../mail/search-view.js';
import {MailFilingCoordinator,type FilingBinding} from '../mail/filing-coordinator.js';
import type {MailService} from '../mail/service-interface.js';
import {addRoute,type Route} from './registry.js';
import {isMailLoopback,readMailBody} from './mail.js';
const id=z.string().min(1).max(4096),uuid=z.string().uuid();
const input=z.discriminatedUnion('action',[
 z.object({action:z.literal('workspaces')}).strict(),
 z.object({action:z.literal('destinations'),workspaceId:id,offset:z.number().int().nonnegative().default(0)}).strict(),
 z.object({action:z.literal('capture'),workspaceId:id,accountId:id,locator:providerMessageLocatorSchema}).strict(),
 z.object({action:z.literal('file'),workspaceId:id,accountId:id,snapshotId:uuid,matterId:id}).strict(),
 z.object({action:z.literal('list'),workspaceId:id,accountIds:z.array(id).min(1).max(100),after:uuid.optional()}).strict(),
 z.object({action:z.literal('search'),workspaceId:id,accountIds:z.array(id).min(1).max(100),matterId:id,input:mailSearchInputSchema}).strict(),
]);
export function registerMailFilingRoutes(routes:Route[],host:string,mail:MailService|undefined,workspaces:()=>Array<{id:string;name:string}>,resolve:(workspaceId:string)=>Promise<FilingBinding>){
 if(!mail||!isMailLoopback(host))return;
 const coordinator=new MailFilingCoordinator(mail);
 addRoute(routes,'POST','/mail/v1/filing','host-token',async ctx=>{
  if(ctx.actor?.type!=='host')throw new ApiError(401,'unauthorized','Invalid host token');
  let value:unknown;try{value=JSON.parse(await readMailBody(ctx.request,24000));}catch{throw new ApiError(400,'mail_filing_invalid','Invalid filing request');}
  const parsed=input.safeParse(value);if(!parsed.success)throw new ApiError(400,'mail_filing_invalid','Invalid filing request');
  const request=parsed.data;
  try{
   if(request.action==='workspaces')return Response.json({items:workspaces()},{headers:{'Cache-Control':'no-store'}});
   const binding=()=>resolve(request.workspaceId);await binding();
   let result:unknown;
   switch(request.action){
    case 'destinations':result=await coordinator.destinations(binding,request.offset);break;
    case 'capture':result=await mail.filing({action:'capture',accountId:request.accountId,locator:request.locator});break;
    case 'file':result={item:await coordinator.file(request.workspaceId,request.accountId,request.snapshotId,request.matterId,binding)};break;
    case 'list':result=await coordinator.list(request.workspaceId,request.accountIds,binding,request.after);break;
    case 'search':result=await coordinator.search(request.workspaceId,request.accountIds,request.matterId,request.input,binding,ctx.request.signal);break;
   }
   return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(409,'mail_filing_attention','Filing is unavailable. Check the account and matter access, then retry.');}
 });
}
