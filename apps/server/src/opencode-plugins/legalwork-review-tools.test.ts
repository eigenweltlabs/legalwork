import { afterAll, beforeEach, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { LegalWorkReviewTools } from "./legalwork-review-tools.js";
import { ReviewRowArgs, parseReviewCells } from "../tabular-review.js";

const originalUrl = process.env.LEGALWORK_SERVER_URL;
const originalToken = process.env.LEGALWORK_SERVER_TOKEN;
const calls: Array<{ path: string; body: unknown }> = [];
let status = "ready";
let discoveryFailure = false;
let inferenceFailure = false;
let questionTypes = ["noul", "choice", "score"];
let llmQuote = "Assignment requires consent.";
const server = Bun.serve({ port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  const raw = req.method === "POST" ? await req.text() : "";
  const body: unknown = raw ? JSON.parse(raw) : undefined;
  calls.push({ path, body });
  if (path.startsWith('/systemone') && req.headers.get('authorization') !== 'Bearer relay-key') return new Response('', {status:401});
  if (path === "/systemone/settings") return Response.json({ providers: [{
    id: "eigenwelt", name: "Eigenwelt", models: [{id:"EigenJev",name:"EigenJev Europe",questionTypes,source:"configured"}, {id:"next-jev",name:"Next JEV",questionTypes:["noul"],source:"discovered"}], managed: true,
    endpoint: "https://private.example/v1/systemone", enabled: true, status,
  }], selection: { providerId: "eigenwelt", model: "EigenJev" } });
  if (path === "/provider") return discoveryFailure ? new Response('', {status:503}) : Response.json({ connected: ["firm"], all: [
    { id: "firm", name: "Firm", models: { chat: { id: "chat", name: "Chat", limit: {context: 10000}, modalities: { output: ["text"] } } } },
    { id: "offline", name: "Disconnected", models: { unavailable: { id: "unavailable", name: "Unavailable", limit: {context: 10000} } } },
  ] });
  if (path === "/systemone") return inferenceFailure ? new Response('', {status:503}) : Response.json({
    model: "openjev-0.1", answers: { assignment: { type: "noul", noul: 0.02 }, law: { type: "choice", choice: "DE", probabilities: {DE:.9,other:.1} }, risk: { type: "score", score:.2, legend:{'0':'Low','1':'High'}, probabilities:{'0':.8,'1':.2} } }, usage: {input_tokens:123,output_tokens:0},
  });
  if (path === "/experimental/tool/ids") return Response.json(["bash", "read", "task", "tabular_review_row", "mcp_tool"]);
  if (path === "/session" && req.method === 'POST') return Response.json({ id: "child" });
  if (path === "/session/child/message") return Response.json({ info: { modelID: "chat", providerID: "firm" }, parts: [{type:"text", text:JSON.stringify({cells:{ assignment:{value:"Consent required",reason:"Express restriction.",quote:llmQuote,page:1,location:"§1",confidence:"high"} }})}] });
  if (path === "/session/child/abort" || (path === "/session/child" && req.method === 'DELETE')) return Response.json(true);
  return new Response(`Unknown ${path}`, {status:404});
} });
process.env.LEGALWORK_SERVER_URL = server.url.origin;
process.env.LEGALWORK_SERVER_TOKEN = "relay-key";
const plugin = await LegalWorkReviewTools({ client: createOpencodeClient({ baseUrl: server.url.origin }), directory: "/review" });
const context = { directory: "/review", sessionID: "parent" };
const row = {
  backend: "systemone", providerId: "eigenwelt", model: "EigenJev", file: "contract.txt", title: "Contract",
  pages: [{page:1,text:"Assignment requires consent. German law applies. Risk is low."}],
  columns: [
    {key:"assignment",label:"Assignment",question:"Can it be assigned without consent?",decision:{type:"noul",instructions:"Read the agreement."}},
    {key:"law",label:"Law",question:"Which law?",decision:{type:"choice",instructions:"Classify law.",criteria:{DE:"German law",other:"Other or absent"}}},
    {key:"risk",label:"Risk",question:"What is the risk?",decision:{type:"score",instructions:"Score risk.",criteria:["Low","High"]}},
  ],
};
beforeEach(() => { calls.length=0; status="ready"; discoveryFailure=false; inferenceFailure=false; questionTypes=["noul","choice","score"]; llmQuote="Assignment requires consent."; });
afterAll(() => { server.stop(true); if (originalUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL=originalUrl; if(originalToken===undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN=originalToken; });

test("discovers only connected/ready models and does not expose endpoints or keys", async () => {
  const text = await plugin.tool.tabular_review_models.execute({},context);
  const result=JSON.parse(text);
  expect(result.models.map((m: {model:string})=>m.model)).toEqual(["chat","EigenJev","next-jev"]);
  expect(result.models[1]).toMatchObject({backend:"systemone",citations:false,questionTypes:["noul","choice","score"],default:true});
  expect(text).not.toContain("private.example"); expect(text).not.toContain("relay-key");
  status="disabled";
  expect(JSON.parse(await plugin.tool.tabular_review_models.execute({},context)).models).toHaveLength(1);
});
test("partial discovery reports failure while preserving other backend availability",async()=>{
 discoveryFailure=true;
 const result=JSON.parse(await plugin.tool.tabular_review_models.execute({},context));
 expect(result.models).toHaveLength(2);expect(result.errors[0].backend).toBe("llm");
});
test("SystemOne uses explicit model and relay, preserves all typed answers without fabricated citations",async()=>{
 const result=JSON.parse(await plugin.tool.tabular_review_row.execute(row,context));
 expect(result.ok).toBe(true);
 expect(result.row.review).toMatchObject({backend:"systemone",model:"openjev-0.1",requestedModel:"EigenJev",usage:{input_tokens:123,output_tokens:0}});
 expect(result.row.cells.assignment).toMatchObject({value:"2.00% yes",quote:"",page:null,confidence:null,evidence:"uncited",decision:{noul:.02}});
 expect(result.row.cells.law.decision.probabilities).toEqual({DE:.9,other:.1});
 expect(result.row.cells.risk.value).toBe("0.2");
 expect(calls.find(c=>c.path==='/systemone')?.body).toMatchObject({providerId:"eigenwelt",request:{model:"EigenJev",state:{pages:row.pages}}});
 expect(calls.some(c=>c.path==='/session')).toBe(false);
});
test("disabled/changed providers and unsupported/free-text columns fail before inference",async()=>{
 for (const state of ['disabled','disconnected','unavailable']) {
   status=state;expect(JSON.parse(await plugin.tool.tabular_review_row.execute(row,context)).ok).toBe(false);
 }
 status='ready';questionTypes=['noul'];expect(JSON.parse(await plugin.tool.tabular_review_row.execute(row,context)).ok).toBe(false);
 questionTypes=['noul','choice','score'];
 expect(JSON.parse(await plugin.tool.tabular_review_row.execute({...row,model:'wrong'},context)).ok).toBe(false);
 expect(JSON.parse(await plugin.tool.tabular_review_row.execute({...row,columns:[{key:'free',label:'Free',question:'Names?'}]},context)).ok).toBe(false);
 expect(calls.some(c=>c.path==='/systemone'||c.path==='/session')).toBe(false);
});
test("inference failures never fall back to LLM",async()=>{
 inferenceFailure=true;
 expect(JSON.parse(await plugin.tool.tabular_review_row.execute(row,context))).toMatchObject({ok:false});
 expect(calls.some(c=>c.path==='/session')).toBe(false);
});
const llmInput=()=>({...row,backend:'llm',providerId:'firm',model:'chat',columns:[{key:'assignment',label:'Assignment',question:'What consent is required?'}]});
test("LLM explicitly selects model, disables all tools, validates citations and cleans up session",async()=>{
 const result=JSON.parse(await plugin.tool.tabular_review_row.execute(llmInput(),context));
 expect(result.ok).toBe(true); expect(result.row.cells.assignment.quote).toBe(llmQuote);
 expect(calls.find(c=>c.path==='/session/child/message')?.body).toMatchObject({model:{providerID:'firm',modelID:'chat'},tools:{bash:false,read:false,task:false,tabular_review_row:false,mcp_tool:false}});
 expect(calls.some(c=>c.path==='/session/child/abort')).toBe(true);
 expect(calls.some(c=>c.path==='/session/child')).toBe(true);
 expect(calls.some(c=>c.path==='/systemone')).toBe(false);
});
test("fabricated citations fail visibly without switching backend",async()=>{
 llmQuote='Invented source sentence';
 const result=JSON.parse(await plugin.tool.tabular_review_row.execute(llmInput(),context));
 expect(result.ok).toBe(false);expect(result.error).toContain('citation');
 expect(calls.some(c=>c.path==='/systemone')).toBe(false);
});
test("rejects wrong page, missing/extra cells, duplicate column keys and oversized documents",()=>{
 const args=ReviewRowArgs.parse(llmInput());
 const cell={value:'Consent',reason:'',quote:llmQuote,page:2,location:'',confidence:'high'};
 expect(()=>parseReviewCells(args,JSON.stringify({cells:{assignment:cell}}))).toThrow('citation');
 expect(()=>parseReviewCells(args,JSON.stringify({cells:{}}))).toThrow('columns');
 expect(()=>ReviewRowArgs.parse({...row,columns:[row.columns[0],row.columns[0]]})).toThrow('unique');
 expect(()=>ReviewRowArgs.parse({...row,pages:[{page:null,text:'a'.repeat(500001)}]})).toThrow('500,000');
});

test("plugin bundles as a single initializer and carries tool schemas",async()=>{
 const build=await Bun.build({entrypoints:[new URL('./legalwork-review-tools.ts',import.meta.url).pathname],target:'node',format:'esm'});
 expect(build.success).toBe(true);
 expect(Object.keys(await import('./legalwork-review-tools.js'))).toEqual(['LegalWorkReviewTools']);
 expect(plugin.tool.tabular_review_row.args.backend).toBeDefined();
});
