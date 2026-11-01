import { expect, test } from "bun:test";
import { createAuthorizedConnectorRequest } from "./request.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
const config: ServerConfig = {host:"127.0.0.1",port:0,token:"fixture",hostToken:"fixture",approval:{mode:"auto",timeoutMs:1000},corsOrigins:[],workspaces:[],authorizedRoots:[],readOnly:false,startedAt:0,tokenSource:"cli",hostTokenSource:"cli",logFormat:"pretty",logRequests:false};
test("host identity verification covers refreshed credentials before dispatch and preserves provider recovery responses",async()=>{
 const original=globalThis.fetch,verified:string[]=[],refreshes:boolean[]=[],dispatched:string[]=[];
 globalThis.fetch=Object.assign(async(_input:Parameters<typeof fetch>[0],init?:RequestInit)=>{dispatched.push(new Headers(init?.headers).get('authorization')??'');return new Response('history expired',{status:410});},{preconnect:original.preconnect});
 try{
  const request=await createAuthorizedConnectorRequest(config,'gmail',{token:async force=>{refreshes.push(force);return force?'renewed':'expired';},assertCurrent:async()=>{},verifyAccess:async token=>{verified.push(token);return token==='renewed';}});
  expect((await request.response('/gmail/v1/users/me/history',{providerStatus:true})).status).toBe(410);
  expect(verified).toEqual(['expired','renewed']);expect(refreshes).toEqual([false,true]);expect(dispatched).toEqual(['Bearer renewed']);
  dispatched.length=0;
  const changed=await createAuthorizedConnectorRequest(config,'gmail',{token:async force=>force?'other-person':'expired',assertCurrent:async()=>{},verifyAccess:async token=>{if(token==='expired')return false;throw new ApiError(409,'identity_changed','Different mailbox');}});
  await expect(changed.response('/gmail/v1/users/me/messages')).rejects.toMatchObject({code:'identity_changed'});expect(dispatched).toEqual([]);
 }finally{globalThis.fetch=original;}
});
