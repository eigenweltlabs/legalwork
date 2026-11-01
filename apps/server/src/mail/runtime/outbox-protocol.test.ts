import {mailDraftContentSchema} from '../local-view.js';
import {test,expect} from 'bun:test';
import {parseParentMessage,parseWorkerMessage,resultMatchesCommand} from './protocol.js';
const parent=(command:unknown)=>parseParentMessage(JSON.stringify({kind:'request',id:'1:1',command}));
const response=(result:unknown)=>parseWorkerMessage(JSON.stringify({kind:'response',id:'1:1',ok:true,result}));
test('scheduling stays in bounded account-scoped Outbox commands without caller-supplied dispatch state',()=>{
 const version={generation:'22222222-2222-4222-8222-222222222222',revision:1},schedule={at:Date.now()+60000,timeZone:'Europe/Berlin'};
 const input={draftId:'11111111-1111-4111-8111-111111111111',version,replayKey:'schedule',schedule};
 expect(parent({operation:'mail.outbox.queue',accountId:'a',input})).toBeDefined();
 for(const injected of [{...schedule,dispatched:true},{...schedule,timeZone:'Invalid/Zone'},{...schedule,at:-1}])expect(parent({operation:'mail.outbox.queue',accountId:'a',input:{...input,schedule:injected}})).toBeUndefined();
 expect(parent({operation:'mail.local.action.submission',accountId:'a',input})).toBeUndefined();
 expect(parent({operation:'mail.outbox.reschedule',accountId:'a',input:{actionId:'job',expected:version,time:schedule}})).toBeDefined();
 expect(parent({operation:'mail.outbox.reschedule',accountId:'a',input:{actionId:'job',time:schedule}})).toBeUndefined();
 const item={id:'job',accountId:'a',draftId:input.draftId,version:{...version,revision:2},subject:'Scheduled',from:'self@example.test',state:'queued',attempts:0,createdAt:0,updatedAt:0,error:null,result:null,restored:false,cancellationGuaranteed:true,schedule} satisfies import('../outbox-view.js').OutboxItem;
 const command={operation:'mail.outbox.reschedule',accountId:'a',input:{actionId:'job',expected:version,time:schedule}} satisfies import('./protocol.js').WorkerCommand;
 expect(resultMatchesCommand(command,{outboxItem:item})).toBe(true);
 expect(resultMatchesCommand(command,{outboxItem:{...item,schedule:{...schedule,at:schedule.at+1}}})).toBe(false);
 expect(resultMatchesCommand(command,{outboxItem:{...item,accountId:'other'}})).toBe(false);
});
test('outbox and SMTP protocol reject injected credentials and bind account/action responses',()=>{
 const input={host:'smtp.example.com',port:465,username:'self',password:'synthetic',security:'tls',sentCopy:'append'};
 expect(parent({operation:'mail.smtp.configure',accountId:'a',input})).toBeDefined();expect(parent({operation:'mail.smtp.configure',accountId:'a',input:{...input,rejectUnauthorized:false}})).toBeUndefined();expect(parent({operation:'mail.smtp.configure',accountId:'a',input:{...input,security:'plain'}})).toBeUndefined();
 expect(response({smtp:{configured:true,current:true,settings:{host:input.host,port:465,username:'self',security:'tls',sentCopy:'append'}}})).toBeDefined();expect(response({smtp:{configured:true,current:true,settings:input}})).toBeUndefined();expect(response({outboxFailure:'smtp_unconfigured'})).toBeDefined();expect(response({outboxFailure:'synthetic-password'})).toBeUndefined();
 expect(parent({operation:'mail.outbox.action',accountId:'a',input:{actionId:'id',action:'reconcile'}})).toBeDefined();expect(parent({operation:'mail.outbox.action',accountId:'a',input:{actionId:'id',action:'resend'}})).toBeUndefined();expect(resultMatchesCommand({operation:'mail.outbox.list',accountId:'a'},{outbox:[]})).toBe(true);
});

test('bounded outbox detail accepts only matching account/action identities through the worker protocol',()=>{
 const content=mailDraftContentSchema.parse({to:['client@example.test'],subject:'Full queued message',text:'Full content '.repeat(100)}),command={operation:'mail.outbox.read',accountId:'firm',input:{actionId:'submission'}};
 expect(parent(command)).toBeDefined();expect(response({outboxDetail:{accountId:'firm',actionId:'submission',content}})).toBeDefined();
 expect(resultMatchesCommand({operation:'mail.outbox.read',accountId:'firm',input:{actionId:'submission'}},{outboxDetail:{accountId:'other',actionId:'submission',content}})).toBe(false);
 expect(resultMatchesCommand({operation:'mail.outbox.read',accountId:'firm',input:{actionId:'submission'}},{outboxDetail:{accountId:'firm',actionId:'different',content}})).toBe(false);
});
