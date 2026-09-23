import {mailReviewDescription} from './account-review.js';
import {z} from 'zod';
import {ApprovalService} from '../approvals.js';
import {agentDenied,agentInvocationSchema,MailAgentCoordinator,type AgentInvocation} from './agent-coordinator.js';
import {agentGrantSchema,agentProposalSchema} from './agent-view.js';
import {mailAccountPolicySchema,mailActionLabels} from './account-policy.js';
import type {MailService} from './service-interface.js';

export const accountAgentInputSchema=z.object({directory:z.string().min(1).max(4096),sessionId:z.string().min(1).max(256),messageId:z.string().min(1).max(256),accountId:z.string().min(1).max(4096).optional(),request:z.union([z.object({tool:z.literal('accounts')}).strict(),agentInvocationSchema.shape.request])}).strict();
export type AccountAgentInput=z.infer<typeof accountAgentInputSchema>;
import {type MailPendingApproval} from './account-policy.js';

/** Mail account policy is authoritative even when the engine or host is in auto mode. */
export class MailAccountAgent {
 private readonly approvals=new ApprovalService({mode:'manual',timeoutMs:15*60_000});
 private readonly pending=new Map<string,MailPendingApproval>();
 private custody=new AbortController();
 private readonly coordinator:MailAgentCoordinator;
 constructor(private readonly mail:MailService,private readonly session:(input:AccountAgentInput)=>Promise<string>){
  this.coordinator=new MailAgentCoordinator(mail,async()=>{throw agentDenied();},async()=>{throw agentDenied();});
  mail.onLock?.(()=>{this.custody.abort();this.custody=new AbortController();});
 }
 list(sessionId:string){return this.approvals.list().flatMap(request=>{const detail=this.pending.get(request.summary);return detail?.sessionId===sessionId?[{...detail,id:request.id}]:[];});}
 respond(id:string,sessionId:string,allow:boolean){if(!this.list(sessionId).some(item=>item.id===id))throw agentDenied();if(!this.approvals.respond(id,allow?'allow':'deny'))throw agentDenied();}
 private async identity(accountId:string){
  let after:string|undefined;
  do{const page=await this.mail.listAccounts({limit:100,after});const account=page.items.find(item=>item.id===accountId);if(account)return account;after=page.nextCursor??undefined;}while(after);
  throw agentDenied();
 }
 async invoke(supplied:AccountAgentInput,signal?:AbortSignal){
  const input=accountAgentInputSchema.parse(supplied),workspaceId=await this.session(input);
  const cancellation=AbortSignal.any([this.custody.signal,...signal?[signal]:[]]);cancellation.throwIfAborted();
  if(input.request.tool==='accounts'){
   const items=[];let after:string|undefined;
   do{const page=await this.mail.listAccounts({limit:100,after});for(const account of page.items){
    const policy=mailAccountPolicySchema.parse((await this.mail.agentControl({action:'account-policy',accountId:account.id})).policy);
    items.push({...account,policy});
   }after=page.nextCursor??undefined;}while(after&&items.length<500);
   cancellation.throwIfAborted();return{accounts:items,nextCursor:after??null};
  }
  if(!input.accountId)throw agentDenied();
  const request=input.request,accountId=input.accountId;
  const permission=request.tool==='scope'?null:request.tool==='body'?'read':request.tool==='parts'?'attachments':request.tool==='content'?request.input.kind==='raw'?'export':request.input.kind==='attachment'?'attachments':'read':request.tool;
  const policy=mailAccountPolicySchema.parse((await this.mail.agentControl({action:'account-policy',accountId})).policy);
  if(permission&&policy.actions[permission]==='deny')throw agentDenied();
  if(!Object.values(policy.actions).some(action=>action!=='deny'))throw agentDenied();
  const grant=agentGrantSchema.parse((await this.mail.agentControl({action:'account-scope',accountId})).grant);
  if(permission&&!grant.permissions.includes(permission))throw agentDenied();
  const invocation:AgentInvocation={sessionId:input.sessionId,messageId:input.messageId,request};
  const identity=await this.identity(accountId);
  const accountLabel=identity.displayName+' · '+identity.provider;
  let proposalId:string|undefined;
  let description=`Account: ${accountLabel}\nAction: ${permission?mailActionLabels[permission]:'View sender identities'}\n\n${JSON.stringify(request,null,2)}`;
  try{
   if(request.tool==='propose_send'||request.tool==='propose_delete'){
    const prepared=await this.coordinator.invokeGrant(grant,invocation,cancellation);
    const proposal=agentProposalSchema.parse(z.object({proposal:agentProposalSchema}).parse(prepared.value).proposal);
    proposalId=proposal.id;
    const review=await this.coordinator.review(proposalId,undefined,cancellation);
    description=mailReviewDescription(accountLabel,z.object({detail:z.unknown()}).parse(review).detail);
   }
   if(permission&&policy.actions[permission]==='ask'){
    const key=crypto.randomUUID();
    this.pending.set(key,{id:key,sessionId:input.sessionId,workspaceId,accountId,accountLabel,action:mailActionLabels[permission],description,createdAt:Date.now()});
    try{const result=await this.approvals.requestApproval({workspaceId,action:'mail',summary:key,paths:[],actor:{type:'host'}},cancellation);if(!result.allowed)throw agentDenied();}
    finally{this.pending.delete(key);}
   }
   cancellation.throwIfAborted();
   // Revalidate both provenance and account policy after the human review.
   if(await this.session(input)!==workspaceId)throw agentDenied();
   const current=mailAccountPolicySchema.parse((await this.mail.agentControl({action:'account-policy',accountId})).policy);
   if(current.revision!==policy.revision)throw agentDenied();
   await this.mail.agentControl({action:'check',id:grant.id,revision:grant.revision,permission:permission??undefined});
   if(request.tool==='scope')return{account:identity,senders:grant.permissions.includes('draft')?await this.mail.senders(accountId):[]};
   if(proposalId){const result=z.object({proposal:agentProposalSchema}).parse(await this.coordinator.review(proposalId,true,cancellation));return{accountId,action:request.tool==='propose_send'?'send':'trash',state:result.proposal.state,actionId:result.proposal.actionId,instruction:'Approval records the action; it does not confirm provider delivery. Never retry an uncertain send automatically.'};}
   return this.coordinator.invokeGrant(grant,invocation,cancellation);
  }catch(error){if(proposalId)await this.coordinator.review(proposalId,false).catch(()=>{});throw error;}
 }
}
