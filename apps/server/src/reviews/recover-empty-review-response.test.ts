import { expect,test } from "bun:test";
import { Plugin } from "@opencode/plugin";
import { nativePluginTestRuntime } from "../opencode-plugins/native-plugin-test-support.js";
import { nativeEvents } from "../opencode-plugins/native-events.js";
import { recoverEmptyReviewResponse } from "./recover-empty-review-response.js";

const user={type:"user",id:"user",text:"Run DD",metadata:{legalworkPrompt:{visibleText:"Run DD",reminders:["Project context"]}}};
const assistant={type:"assistant",id:"empty",finish:"stop",content:[{type:"reasoning",text:"Preparing the report"}]};
async function fixture(){
  const runtime=nativePluginTestRuntime(),sent:Array<[string,string]>=[];
  runtime.histories.set("session",[user,assistant]);
  const plugin=Plugin.define({id:"recovery-fixture",setup:ctx=>nativeEvents(ctx,recoverEmptyReviewResponse(ctx,async(sessionID,messageID)=>{sent.push([sessionID,messageID]);}))});await runtime.start(plugin);
  return{runtime,sent,plugin,idle:()=>runtime.event({type:"session.execution.succeeded",data:{sessionID:"session"}})};
}

test("native normal reasoning-only stops delegate once to the authoritative saved-review gate",async()=>{
  const f=await fixture();try{await f.idle();await f.idle();expect(f.sent).toEqual([["session","empty"]]);}finally{await f.runtime.close();}
});
test("answers, tool calls, errors, budget stops, compaction and synthetic turns never recover",async()=>{
  const f=await fixture();try{
    for(const last of [{...assistant,content:[{type:"text",text:"Need approval"}]},{...assistant,content:[...assistant.content,{type:"tool",name:"read"}]},{...assistant,error:{type:"budget",message:"Budget exceeded"}},{...assistant,finish:"length"},{type:"compaction",id:"compact",status:"completed"},{type:"synthetic",id:"synthetic",text:"Continue"}]){
      f.runtime.histories.set("session",[user,last]);await f.idle();
    }
    await f.runtime.event({type:"session.execution.failed",data:{sessionID:"session"}});await f.runtime.event({type:"session.execution.interrupted",data:{sessionID:"session"}});expect(f.sent).toEqual([]);
  }finally{await f.runtime.close();}
});
test("restart respects the durable recovery marker and never treats a synthetic as new user permission",async()=>{
  const f=await fixture();try{
    f.runtime.histories.set("session",[user,{type:"synthetic",id:"recovery",text:"Continue",metadata:{legalworkReviewRecovery:true}},assistant]);await f.idle();expect(f.sent).toEqual([]);
    await f.runtime.close();await f.runtime.start(f.plugin);await f.idle();expect(f.sent).toEqual([]);
  }finally{await f.runtime.close();}
});
test("each new human request may recover once while app reminders remain part of that original request",async()=>{
  const f=await fixture();try{await f.idle();f.runtime.histories.set("session",[user,assistant,{...user,id:"user2"},{...assistant,id:"empty2"}]);await f.idle();expect(f.sent).toEqual([["session","empty"],["session","empty2"]]);}finally{await f.runtime.close();}
});
