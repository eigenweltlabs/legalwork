import { expect,test } from "bun:test";
import definition from "./legalwork-anthropic-adaptive-thinking.js";
import { nativeProviderTestFetch } from "./native-plugin-test-support.js";

async function rewrite(model:string,thinking:unknown,output_config?:unknown,anthropic=true){
  const originalFetch=globalThis.fetch;
  const f=await nativeProviderTestFetch(definition,async request=>Response.json(await request.json()));
  try{const response=await f.send("https://provider.example/messages",{method:"POST",headers:anthropic?{"anthropic-version":"2023-06-01"}:{},body:JSON.stringify({model,thinking,output_config})});expect(globalThis.fetch).toBe(originalFetch);return response.json();}finally{await f.runtime.close();}
}
test("native Anthropic dispatch corrects explicit legacy thinking only for Claude5+",async()=>{
  expect(await rewrite("claude-fable-5",{type:"enabled",budget_tokens:16000})).toMatchObject({thinking:{type:"adaptive"},output_config:{effort:"high"}});
  expect(await rewrite("claude-fable-5-20260601",{type:"enabled",budget_tokens:31999})).toMatchObject({thinking:{type:"adaptive"},output_config:{effort:"max"}});
  expect(await rewrite("claude-opus-5",{type:"enabled",budget_tokens:16000},{effort:"low",format:{type:"json_schema"}})).toMatchObject({thinking:{type:"adaptive"},output_config:{effort:"low",format:{type:"json_schema"}}});
});
test("native adaptive,older Claude and unrelated provider requests remain unchanged",async()=>{
  for(const model of["claude-sonnet-4-5","claude-opus-4-1-20250805","claude-3-5-sonnet-20241022"]){expect(await rewrite(model,{type:"enabled",budget_tokens:16000})).toEqual({model,thinking:{type:"enabled",budget_tokens:16000}});}
  expect(await rewrite("claude-fable-5",{type:"adaptive"},{effort:"high"})).toMatchObject({thinking:{type:"adaptive"},output_config:{effort:"high"}});
  expect(await rewrite("claude-fable-5",{type:"enabled",budget_tokens:16000},undefined,false)).toEqual({model:"claude-fable-5",thinking:{type:"enabled",budget_tokens:16000}});
  expect(Object.keys(await import("./legalwork-anthropic-adaptive-thinking.js"))).toEqual(["default"]);
});
