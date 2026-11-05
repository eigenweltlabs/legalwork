import { Plugin } from "@opencode/plugin";
import { nativeProviderRequest } from "./native-provider-request.js";

function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value);}
/** Preserve the existing narrow correction for explicitly configured legacy
 * thinking on Claude5+. Native adaptive defaults and explicit effort stay intact. */
function adaptiveBody(body:string):string|null{
  let parsed:unknown;try{parsed=JSON.parse(body);}catch{return null;}
  if(!record(parsed)||typeof parsed.model!=="string"||!record(parsed.thinking)||parsed.thinking.type!=="enabled")return null;
  const version=/claude-[a-z]+-(\d+)(?:[.@-]|$)/i.exec(parsed.model);if(!version||Number(version[1])<5)return null;
  const budget=parsed.thinking.budget_tokens??parsed.thinking.budgetTokens;
  const output=record(parsed.output_config)?parsed.output_config:{};
  return JSON.stringify({...parsed,thinking:{type:"adaptive"},output_config:{...output,effort:output.effort??(typeof budget==="number"&&budget>16000?"max":"high")}});
}
export default Plugin.define({id:"legalwork.anthropic.adaptive-thinking",async setup(ctx){
  await ctx.session.hook("http.request",async event=>{
    if(!event.request.headers.has("anthropic-version"))return;
    event.request=await nativeProviderRequest(event.request,adaptiveBody);
  });
}});
