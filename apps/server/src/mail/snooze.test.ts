import { test, expect } from 'bun:test';
import { parseParentMessage, parseWorkerMessage, resultMatchesCommand } from './runtime/protocol.js';
import { registerMailRoutes } from '../routes/mail.js';
import { matchRoute, type Route, type RequestContext } from '../routes/registry.js';
import { LocalMailService } from './service.js';
import { ApprovalService } from '../approvals.js';
import { ReloadEventStore } from '../events.js';
import { TokenService } from '../tokens.js';
import type { ServerConfig } from '../types.js';
import { mailSnoozeSchema } from './snooze-view.js';

const locator={provider:'gmail',messageId:'one'} satisfies import('./model.js').ProviderMessageLocator;
const version={generation:'11111111-1111-4111-8111-111111111111',revision:1};
const time={at:Date.now()+60000,timeZone:'Europe/Berlin'};
const state=mailSnoozeSchema.parse({accountId:'a',locator,version,time,scope:'conversation',count:2,available:true});
test('snooze IPC rejects credentials, owners, arbitrary scope and stale unversioned changes',()=>{
 const parent=(command:unknown)=>parseParentMessage(JSON.stringify({kind:'request',id:'1:1',command}));
 const input={locator,expected:version,time};
 expect(parent({operation:'mail.snooze.set',accountId:'a',input})).toBeDefined();
 for(const extra of [{ownerId:'other'},{scopeKey:'arbitrary'},{accessToken:'secret'}])expect(parent({operation:'mail.snooze.set',accountId:'a',input:{...input,...extra}})).toBeUndefined();
 expect(parent({operation:'mail.snooze.set',accountId:'a',input:{locator,time}})).toBeUndefined();
 expect(parent({operation:'mail.snooze.read',accountId:'a',input:{locator:{provider:'archive',namespace:'archive',entryId:'one'}}})).toBeUndefined();
 expect(parseWorkerMessage(JSON.stringify({kind:'response',id:'1:1',ok:true,result:{snooze:{...state,password:'secret'}}}))).toBeUndefined();
 expect(resultMatchesCommand({operation:'mail.snooze.read',accountId:'a',input:{locator}},{snooze:state})).toBe(true);
 expect(resultMatchesCommand({operation:'mail.snooze.read',accountId:'b',input:{locator}},{snooze:state})).toBe(false);
});

test('snooze routes are local host operations with exact inputs and account scope',async()=>{
 const service=new LocalMailService({ownerId:'fixture',databasePath:'/unused',loadKey:async()=>{throw Error('No worker');},executable:{kind:'node',path:process.execPath},entryPoint:'/unused'});
 const config:ServerConfig={host:'127.0.0.1',port:0,token:'fixture',hostToken:'host',approval:{mode:'auto',timeoutMs:1000},corsOrigins:[],workspaces:[],authorizedRoots:[],readOnly:false,startedAt:0,tokenSource:'cli',hostTokenSource:'cli',logFormat:'pretty',logRequests:false};
 const routes:Route[]=[];let writes=0;
 service.setSnooze=async(account,input)=>{writes++;expect(account).toBe('a');expect(input).toEqual({locator,expected:version,time});return state;};
 registerMailRoutes(routes,'127.0.0.1',service);
 async function post(body:unknown,host=true){
  const path='/mail/v1/accounts/a/messages/snooze/set',route=matchRoute(routes,'POST',path);if(!route)throw Error('Missing route');
  const context:RequestContext={config,approvals:new ApprovalService(config.approval),reloadEvents:new ReloadEventStore(),tokens:new TokenService(config),request:new Request('http://127.0.0.1'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),url:new URL('http://127.0.0.1'+path),params:route.params,...(host?{actor:{type:'host'}}:{})};
  return route.handler(context);
 }
 expect((await post({locator,expected:version,time})).status).toBe(200);
 await expect(post({locator,expected:version,time,ownerId:'other'})).rejects.toMatchObject({status:400});
 await expect(post({locator,expected:version,time},false)).rejects.toMatchObject({status:401});
 expect(writes).toBe(1);const remote:Route[]=[];registerMailRoutes(remote,'0.0.0.0',service);expect(remote).toEqual([]);
});
