import {realpath} from 'node:fs/promises';
import {z} from 'zod';
import {agentGrantCreateSchema,type AgentGrant} from '../mail/agent-view.js';
import {MailAgentCoordinator,agentInvocationSchema,agentDenied} from '../mail/agent-coordinator.js';
import {provisionMailCapability} from '../mail/agent-capabilities.js';
import {MailFilingCoordinator,type FilingBinding} from '../mail/filing-coordinator.js';
import type {MailService} from '../mail/service-interface.js';
import {addRoute,type Route} from './registry.js';
import {isMailLoopback,readMailBody} from './mail.js';
const control=z.discriminatedUnion('action',[
 z.object({action:z.literal('matters'),workspaceId:z.string().min(1).max(4096),offset:z.number().int().nonnegative().default(0)}).strict(),
 z.object({action:z.literal('list')}).strict(),z.object({action:z.literal('create'),input:agentGrantCreateSchema}).strict(),
 z.object({action:z.literal('revoke'),id:z.string().uuid()}).strict(),
 z.object({action:z.literal('review'),id:z.string().uuid()}).strict(),
 z.object({action:z.literal('decide'),id:z.string().uuid(),approve:z.boolean()}).strict(),
]);
export function registerMailAgentRoutes(options:{routes:Route[];host:string;mail?:MailService;capabilityRoot:string;workspaces:()=>Array<{id:string;name:string}>;directory:(id:string)=>Promise<string>;binding:(id:string)=>Promise<FilingBinding>;session:(grant:AgentGrant,id:string,messageId:string)=>Promise<void>}){
 const {mail}=options;if(!mail||!isMailLoopback(options.host))return;
 const coordinator=new MailAgentCoordinator(mail,options.binding,options.session);
 addRoute(options.routes,'POST','/mail/agent/v1/invoke','none',async ctx=>{
  try{
   if(ctx.request.headers.has('origin'))throw agentDenied();
   const token=/^Bearer ([a-f0-9]{64})$/.exec(ctx.request.headers.get('authorization')??'')?.[1];if(!token)throw agentDenied();
   const input=agentInvocationSchema.parse(JSON.parse(await readMailBody(ctx.request,30000)));
   const result=await coordinator.invoke(token,input,ctx.request.signal);return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch{throw agentDenied();}
 });
 addRoute(options.routes,'POST','/mail/v1/agent-access','host-token',async ctx=>{
  if(ctx.actor?.type!=='host')throw agentDenied();
  try{
   const input=control.parse(JSON.parse(await readMailBody(ctx.request,30000)));let result:unknown;
   if(input.action==='matters'){await options.directory(input.workspaceId);result=await new MailFilingCoordinator(mail).destinations(()=>options.binding(input.workspaceId),input.offset);}
   else if(input.action==='list')result={...(await mail.agentControl({action:'list'})),...(await mail.agentControl({action:'proposals'})),workspaces:options.workspaces()};
   else if(input.action==='create'){
    const directory=await realpath(await options.directory(input.input.workspaceId));
    if(input.input.matterId){const binding=await options.binding(input.input.workspaceId);if(!binding)throw agentDenied();}
    const created=await mail.agentControl({action:'create',input:input.input,directory});if(!created.grant||!created.token)throw agentDenied();
    try{await provisionMailCapability(options.capabilityRoot,directory,{id:created.grant.id,token:created.token},async()=>(await mail.agentControl({action:'list'})).grants?.filter(grant=>grant.state==='active'&&grant.expiresAt>Date.now()).map(grant=>grant.id)??[]);}catch{await mail.agentControl({action:'revoke',id:created.grant.id});throw agentDenied();}
    result={grant:created.grant};
   }else if(input.action==='revoke'){const before=await mail.agentControl({action:'list'}),grant=before.grants?.find(value=>value.id===input.id);result=await mail.agentControl(input);if(grant)await provisionMailCapability(options.capabilityRoot,grant.directory,null,async()=>(await mail.agentControl({action:'list'})).grants?.filter(value=>value.state==='active'&&value.expiresAt>Date.now()).map(value=>value.id)??[]);}
   else result=await coordinator.review(input.id,input.action==='decide'?input.approve:undefined,ctx.request.signal);
   return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch{throw agentDenied();}
 });
}
