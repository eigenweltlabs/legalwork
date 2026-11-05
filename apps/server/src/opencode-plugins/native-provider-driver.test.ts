import { expect,test } from "bun:test";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// Resolve the plugin's exact2.1.4 transitive drivers, rather than installing a
// second AI/Effect runtime. These fixtures build requests only: no network/model.
const plugin=Bun.resolveSync("@opencode/plugin",import.meta.dir);
const resolve=(name:string)=>pathToFileURL(Bun.resolveSync(name,dirname(plugin))).href;
const {Effect}=await import(resolve("effect"));
const {protocol:anthropic}=await import(resolve("@opencode/ai/protocols/anthropic-messages"));
const {provider:anthropicProvider}=await import(resolve("@opencode/ai/providers/anthropic"));
const {protocol:responses}=await import(resolve("@opencode/ai/protocols/openai-responses"));
const {provider:openaiProvider}=await import(resolve("@opencode/ai/providers/openai"));

test("pinned native Anthropic still requires the narrow explicit-legacy and MCP schema corrections",async()=>{
  const schema={type:"object",anyOf:[{type:"object",properties:{file:{type:"string"}},required:["file"]},{type:"object",properties:{url:{type:"string"}},required:["url"]}]};
  const base={model:anthropicProvider.model("claude-fable-5"),system:[],messages:[],tools:[{type:"tool",name:"fixture",description:"Fixture",inputSchema:schema}]};
  const raw:unknown=await Effect.runPromise(anthropic.body.from({...base,providerOptions:{thinking:{type:"enabled",budgetTokens:16000}}}));
  const body=z.object({thinking:z.unknown(),tools:z.array(z.object({input_schema:z.unknown()}))}).parse(raw);
  expect(body.thinking).toEqual({type:"enabled",budget_tokens:16000});expect(body.tools[0].input_schema).toEqual(schema);
  const adaptive:unknown=await Effect.runPromise(anthropic.body.from({...base,providerOptions:{thinking:{type:"adaptive"},effort:"high"}}));
  expect(adaptive).toMatchObject({thinking:{type:"adaptive"},output_config:{effort:"high"}});
});

test("pinned native Responses still replays long cross-provider call IDs verbatim",async()=>{
  const id="call_"+"x".repeat(200),raw:unknown=await Effect.runPromise(responses.body.from({model:openaiProvider.model("gpt-5"),system:[],tools:[],messages:[{role:"assistant",content:[{type:"tool-call",id,name:"fixture",input:{}}]},{role:"tool",content:[{type:"tool-result",id,name:"fixture",result:{type:"text",text:"ok"}}]}]}));
  const body=z.object({input:z.array(z.object({call_id:z.string()}))}).parse(raw);expect(body.input.map(item=>item.call_id)).toEqual([id,id]);
});
