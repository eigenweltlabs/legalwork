import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {LocalMailService} from './service.js';
import {registerMailAgentRoutes} from '../routes/mail-agent.js';
import {matchRoute,type Route,type RequestContext} from '../routes/registry.js';
import {defaultMailAccountActions,type MailAccountPolicy} from './account-policy.js';
import type {AgentGrant} from './agent-view.js';
const engineToken='a'.repeat(64);

test('account policy applies to every chat; host-only approvals bind exact request, cancel, and recheck policy',async()=>{
 let reads=0;
 let policy:MailAccountPolicy={accountId:'a',revision:1,migrationRequired:false,actions:{...defaultMailAccountActions,read:'ask'}};
 const grant:AgentGrant={id:randomUUID(),accountId:'a',workspaceId:'__account__',directory:'*',matterId:null,permissions:['search','read'],credentialGeneration:'generation',state:'active',createdAt:Date.now(),expiresAt:Number.MAX_SAFE_INTEGER,revision:1};
 const mail=new LocalMailService({ownerId:'synthetic',databasePath:'/unused',loadKey:async()=>{throw Error('No database');},executable:{kind:'node',path:process.execPath},entryPoint:'/unused'});
 mail.agentControl=async input=>{
  if('accountId' in input&&input.accountId!=='a')throw Error('foreign account');
  if(input.action==='account-policy')return{policy};
  if(input.action==='account-scope')return{grant,policy};
  if(input.action==='check'){if(input.revision!==grant.revision)throw Error('changed');return{grant};}
  throw Error('denied');
 };
 mail.listAccounts=async()=>({items:[{id:'a',provider:'gmail',displayName:'Personal mailbox'}],nextCursor:null});
 mail.readMessage=async()=>{reads++;return{accountId:'a',key:'gmail:m',locator:{provider:'gmail',messageId:'m'},subject:'Untrusted email text',threadId:null,rfcMessageId:null,removed:false,memberships:[],contentState:'complete',metadata:null};};
 const routes:Route[]=[];
 registerMailAgentRoutes({routes,host:'127.0.0.1',mail,agentToken:engineToken,session:async input=>{if(!['first','second'].includes(input.sessionId)||input.messageId!=='assistant-message'||input.directory!=='/local')throw Error('foreign session');return'workspace';}});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const url=new URL(request.url),route=matchRoute(routes,request.method,url.pathname);if(!route)return new Response('',{status:404});try{return await route.handler({request,url,params:route.params,actor:request.headers.get('x-test-host')==='yes'?{type:'host'}:undefined} as RequestContext);}catch{return new Response('denied',{status:403});}}});
 const post=(body:unknown,path='/mail/agent/v2/invoke',headers:Record<string,string>={},signal?:AbortSignal)=>fetch(new URL(path,server.url),{method:'POST',headers:{Authorization:'Bearer '+engineToken,'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal});
 const input={directory:'/local',sessionId:'first',messageId:'assistant-message',accountId:'a',request:{tool:'read',locator:{provider:'gmail',messageId:'m'}}};
 const approvals=async(sessionId='first')=>(await (await post({sessionId},'/mail/v1/agent-approvals',{'x-test-host':'yes'})).json()).items;
 const pending=async(sessionId='first')=>{for(let i=0;i<50;i++){const list=await approvals(sessionId);if(list.length)return list[0];await Bun.sleep(2);}throw Error('No approval');};
 const reply=(id:string,sessionId='first')=>post({sessionId,id,allow:true},'/mail/v1/agent-approvals',{'x-test-host':'yes'});
 try{
  expect((await post(input,undefined,{Authorization:'Bearer remote-client'})).status).toBe(403);
  expect((await post(input,undefined,{Origin:'https://untrusted.invalid'})).status).toBe(403);
  for(const bad of [{...input,sessionId:'foreign'},{...input,messageId:'user-message'},{...input,accountId:'foreign'},{...input,request:{...input.request,accountId:'foreign'}}])expect((await post(bad)).status).toBe(403);
  expect((await post({sessionId:'first'},'/mail/v1/agent-approvals')).status).toBe(403);
  expect((await post({},'/mail/agent/v1/invoke')).status).toBe(404);
  const request=post(input);const review=await pending();expect(reads).toBe(0);expect(review.description).toContain('Personal mailbox');expect(await approvals('second')).toEqual([]);
  expect((await reply(review.id,'second')).status).toBe(403);expect((await reply('forged')).status).toBe(403);
  await reply(review.id);expect((await request).status).toBe(200);expect(reads).toBe(1);
  const changed=post({...input,sessionId:'second'});const next=await pending('second');policy={...policy,revision:2,actions:{...policy.actions,read:'deny'}};await reply(next.id,'second');expect((await changed).status).toBe(403);expect(reads).toBe(1);
  for(const sessionId of ['first','second'])expect((await post({...input,sessionId})).status).toBe(403);
  policy={...policy,revision:3,actions:{...policy.actions,read:'allow'}};
  for(const sessionId of ['first','second'])expect((await post({...input,sessionId})).status).toBe(200);
  expect(reads).toBe(3);
  policy={...policy,revision:4,actions:{...policy.actions,read:'ask'}};
  const controller=new AbortController();const cancelled=post(input,undefined,{},controller.signal).catch(()=>null);await pending();controller.abort();await cancelled;
  for(let i=0;i<50&&(await approvals()).length;i++)await Bun.sleep(2);
  expect(await approvals()).toEqual([]);expect(reads).toBe(3);
 }finally{server.stop(true);}
});
