import type { Plugin } from "@opencode/plugin";
import { nativeEvents } from "./native-events.js";
import type { ViewGenerationChunk } from "../views/generation-stream.js";

type Preview = {sessionID:string; messageID:string; chunk:ViewGenerationChunk};
/** Native input events cover every provider transport, including WebSockets.
 * These existing bounds affect live previews only; final metadata retains the complete view. */
export function registerViewGeneration(ctx:Plugin.Context,publish:(sessionID:string,directory:string,chunk:ViewGenerationChunk)=>Promise<void>):()=>void{
  const calls=new Map<string,Preview>(),latest=new Map<string,Preview>();
  let timer:ReturnType<typeof setTimeout>|undefined, publishing=false,closed=false;
  const flush=async()=>{
    if(publishing||closed)return;publishing=true;
    try{while(latest.size&&!closed){const updates=[...latest.values()];latest.clear();await Promise.all(updates.map(async({sessionID,chunk})=>{
      try{const session=await ctx.session.get({sessionID});if(!closed)await publish(sessionID,session.location.directory,chunk);}catch{/* Preview errors never interrupt the tool or discard its final saved metadata. */}
    }));}}finally{publishing=false;}
  };
  const queue=(key:string,value:Preview)=>{latest.set(key,{sessionID:value.sessionID,messageID:value.messageID,chunk:{...value.chunk}});if(!timer)timer=setTimeout(()=>{timer=undefined;void flush();},80);};
  const stop=nativeEvents(ctx,event=>{
    if(event.type==="session.deleted"){for(const[key,value]of calls)if(value.sessionID===event.data.sessionID){calls.delete(key);latest.delete(key);}return;}
    if(event.type==="session.execution.succeeded"||event.type==="session.execution.failed"||event.type==="session.execution.interrupted"){
      for(const[key,value]of calls)if(value.sessionID===event.data.sessionID)calls.delete(key);
      void flush();return;
    }
    if(event.type!=="session.tool.input.started"&&event.type!=="session.tool.input.delta"&&event.type!=="session.tool.input.ended")return;
    const key=`${event.data.sessionID}:${event.data.id}`;
    if(event.type==="session.tool.input.started"){
      if((event.data.name!=="view_create"&&event.data.name!=="view_update")||[...calls.values()].filter(value=>value.sessionID===event.data.sessionID&&value.messageID===event.data.assistantMessageID).length>=16)return;
      const value={sessionID:event.data.sessionID,messageID:event.data.assistantMessageID,chunk:{callId:event.data.id,tool:event.data.name,raw:""}} satisfies Preview;calls.set(key,value);queue(key,value);return;
    }
    const value=calls.get(key);if(!value)return;
    const raw=event.type==="session.tool.input.delta"?value.chunk.raw+event.data.delta:event.data.text;
    if(raw.length>200_000){calls.delete(key);latest.delete(key);return;}
    value.chunk.raw=raw;queue(key,value);
    if(event.type==="session.tool.input.ended"){calls.delete(key);if(timer){clearTimeout(timer);timer=undefined;}void flush();}
  },()=>{calls.clear();latest.clear();});
  return()=>{closed=true;stop();if(timer)clearTimeout(timer);calls.clear();latest.clear();};
}
