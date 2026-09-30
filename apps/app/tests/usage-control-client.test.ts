import {expect,test,spyOn} from "bun:test";
import type {UsageControlAction} from "@legalwork/types/usage-control";
import {createLegalworkServerClient} from "../src/app/lib/legalwork-server";
test("usage request is serialized once and goes through the scoped server",async()=>{
 const client=createLegalworkServerClient({baseUrl:"http://127.0.0.1:4321",token:"desktop-session"});
 let sent:RequestInit|undefined, url="";
 const original=globalThis.fetch;
 const stub=spyOn(globalThis,"fetch").mockImplementation(Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{url=String(input);sent=init;return Response.json({ok:true});},{preconnect:original.preconnect}));
 try {
  const action:UsageControlAction={action:"request",kind:"temporary",amountCents:3000,reason:"Deadline"};
  await client.eigenweltUsageAction("workspace/one",action);
  expect(url).toBe("http://127.0.0.1:4321/workspace/workspace%2Fone/eigenwelt/usage");
  expect(JSON.parse(String(sent?.body))).toEqual(action);
  expect(new Headers(sent?.headers).get("Authorization")).toBe("Bearer desktop-session");
 }finally{stub.mockRestore();}
});
