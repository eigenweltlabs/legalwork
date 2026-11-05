import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OriginalImages from "./legalwork-tool-image-originals.js";
import { nativePluginTools } from "./native-plugin-test-support.js";
import type { ToolImageOriginal } from "../tool-image-original-schema.js";
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const encoded="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),"legalwork-original-tools-")));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const image:ToolImageOriginal={reference:{id:"4b900ef4-67d2-4bf4-a90a-cbe83a8c1ed5",sessionID:"parent",sha256:createHash("sha256").update(Buffer.from(encoded,"base64")).digest("hex")},bytes:68,mime:"image/png",header:{status:"unavailable"},source:{messageID:"msg",outerCallID:"outer",tool:"office.preview",contentIndex:0,captureOrdinal:1,linkage:"observed-child-of-native-call",storageNamespace:"unverified",capturedDirectory:root,capturedProjectID:"p",capturedWorkspaceID:"matter",capturedAt:0},provenance:"pre-normalization-tool-original"};
  const saved={url:process.env.LEGALWORK_SERVER_URL,token:process.env.LEGALWORK_SERVER_TOKEN,scoped:process.env.LEGALWORK_WIKI_AGENT_TOKEN};
  const requests:Array<{path:string;body:unknown}> = [];
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){const url=new URL(request.url);if(url.pathname==="/workspaces")return Response.json({items:[{id:"matter",path:root}]});
    expect(request.headers.get("authorization")).toBeNull();expect(request.headers.get("x-legalwork-wiki-agent-session")).toBe("child");expect(request.headers.get("x-legalwork-wiki-agent-token")).toBe("scope");
    const body=request.method==="POST"?await request.json():null;requests.push({path:url.pathname,body});
    if(url.pathname.endsWith("/read"))return Response.json({image,uri:`data:image/png;base64,${encoded}`});
    if(url.pathname.endsWith("/export"))return Response.json({image,path:"original.png",bytes:image.bytes,sha256:image.reference.sha256});
    return Response.json({sessionID:"parent",images:[image],nextCursor:"opaque-next",pageSize:100,parent:{status:"none"}});
  }});cleanup.push(()=>server.stop(true));process.env.LEGALWORK_SERVER_URL=server.url.origin;process.env.LEGALWORK_SERVER_TOKEN="not-forwarded";process.env.LEGALWORK_WIKI_AGENT_TOKEN="scope";
  cleanup.push(()=>{const values:Record<string,string|undefined>={LEGALWORK_SERVER_URL:saved.url,LEGALWORK_SERVER_TOKEN:saved.token,LEGALWORK_WIKI_AGENT_TOKEN:saved.scoped};for(const [key,value]of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const plugin=await nativePluginTools(OriginalImages,{directory:root});cleanup.push(()=>plugin.close());const asks:unknown[]=[];
  const context={directory:root,sessionID:"child",ask:async(input:unknown)=>{asks.push(input);}};
  return{root,image,requests,plugin,asks,context};
}

test("native original tools retain fixed guidance, exact references/cursors and native image content without base64 JSON echo",async()=>{
  const f=await fixture();const before={sessionID:"child",agent:"legalwork",system:[]};await f.plugin.runtime.hook("session","context",before);
  const listed=await f.plugin.tool.legalwork_tool_image_original_list.executeResult({sessionID:"parent",cursor:"opaque-previous"},f.context);expect(listed.output).toMatchObject({nextCursor:"opaque-next",pageSize:100});expect(JSON.stringify(listed.output)).not.toContain(encoded);
  const read=await f.plugin.tool.legalwork_tool_image_original_read.executeResult(f.image.reference,f.context);expect(read.output).toEqual(f.image);expect(JSON.stringify(read.output)).not.toContain(encoded);expect(read.content).toContainEqual({type:"file",mime:"image/png",uri:`data:image/png;base64,${encoded}`,name:"original-image"});
  const exported=await f.plugin.tool.legalwork_tool_image_original_export.executeResult({reference:f.image.reference,path:"original.png"},f.context);expect(exported.output).toMatchObject({bytes:68,sha256:f.image.reference.sha256});
  expect(f.asks).toMatchObject([{permission:"legalwork_tool_image_original_list",patterns:["session:parent"]},{permission:"legalwork_tool_image_original_read",patterns:[`original:${f.image.reference.id}`]},{permission:"write",patterns:[join(f.root,"original.png")]},{permission:"legalwork_tool_image_original_export"}]);
  const after={sessionID:"child",agent:"legalwork",system:[]};await f.plugin.runtime.hook("session","context",after);expect(after.system).toEqual(before.system);expect(JSON.stringify(after.system)).not.toContain(encoded);
});

test("permission denial, missing scoped runtime and invalid export paths cannot make a server request",async()=>{
  const f=await fixture();await expect(f.plugin.tool.legalwork_tool_image_original_read.executeResult(f.image.reference,{...f.context,ask:async()=>{throw new Error("Explicit deny");}})).rejects.toThrow("Explicit deny");expect(f.requests).toEqual([]);
  await expect(f.plugin.tool.legalwork_tool_image_original_export.executeResult({reference:f.image.reference,path:"../escape"},f.context)).rejects.toThrow();expect(f.requests).toEqual([]);
  delete process.env.LEGALWORK_WIKI_AGENT_TOKEN;await expect(f.plugin.tool.legalwork_tool_image_original_read.executeResult(f.image.reference,f.context)).rejects.toThrow("scoped runtime credential");expect(f.requests).toEqual([]);
});
