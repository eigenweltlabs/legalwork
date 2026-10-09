import { test, expect } from "bun:test";
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2";
import { channelLiveEvents } from "./channel-live-events.js";

const info = (id: string, parentID = "human"): AssistantMessage => ({id,parentID,sessionID:"session",role:"assistant",time:{created:1},
  modelID:"test",providerID:"test",mode:"legalwork",agent:"legalwork",path:{cwd:"/owned",root:"/owned"},cost:0,
  tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}}});
const text = (id: string, value: string, closed: boolean): Part => ({id,sessionID:"session",messageID:"reply",type:"text",text:value,time:{start:1,...(closed ? {end:2} : {})}});
const tool = (id: string, name: string, output: unknown): Part => ({id,sessionID:"session",messageID:"reply",type:"tool",tool:name,callID:id,
  state:{status:"completed",input:{},output:JSON.stringify(output),title:"",metadata:{},time:{start:1,end:2}}});

test("a closed acknowledgement crosses before tools or the assistant turn complete; token deltas do not", () => {
  const message = {info:info("reply"),parts:[text("ack","I’m checking the file.",true),text("partial","Partial private model delta",false)]};
  const first=channelLiveEvents([message],"human");
  expect(first.map(item=>item.event)).toEqual([{type:"message.created",text:"I’m checking the file."}]);
  message.parts.push(tool("read","read",{contents:"private-tool-output"}));
  expect(channelLiveEvents([message],"human")).toEqual(first);
});
test("reaction outputs target the exact human turn; unrelated tool, reasoning and hidden text stay private", () => {
  const hidden = text("hidden","hidden prompt",true); if(hidden.type==="text") hidden.synthetic=true;
  const ignored = text("ignored","ignored prompt",true); if(ignored.type==="text") ignored.ignored=true;
  const message={info:info("reply"),parts:[hidden,ignored,tool("react","legalwork_assistant_react",{ok:true,reaction:{messageId:"human",emoji:"👀"}}),
    tool("foreign","legalwork_assistant_react",{ok:true,reaction:{messageId:"other-human",emoji:"👍"}}),
    tool("arbitrary","read",{text:"secret-token"}),tool("invalid","legalwork_assistant_react",{ok:true,reaction:{messageId:"human",emoji:"invented"}})]};
  expect(channelLiveEvents([message,{info:info("other","foreign"),parts:[text("other-text","foreign-user-text",true)]}],"human").map(item=>item.event))
    .toEqual([{type:"reaction.changed",messageId:"human",emoji:"👀"}]);
});
test("final completed text has the same stable ID as its earlier closed bubble and summaries remain private", () => {
  const message={info:info("reply"),parts:[text("final","Result",true)]};
  const first=channelLiveEvents([message],"human");message.info.time.completed=3;message.info.finish="stop";
  expect(channelLiveEvents([message],"human")).toEqual(first);
  message.info.summary=true;expect(channelLiveEvents([message],"human")).toEqual([]);
});
test("model-only app-state reminders do not hide a valid reaction or leak into its event", () => {
  const part=tool("react","legalwork_assistant_react",{ok:true,reaction:{messageId:"human",emoji:"👀"}});
  if(part.type!=="tool" || part.state.status!=="completed") throw new Error("Invalid fixture");
  part.state.output+='\n\n<system-reminder topic="main-assistant">\nprivate-state-canary\n</system-reminder>';
  const message={info:info("reply"),parts:[part]};
  expect(channelLiveEvents([message],"human").map(item=>item.event)).toEqual([{type:"reaction.changed",messageId:"human",emoji:"👀"}]);
  part.state.output+='\nUnrecognized trailing content';expect(channelLiveEvents([message],"human")).toEqual([]);
});
