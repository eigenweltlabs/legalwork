import { expect, test } from "bun:test";
import { MailIntegrationProxy } from "./integration-proxy.js";
import { createMailIntegrationFetch } from "./providers/integration-fetch.js";
import { mailIntegrationReference } from "./integration-view.js";
import type { ServerConfig } from "../types.js";
import type { StreamingConnectorRequest, ConnectorRequestOptions } from "../connectors/request.js";
import { ApiError } from "../errors.js";

const config: ServerConfig = { host: "127.0.0.1", port: 12345, token: "fixture", hostToken: "fixture", approval: {mode:"auto", timeoutMs:1000}, corsOrigins:[], workspaces:[], authorizedRoots:[], readOnly:false, startedAt:0, tokenSource:"cli", hostTokenSource:"cli", logFormat:"pretty", logRequests:false };
function fixture() {
  let principal = "owner@example.test", token = "first-token", connected = true, active = true, writes = true, available = true, createdAt = "2026-11-01T00:00:00Z";
  const dispatches: {path:string; options: ConnectorRequestOptions}[] = [], identityTokens: string[] = [];
  const profile = () => ({emailAddress:principal});
  const assertCurrent = () => { if (!connected || !active) throw new ApiError(409,"changed","Changed"); };
  const proxy = new MailIntegrationProxy(config, {
    source: {
      connections: async id => connected && id === "gmail" ? [{id:"connection", createdAt, needsReconnect:false}] : [],
      activated: async () => active, send: async () => {}, organize: async () => {},
    },
    fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      identityTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json(profile());
    }, {preconnect:fetch.preconnect}),
    request: async (_id, _connection, verify) => {
      const response = async (path:string, options:ConnectorRequestOptions = {}) => {
        assertCurrent(); if (!available) throw new ApiError(503,"offline","Offline");
        if (options.method && options.method !== "GET" && !writes) throw new ApiError(403,"readonly","Read only");
        if (verify && !await verify(token)) return new Response(null,{status:401});
        dispatches.push({path, options});
        return path.includes("/profile") ? Response.json(profile()) : new Response("history expired",{status:410, headers:{"retry-after":"3"}});
      };
      const request: StreamingConnectorRequest = Object.assign(async (path:string, options?:ConnectorRequestOptions) => (await response(path,options)).json(), {
        response, assertWrite: async () => { assertCurrent(); if (!writes) throw new ApiError(403,"readonly","Read only"); },
      });
      return request;
    },
  });
  return { proxy, dispatches, identityTokens, principal: (value:string) => {principal=value;token+="-changed";}, connected:(value:boolean)=>{connected=value;}, active:(value:boolean)=>{active=value;}, writes:(value:boolean)=>{writes=value;}, available:(value:boolean)=>{available=value;}, recreated:()=>{createdAt="2026-11-02T00:00:00Z";} };
}
async function client(f: ReturnType<typeof fixture>) {
  const snapshot = await f.proxy.snapshot(), account = snapshot.accounts[0];
  if (!account) throw Error("Missing fixture account");
  const transport = createMailIntegrationFetch(() => snapshot.configuration, Object.assign(async (input:Parameters<typeof fetch>[0], init?:RequestInit) => f.proxy.handle(new Request(input,init)),{preconnect:fetch.preconnect}));
  return { snapshot, account, request:(url="https://gmail.googleapis.com/gmail/v1/users/me/history", method="GET") => transport(url,{method,headers:{Authorization:"Bearer "+mailIntegrationReference(account.accountId)}, ...(method === "GET" ? {} : {body:'{}'})}) };
}

test("routes through the existing connection, preserves provider recovery statuses and never forwards routing credentials", async () => {
  const f=fixture(), c=await client(f), result=await c.request();
  expect(result.status).toBe(410); expect(result.headers.get("retry-after")).toBe("3");
  expect(f.identityTokens).toEqual(["Bearer first-token"]);
  expect(f.dispatches.at(-1)?.options.providerStatus).toBe(true);
  expect(JSON.stringify(f.dispatches)).not.toContain(c.snapshot.configuration.capability);
  expect(JSON.stringify(c.snapshot)).not.toContain("first-token");
  await f.proxy.snapshot(); expect((await c.request()).status).toBe(410); expect(f.identityTokens.length).toBe(1);
  f.proxy.close(); expect((await c.request()).status).toBe(401);
});
test("identity change is checked before a send, and refresh creates a separate mailbox", async () => {
  const f=fixture(), c=await client(f); await c.request(); const before=f.dispatches.length;
  f.principal("different@example.test");
  expect((await c.request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send","POST")).status).toBe(409);
  expect(f.dispatches.length).toBe(before);
  const next=await f.proxy.snapshot(); expect(next.accounts[0]?.accountId).not.toBe(c.account.accountId);
  expect((await c.request()).status).toBe(401);
});
test("disconnect, deactivation, recreated handles and write reductions fence the worker immediately", async () => {
  const changes: ((f:ReturnType<typeof fixture>)=>void)[] = [f=>f.connected(false), f=>f.active(false), f=>f.writes(false)];
  for (const change of changes) {
    const f=fixture(), c=await client(f); const before=f.dispatches.length; change(f);
    expect((await c.request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send","POST")).ok).toBe(false);
    expect(f.dispatches.length).toBe(before);
  }
  const f=fixture(),c=await client(f);f.recreated();expect((await c.request()).status).toBe(401);
});
test("temporary provider outage preserves known metadata; unsupported endpoints and missing capability cannot dispatch", async () => {
  const f=fixture(),c=await client(f);f.available(false);
  expect((await f.proxy.snapshot()).accounts[0]).toEqual(c.account); f.available(true);
  const before=f.dispatches.length;
  for (const url of ["https://attacker.test/", "https://gmail.googleapis.com/calendar/v3/me", "https://graph.microsoft.com/v1.0/me/messages", "https://gmail.googleapis.com/gmail/v1/users/me/messages/id%2felse/send"]) expect((await c.request(url,"POST")).ok).toBe(false);
  expect(f.dispatches.length).toBe(before);
  expect((await f.proxy.handle(new Request("http://127.0.0.1/private",{method:"POST"}))).status).toBe(401);
});
test("fallback preserves a Request body for legacy IMAP-independent HTTP transports", async () => {
  const transport=createMailIntegrationFetch(()=>undefined,Object.assign(async (input:Parameters<typeof fetch>[0],init?:RequestInit)=>new Response(await new Request(input,init).text()),{preconnect:fetch.preconnect}));
  expect(await (await transport(new Request("https://example.test",{method:"POST",body:"retained"}))).text()).toBe("retained");
});
test("ordinary provider requests retain their original arguments and use the current host transport", async () => {
  const transport=createMailIntegrationFetch(()=>undefined),original=globalThis.fetch,calls:unknown[]=[];
  const options={method:'POST',headers:{Authorization:'Bearer legacy-token'},body:'unchanged'};
  globalThis.fetch=Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{calls.push(input,init);return new Response('ok');},original);
  try { expect(await (await transport('https://example.test',options)).text()).toBe('ok');expect(calls).toEqual(['https://example.test',options]); }
  finally { globalThis.fetch=original; }
});
test("Outlook attachment uploads are bound to the issuing account and never receive provider credentials", async () => {
  const uploadUrl="https://outlook.office.com/api/upload?session=signed-fixture", profile={id:"stable-graph-id",mail:"owner@example.test",displayName:"Owner"};
  let connected=true, uploaded=0;
  const proxy=new MailIntegrationProxy(config,{
    source:{connections:async id=>connected&&id==='outlook'?[{id:'graph',createdAt:'2026-11-01',needsReconnect:false}]:[],activated:async()=>true,send:async()=>{},organize:async()=>{}},
    fetch:Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      if(new URL(input instanceof Request?input.url:input).origin==='https://outlook.office.com'){
        expect(new Headers(init?.headers).has('authorization')).toBe(false);expect(await new Response(init?.body).text()).toBe('abc');uploaded++;return new Response(null,{status:201});
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer graph-token');return Response.json(profile);
    },{preconnect:fetch.preconnect}),
    request:async(_id,_connection,verify)=>{
      const response=async(path:string,options:ConnectorRequestOptions={})=>{
        if(verify)expect(await verify('graph-token')).toBe(true);
        if(path.endsWith('/createUploadSession')){expect(options.send).toBe(false);expect(options.organize).toBe(false);return Response.json({uploadUrl,expirationDateTime:new Date(Date.now()+60000).toISOString()},{status:201});}
        return Response.json(profile);
      };
      return Object.assign(async(path:string,options?:ConnectorRequestOptions)=>(await response(path,options)).json(),{response,assertWrite:async()=>{}});
    },
  });
  const snapshot=await proxy.snapshot(),account=snapshot.accounts[0];if(!account)throw Error('Missing Outlook account');
  const transport=createMailIntegrationFetch(()=>snapshot.configuration,Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>proxy.handle(new Request(input,init)),{preconnect:fetch.preconnect}));
  const headers={Authorization:'Bearer '+mailIntegrationReference(account.accountId),'Content-Type':'application/octet-stream','Content-Range':'bytes 0-2/3'};
  expect((await transport(uploadUrl,{method:'PUT',headers,body:'abc'})).status).toBe(403);
  expect((await transport('https://graph.microsoft.com/v1.0/me/messages/draft/attachments/createUploadSession',{method:'POST',headers,body:'{}'})).status).toBe(201);
  expect((await transport(uploadUrl,{method:'PUT',headers,body:'abc'})).status).toBe(201);expect(uploaded).toBe(1);
  expect((await transport('https://graph.microsoft.com/v1.0/me/messages/id/replyAll',{method:'POST',headers,body:'{}'})).status).toBe(403);
  connected=false;expect((await transport(uploadUrl,{method:'PUT',headers,body:'abc'})).status).toBe(401);expect(uploaded).toBe(1);
  proxy.close();
});
