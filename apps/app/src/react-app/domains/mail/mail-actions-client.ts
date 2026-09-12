import {z} from 'zod';
import {MailClient,locator} from './mail-client';
import type {MailMutation,MailLocalAction} from '../../../../../server/src/mail/local-view';
const id=z.string();
const change=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('read'),read:z.boolean()}),z.object({kind:z.literal('flags'),add:z.array(id),remove:z.array(id)}),
 z.object({kind:z.literal('move'),destination:id}),z.object({kind:z.literal('copy'),destination:id}),z.object({kind:z.literal('delete')}),
 z.object({kind:z.literal('special'),operation:z.enum(['archive','trash','spam','inbox'])}),
 z.object({kind:z.literal('memberships'),add:z.array(id),remove:z.array(id)}),
 z.object({kind:z.literal('mailbox'),operation:z.enum(['create','rename','delete']),path:id,destination:id.optional()}),
]);
export const actionSchema=z.object({id:z.string().uuid(),kind:z.enum(['mutation','submission']),state:z.enum(['queued','running','dispatching','retry','succeeded','failed','cancelled','uncertain']),
 version:z.object({generation:z.string().uuid(),revision:z.number()}),attempts:z.number(),maxAttempts:z.number(),availableAt:z.number(),cancelRequested:z.boolean(),
 lastError:z.enum(['preflight_retryable','preflight_permanent','lease_expired','outcome_unknown','rejected','conflict','cancelled','reconciled']).nullable(),conflictPolicy:z.enum(['manual','refresh_then_reapply']),
 executionSupported:z.boolean(),credentialCurrent:z.boolean(),providerResult:z.enum(['confirmed','unknown','unsupported','conflict','rejected']).nullable().optional(),mutation:z.object({locator:locator.optional(),precondition:id,change}).nullable().optional(),
}) satisfies z.ZodType<MailLocalAction>;
export const pendingAction=(state:MailLocalAction['state'])=>['queued','running','retry','dispatching'].includes(state);
export type ActionEntry=MailLocalAction&{accountId:string};
export function actionLabel(entry:Pick<MailLocalAction,'mutation'>){const change=entry.mutation?.change;if(!change)return 'Mail action';if(change.kind==='read')return change.read?'Mark read':'Mark unread';if(change.kind==='flags')return change.add.length?'Flag':'Unflag';if(change.kind==='special')return {archive:'Archive',trash:'Move to Trash',spam:'Mark as spam',inbox:'Move to Inbox'}[change.operation];if(change.kind==='mailbox')return `${change.operation==='create'?'Create':change.operation==='rename'?'Rename':'Delete'} folder`;return {move:'Move',copy:'Copy',delete:'Permanently delete',memberships:'Change labels'}[change.kind];}
export function actionStateLabel(entry:MailLocalAction){
 if(entry.state==='uncertain')return 'Outcome unknown. Check this message with your provider before trying again.';
 if(entry.providerResult==='unsupported')return 'This operation is unavailable with this account’s permissions or server capabilities.';
 if(entry.providerResult==='conflict'||entry.lastError==='conflict')return 'The message or folder changed. Refresh and review before trying again.';
 if(entry.state==='failed')return 'The provider rejected this change. Refresh and try again after resolving the account problem.';
 if(!entry.credentialCurrent&&pendingAction(entry.state))return 'Account access changed. Cancel this action and reconnect.';
 return {queued:'Queued · Undo available',retry:'Waiting to retry · Undo available',running:'Preparing',dispatching:'Applying at provider',succeeded:'Applied',cancelled:'Cancelled'}[entry.state];
}
export class MailActionsClient{
 constructor(private readonly client:MailClient){}
 mutate(accountId:string,input:MailMutation,signal:AbortSignal){return this.client.request(`/accounts/${encodeURIComponent(accountId)}/actions/mutation`,actionSchema,signal,input);}
 list(accountId:string,signal:AbortSignal,after?:string){return this.client.request(`/accounts/${encodeURIComponent(accountId)}/actions/query`,z.object({items:z.array(actionSchema),nextCursor:id.nullable()}),signal,{limit:25,pendingOnly:true,...(after?{after}:{})});}
 read(accountId:string,actionId:string,signal:AbortSignal){return this.client.request(`/accounts/${encodeURIComponent(accountId)}/actions/read`,actionSchema,signal,{actionId});}
 cancel(entry:ActionEntry,signal:AbortSignal){return this.client.request(`/accounts/${encodeURIComponent(entry.accountId)}/actions/cancel`,actionSchema,signal,{actionId:entry.id,expected:entry.version});}
}
