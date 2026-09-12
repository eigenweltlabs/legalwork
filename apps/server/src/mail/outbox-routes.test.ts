import {test,expect} from 'bun:test';
import {registerMailRoutes} from '../routes/mail.js';
import {matchRoute,type Route,type RequestContext} from '../routes/registry.js';
import {LocalMailService} from './service.js';
import {OutboxError} from './outbox-view.js';
// Route-only fixture: unused application services are never invoked by these scoped handlers.
function context(request:Request,params:Record<string,string>):RequestContext{return {request,url:new URL(request.url),params,actor:{type:'host'}} as RequestContext;}
test('outbox routes constrain SMTP inputs and redact provider failures without returning passwords',async()=>{
 const service=new LocalMailService({ownerId:'synthetic',databasePath:'/unused',loadKey:async()=>{throw Error('must not open storage');},executable:{kind:'node',path:process.execPath},entryPoint:'/unused'}),routes:Route[]=[];let writes=0;
 service.configureSmtp=async(account,input)=>{writes++;const{password,...settings}=input;return{configured:true,current:true,settings};};service.queueOutbox=async()=>{throw new OutboxError('sender_unavailable');};registerMailRoutes(routes,'127.0.0.1',service);
 async function post(path:string,body:unknown){const route=matchRoute(routes,'POST',path);if(!route)throw Error('missing route');return route.handler(context(new Request('http://127.0.0.1'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),route.params));}
 const settings={host:'smtp.example.com',port:465,username:'synthetic',password:'synthetic-secret',security:'tls',sentCopy:'append'};const response=await post('/mail/v1/accounts/imap/smtp/configure',settings);expect(JSON.stringify(await response.json())).not.toContain('synthetic-secret');expect(writes).toBe(1);await expect(post('/mail/v1/accounts/imap/smtp/configure',{...settings,rejectUnauthorized:false})).rejects.toMatchObject({status:400});expect(writes).toBe(1);
 await expect(post('/mail/v1/accounts/gmail/outbox/queue',{draftId:'11111111-1111-4111-8111-111111111111',version:{generation:'22222222-2222-4222-8222-222222222222',revision:1},replayKey:'synthetic'})).rejects.toMatchObject({status:409,code:'mail_outbox_sender_unavailable'});
});
