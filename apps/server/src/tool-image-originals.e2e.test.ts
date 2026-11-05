import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { TOOL_IMAGE_METADATA_KEY, toolImageOriginal, toolImageOriginalPage, type ToolImageOriginal } from "./tool-image-original-schema.js";
import { toolImageOriginalStore } from "./tool-image-original-store.js";
import { ensureWikiAgentToken, grantWikiAgentSession, revokeWikiAgentSession } from "./wiki/agent-access.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const data="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),"legalwork-original-routes-"))); cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,"project"), other=join(root,"other"), storage=join(root,"private"); for(const path of [project,other,storage]) await mkdir(path);
  let committed:ToolImageOriginal|undefined, onRead:(()=>void|Promise<void>)|undefined, nativeReads=0;
  const native=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const path=new URL(request.url).pathname, matched=path.match(/^\/api\/session\/([^/]+)(?:\/message\/([^/]+))?$/); if(!matched)return new Response(null,{status:404});
    const id=matched[1]; if(!matched[2])return Response.json({data:{id,projectID:"p",location:{directory:id==="other"?other:project},...(id==="child"?{parentID:"parent"}:{}),time:{created:0,updated:0}}});
    nativeReads++; await onRead?.(); return Response.json({data:{id:"msg",type:"assistant",agent:"legalwork",model:{providerID:"fixture",id:"fixture"},time:{created:1},content:[{type:"tool",name:"execute",id:"outer",time:{created:1},state:committed?{status:"completed",input:{},content:[{type:"text",text:"Complete"}],metadata:{[TOOL_IMAGE_METADATA_KEY]:{status:"retained-pending-native-commit",originals:[committed]},toolCalls:[{tool:"office.preview",status:"completed"}]}}:{status:"running",input:{},metadata:{}}}]}});
  }});cleanup.push(()=>native.stop(true));
  const config:ServerConfig={host:"127.0.0.1",port:0,token:"fixture",hostToken:"fixture-host",configPath:join(storage,"server.json"),managedEngineStorageDirectory:storage,
    opencodeBaseUrl:native.url.origin,workspaces:[{id:"matter",name:"Matter",path:project,preset:"starter",workspaceType:"local"},{id:"other",name:"Other",path:other,preset:"starter",workspaceType:"local"}],
    authorizedRoots:[project,other],approval:{mode:"auto",timeoutMs:1000},corsOrigins:[],readOnly:false,startedAt:0,tokenSource:"cli",hostTokenSource:"cli",logFormat:"pretty",logRequests:false};
  const server=await startServer(config);cleanup.push(()=>server.stop());const token=await ensureWikiAgentToken(config);await grantWikiAgentSession(config,{sessionId:"child",directory:project,scope:"owner"});
  const headers=(session="child",dir=project)=>({"x-legalwork-wiki-agent-token":token,"x-legalwork-wiki-agent-session":session,"x-legalwork-wiki-agent-directory":encodeURIComponent(dir)});
  const url=(session="child",workspace="matter")=>`http://127.0.0.1:${server.port}/workspace/${workspace}/sessions/${session}/tool-image-originals`;
  const post=(action:string,body:unknown)=>fetch(url()+action,{method:"POST",headers:{...headers(),"content-type":"application/json"},body:JSON.stringify(body)});
  async function capture(){const form=new FormData();form.set("metadata",JSON.stringify({messageID:"msg",callID:"outer",tool:"office.preview",contentIndex:0,mime:"image/png"}));form.set("image",new Blob([Buffer.from(data,"base64")]));const response=await fetch(url()+"/capture",{method:"POST",headers:headers(),body:form});expect(response.status).toBe(200);return toolImageOriginal.parse((await response.json()).image);}
  return {root,project,other,config,headers,url,post,capture,nativeReads:()=>nativeReads,commit:(image:ToolImageOriginal)=>{committed=image;},onRead:(callback:()=>void|Promise<void>)=>{onRead=callback;}};
}

test("real server scoped routes hide pending observations and return exact committed originals, never bearer/cross-chat authority",async()=>{
  const f=await fixture(), image=await f.capture();
  const before=toolImageOriginalPage.parse(await fetch(f.url(),{headers:f.headers()}).then(r=>r.json()));expect(before.images).toEqual([]);
  expect((await f.post("/read",image.reference)).status).toBe(404); f.commit(image);
  const page=toolImageOriginalPage.parse(await fetch(f.url(),{headers:f.headers()}).then(r=>r.json()));expect(page.images).toEqual([image]);expect(JSON.stringify(page)).not.toContain(data);
  const read=await f.post("/read",image.reference);expect(read.status).toBe(200);expect((await read.json()).uri).toBe(`data:image/png;base64,${data}`);
  expect((await fetch(f.url(),{headers:{Authorization:"Bearer fixture"}})).status).toBe(403);
  expect((await fetch(f.url("parent"),{headers:f.headers()})).status).toBe(403);
  expect((await fetch(f.url("child","other"),{headers:f.headers()})).status).toBe(403);
  expect((await fetch(f.url()+"?sessionID=sibling",{headers:f.headers()})).status).toBe(404);
});

test("ordinary exact project export supports top-level files, protects existing bytes and respects readOnly/viewer",async()=>{
  const f=await fixture(),image=await f.capture();f.commit(image);
  const exported=await f.post("/export",{reference:image.reference,path:"original.png"});expect(exported.status).toBe(200);expect(await readFile(join(f.project,"original.png"))).toEqual(Buffer.from(data,"base64"));
  expect((await f.post("/export",{reference:image.reference,path:"original.png"})).status).toBe(409);
  expect((await f.post("/export",{reference:image.reference,path:"../escape.png"})).status).toBe(400);
  f.config.readOnly=true;expect((await f.post("/export",{reference:image.reference,path:"second.png"})).status).toBe(403);
  expect((await f.post("/read",image.reference)).status).toBe(200);
  f.config.readOnly=false;await grantWikiAgentSession(f.config,{sessionId:"child",directory:f.project,scope:"viewer"});
  expect((await f.post("/export",{reference:image.reference,path:"second.png"})).status).toBe(403);
});

test("post-native revocation and manual connection replacement cannot release late image bytes",async()=>{
  const f=await fixture(),image=await f.capture();f.commit(image);
  f.onRead(()=>revokeWikiAgentSession(f.config,"child"));const revoked=await f.post("/read",image.reference);expect(revoked.status).toBe(403);expect(await revoked.text()).not.toContain(data);
  await grantWikiAgentSession(f.config,{sessionId:"child",directory:f.project,scope:"owner"});
  f.onRead(()=>{f.config.workspaces=f.config.workspaces.map(workspace=>workspace.id==="matter"?{...workspace,opencodePassword:"new-generation",opencodeUsername:"changed"}:workspace);});
  const changed=await f.post("/read",image.reference);expect(changed.status).toBe(403);expect(await changed.text()).not.toContain(data);
  expect((await toolImageOriginalStore(f.config).metadata(image.reference)).reference).toEqual(image.reference);
});


test("a project parent replaced during native authorization cannot create directories outside the project",async()=>{
  const f=await fixture(),image=await f.capture();f.commit(image);
  const inside=join(f.project,"exports"),outside=join(f.root,"outside");await mkdir(inside);await mkdir(outside);
  let swapped=false;f.onRead(async()=>{if(swapped)return;swapped=true;await rm(inside,{recursive:true});await symlink(outside,inside);});
  const response=await f.post("/export",{reference:image.reference,path:"exports/new/original.png"});
  expect(response.status).toBe(403);expect(swapped).toBe(true);await expect(stat(join(outside,"new"))).rejects.toMatchObject({code:"ENOENT"});
});
