import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { retryChannelTurn } from '../src/channel-recovery.js';
// Run with OPENCODE_BIN pointing to the pinned OpenCode executable. No real model is called.
const binary = process.env.OPENCODE_BIN;
if (!binary) throw new Error('Set OPENCODE_BIN to run the real-engine recovery check');
const root = await mkdtemp(join(tmpdir(), 'legalwork-retry-engine-'));
let calls = 0;
const provider = Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request => {
  if(!new URL(request.url).pathname.endsWith('/chat/completions')) return Response.json({data:[]});
  const body=await request.json();
  calls++;
  const content=calls===1?'':'Recovered automatically.';
  if(!body.stream) return Response.json({id:'response',object:'chat.completion',created:1,model:'test',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  const chunk=(delta:unknown,finish_reason:unknown)=>'data: '+JSON.stringify({id:'response',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta,finish_reason}]})+'\n\n';
  return new Response(chunk({role:'assistant',content},null)+chunk({},'stop')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}});
const config={model:'test/test',enabled_providers:['test'],provider:{test:{npm:'@ai-sdk/openai-compatible',name:'Test',options:{baseURL:`http://127.0.0.1:${provider.port}/v1`,apiKey:'inert'},models:{test:{name:'Test',limit:{context:200000,output:1000}}}}}};
const proc=Bun.spawn([binary,'serve','--hostname','127.0.0.1','--port','39189'],{cwd:root,env:{...process.env,OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_DISABLE_DEFAULT_PLUGINS:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DB:join(root,'engine.db'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_CACHE_HOME:join(root,'cache')},stdout:Bun.file(join(root,'engine.log')),stderr:Bun.file(join(root,'engine-errors.log'))});
try {
 const baseUrl='http://127.0.0.1:39189';
 for(let i=0;i<120;i++){if(await fetch(baseUrl+'/global/health').then(r=>r.ok).catch(()=>false))break;await Bun.sleep(500);}
 const client=createOpencodeClient({baseUrl});
 const session=(await client.session.create({title:'Automatic recovery diagnostic'},{throwOnError:true})).data!;
 await client.session.prompt({sessionID:session.id,agent:'build',model:{providerID:'test',modelID:'test'},parts:[{type:'text',text:'Reply with hello. Do not use tools.'}],tools:{'all':false}},{throwOnError:true});
 const first=(await client.session.messages({sessionID:session.id},{throwOnError:true})).data!;
 const user=first.find(m=>m.info.role==='user')!;
 console.log(JSON.stringify({initialCalls:calls,empty:first.filter(m=>m.info.role==='assistant').every(m=>!m.parts.some(p=>p.type==='text'&&p.text.trim()))}));
 const result=await retryChannelTurn(client,{id:'test',userId:'test',orgId:'test',channel:'ios',conversationId:'test',text:'',attachments:[],fingerprint:'',workspaceId:'test',sessionId:session.id,messageId:user.info.id,state:'running',textResult:null,files:[],events:[],code:'empty_reply',createdAt:Date.now(),updatedAt:Date.now(),retries:1,retryAt:null});
 for(let i=0;i<80;i++){
  await Bun.sleep(250);
  const messages=(await client.session.messages({sessionID:session.id},{throwOnError:true})).data!;
  if(messages.some(m=>m.parts.some(p=>p.type==='text'&&p.text==='Recovered automatically.'))){
   if(!result||calls!==2||messages.filter(m=>m.info.role==='user').length!==1)throw new Error('Recovery duplicated input or did not run');
   console.log(JSON.stringify({recovered:true,modelCalls:calls,userMessages:1}));process.exitCode=0;break;
  }
  if(i===79)throw new Error('Recovery did not produce a response');
 }
}finally{proc.kill();await proc.exited;provider.stop(true);await rm(root,{recursive:true,force:true});}
