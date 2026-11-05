import { expect,test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";
import { sendSessionPrompt,sendSessionCommand } from "../src/app/lib/system-reminder";

test("ordinary desktop prompt and command await browser authorization; hidden context skips it and failure leaves chat usable",async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,"window"),calls:string[]=[];
 let fail=false;
 const server=Bun.serve({port:0,async fetch(request){calls.push(`dispatch:${(await request.json()).kind}`);return Response.json({accepted:true,staged:true});}});
 Object.defineProperty(globalThis,"window",{configurable:true,value:{__LEGALWORK_ELECTRON__:{browser:{registerConnection:async(input:{baseUrl:string;token:string})=>{expect(input).toEqual({baseUrl:server.url.origin,token:"nonsecret-fixture"});calls.push("register");return {connectionId:"opaque-fixture"};},attachSession:async(input:{workspaceId:string;sessionId:string;connectionId?:string})=>{expect(input).toMatchObject({workspaceId:"matter",sessionId:"chat",connectionId:"opaque-fixture"});calls.push("attach");if(fail)throw new Error("Browser intentionally unavailable");return {attached:true};}}}}});
 try{
  const client=createClient(`${server.url.origin}/workspace/matter/opencode`,"/fixture",{mode:"legalwork",token:"nonsecret-fixture"});
  await sendSessionPrompt(client,{sessionID:"chat",parts:[{type:"text",text:"Review"}]});
  await sendSessionCommand(client,{sessionID:"chat",command:"review",arguments:"source"});
  await sendSessionPrompt(client,{sessionID:"chat",noReply:true,parts:[{type:"text",text:"Hidden state",synthetic:true}]});
  fail=true;await sendSessionPrompt(client,{sessionID:"chat",parts:[{type:"text",text:"Continue"}]});
  expect(calls).toEqual(["register","attach","dispatch:prompt","register","attach","dispatch:command","dispatch:synthetic","register","attach","dispatch:prompt"]);
 }finally{server.stop(true);if(original)Object.defineProperty(globalThis,"window",original);else Reflect.deleteProperty(globalThis,"window");}
});
