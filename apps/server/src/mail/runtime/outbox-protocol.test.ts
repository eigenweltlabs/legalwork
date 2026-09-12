import {test,expect} from 'bun:test';
import {parseParentMessage,parseWorkerMessage,resultMatchesCommand} from './protocol.js';
const parent=(command:unknown)=>parseParentMessage(JSON.stringify({kind:'request',id:'1:1',command}));
const response=(result:unknown)=>parseWorkerMessage(JSON.stringify({kind:'response',id:'1:1',ok:true,result}));
test('outbox and SMTP protocol reject injected credentials and bind account/action responses',()=>{
 const input={host:'smtp.example.com',port:465,username:'self',password:'synthetic',security:'tls',sentCopy:'append'};
 expect(parent({operation:'mail.smtp.configure',accountId:'a',input})).toBeDefined();expect(parent({operation:'mail.smtp.configure',accountId:'a',input:{...input,rejectUnauthorized:false}})).toBeUndefined();expect(parent({operation:'mail.smtp.configure',accountId:'a',input:{...input,security:'plain'}})).toBeUndefined();
 expect(response({smtp:{configured:true,current:true,settings:{host:input.host,port:465,username:'self',security:'tls',sentCopy:'append'}}})).toBeDefined();expect(response({smtp:{configured:true,current:true,settings:input}})).toBeUndefined();expect(response({outboxFailure:'smtp_unconfigured'})).toBeDefined();expect(response({outboxFailure:'synthetic-password'})).toBeUndefined();
 expect(parent({operation:'mail.outbox.action',accountId:'a',input:{actionId:'id',action:'reconcile'}})).toBeDefined();expect(parent({operation:'mail.outbox.action',accountId:'a',input:{actionId:'id',action:'resend'}})).toBeUndefined();expect(resultMatchesCommand({operation:'mail.outbox.list',accountId:'a'},{outbox:[]})).toBe(true);
});
