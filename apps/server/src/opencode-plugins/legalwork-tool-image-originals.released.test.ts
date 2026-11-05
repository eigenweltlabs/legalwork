import { expect, test } from "bun:test";
import { createHash, randomFillSync } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { createManagedOpencodeServer } from "../managed-opencode.js";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { closeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { ensureWikiAgentToken, revokeWikiAgentSession } from "../wiki/agent-access.js";
import { toolImageOriginalPage, TOOL_IMAGE_METADATA_KEY } from "../tool-image-original-schema.js";
import { toolImageOriginalStore } from "../tool-image-original-store.js";
import { waitForNativeFixture } from "../native-mcp.test-support.js";
import { nativeDecodedRelayResponse } from "./native-decoded-relay.test-support.js";
import { buildNativePluginFixture } from "./native-plugin-build.test-support.js";
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const wireSchema = z.object({ messages:z.array(z.object({role:z.string(),content:z.unknown()}).passthrough()),tools:z.array(z.object({function:z.object({name:z.string()})})).optional() }).passthrough();
function png(width: number, height: number, red: number, noise = false) {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(content)); return Buffer.concat([size, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  if (noise) { randomFillSync(pixels); for (let y = 0; y < height; y++) pixels[y * (1 + width * 3)] = 0; }
  else for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (1 + width * 3) + 1 + x * 3; pixels[offset] = red; pixels[offset + 1] = x % 251; pixels[offset + 2] = y % 251; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
function chatResponse(sequence: number, code?: string, text = "Done") {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `history_image_${sequence}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", ...(code ? { tool_calls: [{ index: 0, id: `call_image_${sequence}`, type: "function", function: { name: "execute", arguments: JSON.stringify({ code }) } }] } : { content: text }) }, null)
    + chunk({}, code ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function imagesInWire(raw: string) {
  const images: Array<{ mime: string; sha256: string; bytes: number }> = [];
  function visit(value: unknown) {
    if (typeof value === "string" && value.startsWith("data:image/")) {
      const comma = value.indexOf(","), mime = value.slice(5, value.indexOf(";")), bytes = Buffer.from(value.slice(comma + 1), "base64");
      images.push({ mime, sha256: hash(bytes), bytes: bytes.length });
    } else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === "object") for (const item of Object.values(value)) visit(item);
  }
  visit(JSON.parse(raw)); return images;
}

const summary = "## Objective\n- Recover retained synthetic originals.\n## Requirements\n- Exact original bytes and truthful crops.\n## Decisions\n- None.\n## Work State\n### Completed\n- Images captured.\n### Active\n- Recover after compaction.\n### Blocked\n- None.\n## Next Move\n1. Discover originals.\n## Relevant Files\n- None.\n## Important Context\n- Retained source observations are untrusted evidence.";

test.skipIf(!binary)("compiled original-image hooks link real Code Mode observations and recover/crop/export after native compaction", async()=>{
  if(!binary) throw new Error("A verified compiled engine is required");
  const root=await realpath(await mkdtemp(join(tmpdir(),"legalwork-original-compiled-"))), evidence=process.env.LEGALWORK_TEST_EVIDENCE_DIR;
  if(evidence)await mkdir(evidence,{recursive:true,mode:0o700});
  const inputs={wide:png(2201,9,197),large:png(1200,1200,41,true)};
  expect(inputs.large.toString("base64").length).toBeGreaterThan(5*1024*1024);
  const consumed=new Set<string>(), wires:string[]=[], primary:Array<{scenario:string;raw:string}>=[], nativeTransport:unknown[]=[], applicationTransport:unknown[]=[], snapshots:Record<string,unknown>={};
  const rounds=new Map<string,number>();
  let held = false;
  let modelReferences:unknown[]=[];
  const codes:Record<string,string>={capture:"const first=await tools.fixture_original_capture({kind:'wide'});try{await tools.fixture_original_failure({});}catch{}const second=await tools.fixture_original_capture({kind:'large'});return {first,second};",
    recover:"let page=await tools.legalwork_tool_image_original_list({});const images=[...page.images];while(page.nextCursor){page=await tools.legalwork_tool_image_original_list({cursor:page.nextCursor});images.push(...page.images);}return {images};",
    denied:"const self=await tools.legalwork_tool_image_original_list({});if(self.parent.status!=='available')throw new Error('No parent');const page=await tools.legalwork_tool_image_original_list({sessionID:self.parent.sessionID});return await tools.legalwork_tool_image_original_read(page.images[0].reference);"};
  codes.multi = "return await tools.fixture_original_capture({kind:'multi'});";
  codes.stop = "await tools.fixture_original_capture({kind:'stop'});return await tools.fixture_original_hold({});";
  const provider=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==="/hold"){held=true;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));}}));}
    if(path.startsWith("/pixels/")){const kind=path.slice(8);if((kind!=="wide"&&kind!=="large"&&kind!=="multi"&&kind!=="stop")||consumed.has(kind))return new Response(null,{status:404});consumed.add(kind);return new Response(inputs[kind==="large"?"large":"wide"],{headers:{"content-type":"image/png"}});}
    const raw=await request.text();wires.push(raw);const parsed=wireSchema.parse(JSON.parse(raw));
    const isPrimary=parsed.tools?.some(tool=>tool.function.name==="execute")===true;
    const scenario=[...parsed.messages].reverse().filter(message=>message.role==="user").map(message=>JSON.stringify(message.content).match(/original-scenario-\[([a-z]+)\]/)).find(value=>value!==null)?.[1]??"auxiliary";
    const compaction=JSON.stringify(parsed.messages.at(-1)?.content).includes("summarize the conversation above");
    let code:string|undefined;
    if(isPrimary){primary.push({scenario,raw});const round=rounds.get(scenario)??0;rounds.set(scenario,round+1);if(round===0)code=codes[scenario];
      if(scenario==="recover"&&round===1){
        // The controlled model reads selectors from actual tool output, never hidden DB IDs.
        const candidates:unknown[]=[];
        const visit=(value:unknown):void=>{if(typeof value==="string"){try{visit(JSON.parse(value));}catch{}}else if(Array.isArray(value))for(const item of value)visit(item);else if(value&&typeof value==="object"){const parsed=toolImageOriginalPage.shape.images.element.safeParse(value);if(parsed.success)candidates.push(parsed.data);for(const item of Object.values(value))visit(item);}};
        for(const message of parsed.messages)if(message.role==="tool")visit(message.content);
        const unique=new Map<string,z.infer<typeof toolImageOriginalPage.shape.images.element>>();for(const value of candidates){const image=toolImageOriginalPage.shape.images.element.parse(value);unique.set(image.reference.id,image);}
        const images=[...unique.values()].sort((a,b)=>a.source.captureOrdinal-b.source.captureOrdinal);modelReferences=images;
        if(images.length!==2)throw new Error(`The actual model discovered ${images.length} original observations`);
        const wide=images.find(image=>image.name==="wide.png"),large=images.find(image=>image.name==="large.png");if(!wide||!large)throw new Error("Missing model-discovered originals");
        code=`const original=await tools.legalwork_tool_image_original_read(${JSON.stringify(wide.reference)});const crop=await tools.legalwork_tool_image_original_crop({reference:${JSON.stringify(large.reference)},rectangle:{x:1100,y:1100,width:20,height:20}});const exported=await tools.legalwork_tool_image_original_export({reference:${JSON.stringify(large.reference)},path:'exact-original.png'});return {original,crop,exported};`;
      }
    }
    return chatResponse(wires.length,code,compaction?summary:"Done");
  }});
  let engine:Awaited<ReturnType<typeof createManagedOpencodeServer>>|undefined,server:Awaited<ReturnType<typeof startServer>>|undefined,config:ServerConfig|undefined;
  let nativeProxy:ReturnType<typeof Bun.serve>|undefined,appProxy:ReturnType<typeof Bun.serve>|undefined,onNativeRead:(()=>void)|undefined;
  const previous={runtime:process.env.LEGALWORK_RUNTIME_DB,tokens:process.env.LEGALWORK_TOKEN_STORE};
  try{
    for(const name of ["home","config","data","cache","state","project","private","capture-plugin","original-tools","fixture-plugin"])await mkdir(join(root,name));
    const directory=join(root,"project"),location={directory};process.env.LEGALWORK_RUNTIME_DB=join(root,"runtime.sqlite");process.env.LEGALWORK_TOKEN_STORE=join(root,"tokens.json");
    config={host:"127.0.0.1",port:0,token:"original-fixture",hostToken:"original-host",configPath:join(root,"private","server.json"),managedEngineStorageDirectory:join(root,"private"),workspaces:[{id:"matter",name:"Matter",path:directory,workspaceType:"local",preset:"starter"}],authorizedRoots:[directory],readOnly:false,approval:{mode:"auto",timeoutMs:1000},corsOrigins:[],startedAt:0,tokenSource:"cli",hostTokenSource:"cli",logFormat:"pretty",logRequests:false};
    const resources=process.env.LEGALWORK_TEST_RASTER_RESOURCES;
    const require=createRequire(resources?join(resources,"app.asar.unpacked/package.json"):new URL("../../package.json",import.meta.url));
    // CI/source controls use the same prepared Node and installed native addons
    // as the raster tests; packaged acceptance supplies its actual resources.
    const nodeName=process.platform==="win32"?"node.exe":"node";
    const executable=resources?join(resources,"node",nodeName):fileURLToPath(new URL(`../../../desktop/resources/node/${nodeName}`,import.meta.url));
    server=await startServer(config,{toolImageRasterRuntime:()=>({executable,canvas:require.resolve("@napi-rs/canvas"),imageSize:require.resolve("image-size")})});
    const scopedToken=await ensureWikiAgentToken(config),base=`http://127.0.0.1:${server.port}`;
    appProxy=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){const started=performance.now(),url=new URL(request.url);const response=await fetch(base+url.pathname+url.search,{method:request.method,headers:request.headers,...(request.method==="GET"?{}:{body:await request.bytes()}),signal:request.signal});const bytes=await response.bytes();applicationTransport.push({method:request.method,path:url.pathname,status:response.status,milliseconds:performance.now()-started,body:Buffer.from(bytes).toString()});return nativeDecodedRelayResponse(response,bytes);}});
    await buildNativePluginFixture(join(import.meta.dir,"legalwork-tool-image-original-capture.ts"),join(root,"capture-plugin","index.js"));
    await buildNativePluginFixture(join(import.meta.dir,"legalwork-tool-image-originals.ts"),join(root,"original-tools","index.js"));
    const fixtureSource=join(root,"fixture.ts");await writeFile(fixtureSource,`import{Plugin}from"@opencode/plugin";export default Plugin.define({id:"original-fixture",async setup(ctx){await ctx.tool.transform(editor=>{editor.add({name:"fixture_original_capture",description:"Synthetic memory-only original",input:{type:"object",properties:{kind:{type:"string"}},required:["kind"]},output:{type:"object"},async execute(input){const response=await fetch(${JSON.stringify(provider.url.origin)}+"/pixels/"+input.kind);if(!response.ok)throw new Error("Source unavailable");const raw=Buffer.from(await response.arrayBuffer()).toString("base64");return{output:{kind:input.kind},content:Array.from({length:input.kind==="multi"?2:1},(_,index)=>({type:"file",mime:"image/png",name:input.kind+(input.kind==="multi"?index:"")+".png",uri:"data:image/png;base64,"+raw}))}}});editor.add({name:"fixture_original_hold",description:"Hold owned pending outer call",input:{type:"object"},async execute(_input,context){const response=await fetch(${JSON.stringify(provider.url.origin + "/hold")},{signal:context.signal});await response.arrayBuffer();return{content:"released"}}});editor.add({name:"fixture_original_failure",description:"Ordinary caught failure",input:{type:"object"},async execute(){throw new Error("Owned caught error")}});});}});`);
    await buildNativePluginFixture(fixtureSource,join(root,"fixture-plugin","index.js"));
    engine=await createManagedOpencodeServer({bin:binary,cwd:directory,timeoutMs:30000,env:{HOME:join(root,"home"),USERPROFILE:join(root,"home"),XDG_CONFIG_HOME:join(root,"config"),XDG_DATA_HOME:join(root,"data"),XDG_STATE_HOME:join(root,"state"),XDG_CACHE_HOME:join(root,"cache"),OPENCODE_CONFIG_DIR:join(root,"config"),OPENCODE_DB:join(root,"engine.db"),OPENCODE_CONFIG_PROJECT_DISABLE:"1",OPENCODE_DISABLE_MODELS_FETCH:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",LEGALWORK_SERVER_URL:appProxy.url.origin,LEGALWORK_SERVER_TOKEN:config.token,LEGALWORK_WIKI_AGENT_TOKEN:scopedToken,
      OPENCODE_CONFIG_CONTENT:JSON.stringify({update:"disable",warming:false,model:"fixture/fixture",compaction:{auto:false,keep:{tokens:0}},plugins:[join(root,"fixture-plugin"),join(root,"capture-plugin"),join(root,"original-tools")],permissions:[{action:"*",resource:"*",effect:"allow"}],providers:{fixture:{package:"@opencode/ai/providers/openai-compatible",settings:{baseURL:provider.url.origin+"/v1",apiKey:"synthetic-local-only"},models:{fixture:{limit:{context:128000,output:4096},capabilities:{tools:true,input:["text","image"],output:["text"]}}}}}})}});
    const native=engine;nativeProxy=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){const url=new URL(request.url);const response=await fetch(native.url+url.pathname+url.search,{method:request.method,headers:request.headers,...(request.method==="GET"?{}:{body:await request.bytes()})});const bytes=await response.bytes();nativeTransport.push({method:request.method,path:url.pathname,status:response.status,body:Buffer.from(bytes).toString()});if(/\/message\/[^/]+$/.test(url.pathname))onNativeRead?.();return nativeDecodedRelayResponse(response,bytes);}});
    config.opencodeBaseUrl=nativeProxy.url.origin;config.opencodeUsername=engine.username;config.opencodePassword=engine.password;const managed=config;
    const client=OpenCode.make({baseUrl:engine.url,headers:{Authorization:`Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`}});
    await client.model.list({location});snapshots.catalog=await client.plugin.list({location});
    const headers={Authorization:`Bearer ${config.token}`,"content-type":"application/json"},scoped=(sessionID:string)=>({"x-legalwork-wiki-agent-token":scopedToken,"x-legalwork-wiki-agent-session":sessionID,"x-legalwork-wiki-agent-directory":encodeURIComponent(directory),"content-type":"application/json"});
    const dispatch=async(sessionID:string,scenario:string,resume=true)=>{const response=await fetch(base+`/workspace/matter/sessions/${sessionID}/dispatch`,{method:"POST",headers,body:JSON.stringify({kind:"prompt",delivery:"steer",text:`original-scenario-[${scenario}]`,resume})});snapshots[`dispatch-${scenario}`]={status:response.status,body:await response.text()};if(!response.ok)throw new Error("Normal authenticated dispatch failed");if(resume)await client.session.wait({sessionID},{signal:AbortSignal.timeout(90000)});};
    const session=await client.session.create({location,title:"Pre-normalization originals"});const starting=performance.now(),beforeNative=nativeTransport.length;await dispatch(session.id,"capture");
    snapshots.capturePerformance={wallMilliseconds:performance.now()-starting,nativeRequests:nativeTransport.length-beforeNative,application:applicationTransport};
    const captured=await client.message.list({sessionID:session.id});snapshots.captured=captured;
    const part=captured.data.flatMap(message=>message.type==="assistant"?message.content.filter(content=>content.type==="tool"&&content.name==="execute"):[]).find(content=>content.type==="tool"&&content.state.status==="completed");
    if(part?.type!=="tool"||part.state.status!=="completed")throw new Error("Actual completed outer call missing");
    const linked=toolImageOriginalPage.shape.images.parse(z.object({originals:z.unknown()}).parse(part.state.metadata?.[TOOL_IMAGE_METADATA_KEY]).originals);expect(linked).toHaveLength(2);expect(new Set(linked.map(image=>image.reference.id)).size).toBe(2);expect(linked.every(image=>image.source.linkage==="observed-child-of-native-call")).toBe(true);
    for(const image of linked){const bytes=inputs[image.name==="wide.png"?"wide":"large"];expect(image.reference.sha256).toBe(hash(bytes));const read=await toolImageOriginalStore(config).read(image.reference,new AbortController().signal);expect(Buffer.compare(read.bytes,bytes)).toBe(0);}
    expect(consumed.size).toBe(2);for(const kind of ["wide","large"])expect((await fetch(provider.url.origin+"/pixels/"+kind)).status).toBe(404);
    expect((await readdir(directory,{recursive:true})).filter(file=>/\.(png|jpg|webp)$/.test(file))).toEqual([]);
    const normalized=part.state.content.flatMap(content=>content.type==="file"&&content.uri.startsWith("data:image/")?[hash(Buffer.from(content.uri.slice(content.uri.indexOf(",")+1),"base64"))]:[]);snapshots.normalizedSha256=normalized;expect(normalized).not.toContain(hash(inputs.wide));expect(normalized).not.toContain(hash(inputs.large));
    const multiple=await client.session.create({location,title:"Two images in one result"}), multiNative=nativeTransport.length, multiApps=applicationTransport.length, multiStart=performance.now();
    await dispatch(multiple.id,"multi");snapshots.multiImagePerformance={wallMilliseconds:performance.now()-multiStart,nativeRequests:nativeTransport.length-multiNative,application:applicationTransport.slice(multiApps)};
    const multiPage=toolImageOriginalPage.parse(await fetch(base+`/workspace/matter/sessions/${multiple.id}/tool-image-originals`,{headers:scoped(multiple.id)}).then(response=>response.json()));expect(multiPage.images).toHaveLength(2);expect(multiPage.images.map(image=>image.source.contentIndex)).toEqual([0,1]);
    const stopped=await client.session.create({location,title:"Stop an uncommitted source outer call"});
    const startStop=await fetch(base+`/workspace/matter/sessions/${stopped.id}/dispatch`,{method:"POST",headers,body:JSON.stringify({kind:"prompt",delivery:"steer",text:"original-scenario-[stop]"})});expect(startStop.ok).toBe(true);
    await waitForNativeFixture(async()=>held,value=>value,"actual native held child");
    const pendingURL=base+`/workspace/matter/sessions/${stopped.id}/tool-image-originals`;
    const pendingPage=toolImageOriginalPage.parse(await fetch(pendingURL,{headers:scoped(stopped.id)}).then(response=>response.json()));expect(pendingPage.images).toEqual([]);
    await client.session.interrupt({sessionID:stopped.id});await client.session.wait({sessionID:stopped.id},{signal:AbortSignal.timeout(60000)});
    const afterStop=toolImageOriginalPage.parse(await fetch(pendingURL,{headers:scoped(stopped.id)}).then(response=>response.json()));expect(afterStop.images).toEqual([]);snapshots.stoppedHistory=await client.message.list({sessionID:stopped.id});snapshots.pendingThenStopped={pendingPage,afterStop};
    await dispatch(session.id,"buffer");await client.session.compact({sessionID:session.id});await client.session.wait({sessionID:session.id},{signal:AbortSignal.timeout(60000)});const context=await client.session.context({sessionID:session.id});snapshots.compactedContext=context;expect(context.some(message=>message.type==="compaction"&&message.status==="completed"&&message.summary.includes("## Objective"))).toBe(true);expect(context.some(message=>message.type==="assistant"&&message.content.some(content=>content.type==="tool"&&content.id===part.id))).toBe(false);
    await dispatch(session.id,"recover");snapshots.modelReferences=modelReferences;expect(modelReferences).toHaveLength(2);
    expect(await readFile(join(directory,"exact-original.png"))).toEqual(inputs.large);
    const recovery=primary.filter(item=>item.scenario==="recover");expect(recovery).toHaveLength(3);expect(imagesInWire(recovery[0]?.raw??"{}")).toEqual([]);
    const cropResponse=applicationTransport.find(value=>value&&typeof value==="object"&&"path"in value&&String(value.path).endsWith("/crop"));snapshots.cropResponse=cropResponse;
    const crop=z.object({body:z.string()}).parse(cropResponse),cropPayload=z.object({crop:z.object({output:z.object({sha256:z.string(),width:z.number(),height:z.number()}),source:z.object({decodedWidth:z.number(),decodedHeight:z.number()})})}).parse(JSON.parse(crop.body));
    expect(cropPayload.crop.source).toMatchObject({decodedWidth:1200,decodedHeight:1200});expect(cropPayload.crop.output).toMatchObject({width:20,height:20});expect(imagesInWire(recovery[2]?.raw??"{}").map(image=>image.sha256)).toContain(cropPayload.crop.output.sha256);
    const systems=recovery.map(item=>wireSchema.parse(JSON.parse(item.raw)).messages.filter(message=>message.role==="system"));expect(systems[0]).toEqual(systems[1]);expect(systems[1]).toEqual(systems[2]);expect(JSON.stringify(systems)).not.toContain(inputs.wide.toString("base64"));
    const child=await client.session.create({parentID:session.id,title:"Actual ancestor"});await dispatch(child.id,"child",false);
    const url=(id:string)=>base+`/workspace/matter/sessions/${id}/tool-image-originals`;
    const ancestor=await fetch(url(child.id)+"/read",{method:"POST",headers:scoped(child.id),body:JSON.stringify(linked[0]?.reference)});expect(ancestor.status).toBe(200);
    onNativeRead=()=>revokeWikiAgentSession(managed,child.id);const revoked=await fetch(url(child.id)+"/read",{method:"POST",headers:scoped(child.id),body:JSON.stringify(linked[0]?.reference)});snapshots.revoked={status:revoked.status,body:await revoked.text()};expect(revoked.status).toBe(403);onNativeRead=undefined;
    const denied=await client.session.create({parentID:session.id,title:"Actual deny",permissions:[{action:"*",resource:"*",effect:"allow"},{action:"legalwork_tool_image_original_read",resource:"*",effect:"ask"}]});const response=await fetch(base+`/workspace/matter/sessions/${denied.id}/dispatch`,{method:"POST",headers,body:JSON.stringify({kind:"prompt",delivery:"steer",text:"original-scenario-[denied]"})});expect(response.ok).toBe(true);const requests=await waitForNativeFixture(()=>client.permission.list({sessionID:denied.id}),items=>items.length>0,"original read permission");const permission=requests[0];if(!permission)throw new Error("No permission request");snapshots.permission=permission;await client.permission.reply({sessionID:denied.id,requestID:permission.id,decision:"reject",message:"Owned original-image refusal"});await client.session.wait({sessionID:denied.id},{signal:AbortSignal.timeout(60000)});expect(imagesInWire(primary.filter(item=>item.scenario==="denied").at(-1)?.raw??"{}")).toEqual([]);
    snapshots.finalHistory=await client.message.list({sessionID:session.id});snapshots.finalProjectFiles=await readdir(directory,{recursive:true});
  }finally{
    await engine?.close();await server?.stop();nativeProxy?.stop(true);appProxy?.stop(true);provider.stop(true);if(config)closeRuntimeOpencodeConfig(config);
    if(evidence){for(const [name,value]of Object.entries({"complete-provider-requests":wires,"complete-primary-requests":primary,"complete-native-transport":nativeTransport,"complete-application-transport":applicationTransport,"complete-snapshots":snapshots}))await writeFile(join(evidence,name+".json"),JSON.stringify(value,null,2),{mode:0o600});await writeFile(join(evidence,"source-identities.json"),JSON.stringify({binary,binarySha256:hash(await readFile(binary)),testSha256:hash(await readFile(import.meta.path)),inputs:Object.fromEntries(Object.entries(inputs).map(([name,bytes])=>[name,{bytes:bytes.length,sha256:hash(bytes)}])),modelSpend:0,compactionPolicy:"controlled keep.tokens=0 fixture only"},null,2),{mode:0o600});for(const [name,bytes]of Object.entries(inputs))await writeFile(join(evidence,`original-${name}.png`),bytes,{mode:0o600});for(const name of ["engine.db","engine.db-wal","engine.db-shm","runtime.sqlite","private/tool-image-originals"]){await cp(join(root,name),join(evidence,name),{recursive:true}).catch(error=>{if(!(error instanceof Error&&"code"in error&&error.code==="ENOENT"))throw error;});}}
    for(const [key,value]of Object.entries({LEGALWORK_RUNTIME_DB:previous.runtime,LEGALWORK_TOKEN_STORE:previous.tokens})){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});
  }
},180000);
