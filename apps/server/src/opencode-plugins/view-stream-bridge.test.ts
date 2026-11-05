import { expect,test } from "bun:test";
import { Plugin } from "@opencode/plugin";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";
import { registerViewGeneration } from "./view-stream-bridge.js";
import type { ViewGenerationChunk } from "../views/generation-stream.js";

async function fixture(){
  const runtime=nativePluginTestRuntime("/project"),chunks:Array<{sessionID:string;directory:string;chunk:ViewGenerationChunk}>=[];
  let fail=false;
  const fetch=globalThis.fetch;
  await runtime.start(Plugin.define({id:"view-fixture",setup:ctx=>registerViewGeneration(ctx,async(sessionID,directory,chunk)=>{if(fail)throw new Error("offline");chunks.push({sessionID,directory,chunk});})}));
  const send=(type:string,id:string,extra:Record<string,unknown>={},sessionID="session")=>runtime.event({type,data:{sessionID,assistantMessageID:"assistant",id,...extra}});
  return{runtime,chunks,send,fail:()=>{fail=true;},fetch};
}

test("native partial input previews preserve parallel JSON and final replay boundaries without touching fetch",async()=>{
  const f=await fixture();try{
    await f.send("session.tool.input.started","c1",{name:"view_create"});await f.send("session.tool.input.started","c2",{name:"view_update"});
    await f.send("session.tool.input.delta","c1",{delta:'{"input":{"program":"Stack('});await f.send("session.tool.input.delta","c2",{delta:'{"input":{"title":"Second"'});
    await Bun.sleep(100);expect(f.chunks.find(item=>item.chunk.callId==="c1")?.chunk.raw).toBe('{"input":{"program":"Stack(');
    const final='{"input":{"program":"Stack()\\n"}}';await f.send("session.tool.input.ended","c1",{text:final});await f.send("session.tool.input.ended","c2",{text:'{"input":{"title":"Second"}}'});await Bun.sleep(0);
    expect(f.chunks.filter(item=>item.chunk.callId==="c1").at(-1)?.chunk.raw).toBe(final);expect(f.chunks.filter(item=>item.chunk.callId==="c2").at(-1)?.chunk.raw).toBe('{"input":{"title":"Second"}}');expect(globalThis.fetch).toBe(f.fetch);
  }finally{await f.runtime.close();}
});

test("previews resolve the active session directory and isolate reused call IDs across chats",async()=>{
  const f=await fixture();try{
    await f.send("session.tool.input.started","same",{name:"view_create"},"one");await f.send("session.tool.input.started","same",{name:"view_update"},"two");f.runtime.move("/moved");
    await f.send("session.tool.input.ended","same",{text:'{"title":"One"}'},"one");await f.send("session.tool.input.ended","same",{text:'{"title":"Two"}'},"two");await Bun.sleep(0);
    expect(f.chunks.at(-1)).toMatchObject({sessionID:"two",directory:"/moved",chunk:{tool:"view_update",raw:'{"title":"Two"}'}});
    expect(f.chunks.some(item=>item.sessionID==="one"&&item.chunk.raw==='{"title":"One"}')).toBe(true);
    f.fail();await f.send("session.tool.input.started","offline",{name:"view_create"});await f.send("session.tool.input.ended","offline",{text:"{}"});
  }finally{await f.runtime.close();}
});

test("preview-only size limits and cleanup never alter provider input or final artifacts",async()=>{
  const f=await fixture();try{
    await f.send("session.tool.input.started","large",{name:"view_create"});await f.send("session.tool.input.delta","large",{delta:"x".repeat(200001)});await Bun.sleep(100);expect(f.chunks).toHaveLength(0);
    await f.send("session.tool.input.started","unrelated",{name:"wiki_read"});await f.send("session.tool.input.ended","unrelated",{text:"{}"});await Bun.sleep(0);expect(f.chunks).toHaveLength(0);
  }finally{await f.runtime.close();}
});
