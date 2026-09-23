import {isMailAgentEngineToken} from '../mail/agent-auth.js';
import {z} from 'zod';
import {agentDenied} from '../mail/agent-coordinator.js';
import {mailAccountActionsSchema} from '../mail/account-policy.js';
import {MailAccountAgent,accountAgentInputSchema,type AccountAgentInput} from '../mail/account-agent.js';
import type {MailService} from '../mail/service-interface.js';
import {addRoute,type Route} from './registry.js';
import {isMailLoopback,readMailBody} from './mail.js';
const control=z.discriminatedUnion('action',[
 z.object({action:z.literal('get'),accountId:z.string().min(1).max(4096)}).strict(),
 z.object({action:z.literal('set'),accountId:z.string().min(1).max(4096),expectedRevision:z.number().int().nonnegative(),actions:mailAccountActionsSchema}).strict(),
]);
export function registerMailAgentRoutes(options:{routes:Route[];host:string;agentToken:string;mail?:MailService;session:(input:AccountAgentInput)=>Promise<string>}){
 const {mail}=options;if(!mail||!isMailLoopback(options.host))return;
 const agent=new MailAccountAgent(mail,options.session);
 // Dedicated local engine credential, never an argument supplied by the model.
 addRoute(options.routes,'POST','/mail/agent/v2/invoke','none',async ctx=>{
  if(ctx.request.headers.has('origin')||!isMailAgentEngineToken(ctx.request.headers.get('authorization'),options.agentToken))throw agentDenied();
  const input=accountAgentInputSchema.parse(JSON.parse(await readMailBody(ctx.request,30000)));
  return Response.json(await agent.invoke(input,ctx.request.signal),{headers:{'Cache-Control':'no-store'}});
 });
 addRoute(options.routes,'POST','/mail/v1/agent-policy','host-token',async ctx=>{
  if(ctx.actor?.type!=='host')throw agentDenied();
  const input=control.parse(JSON.parse(await readMailBody(ctx.request,30000)));
  const result=await mail.agentControl(input.action==='get'?{action:'account-policy',accountId:input.accountId}:{action:'set-account-policy',accountId:input.accountId,expectedRevision:input.expectedRevision,actions:input.actions});
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 });
 addRoute(options.routes,'POST','/mail/v1/agent-approvals','host-token',async ctx=>{
  if(ctx.actor?.type!=='host')throw agentDenied();
  const input=z.object({sessionId:z.string().min(1),id:z.string().optional(),allow:z.boolean().optional()}).strict().parse(JSON.parse(await readMailBody(ctx.request,3000)));
  if(input.id){if(input.allow===undefined)throw agentDenied();agent.respond(input.id,input.sessionId,input.allow);}
  return Response.json({items:agent.list(input.sessionId)},{headers:{'Cache-Control':'no-store'}});
 });
}
