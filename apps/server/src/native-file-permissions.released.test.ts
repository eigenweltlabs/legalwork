import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode, type JsonValue } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";

const rpc = { id: "legalwork.file-permission-test", methods: { run: { input: { type: "object", properties: { sessionID: {type:"string"}, tool: {type:"string"}, input: {type:"object"} }, required:["sessionID","tool","input"] }, output: {type:"string"} } }, events:{} };

test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)("native built-in file tools separately enforce outside-directory and read/edit approval",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"legalwork-native-file-permission-"))),workspace=join(root,"matter");
  await Promise.all(["matter","home","config","data","state","cache","probe"].map(name=>mkdir(join(root,name),{recursive:true})));
  const inside=join(workspace,"inside.txt"),outside=join(root,"home",".profile");
  await writeFile(inside,"inside");await writeFile(outside,"private-synthetic-content");
  let engine:Awaited<ReturnType<typeof createManagedOpencodeServer>>|undefined;
  try{
    await writeFile(join(root,"probe","index.js"),`import {Plugin} from "@opencode/plugin";export default Plugin.define({id:"legalwork.file-permission-test",async setup(ctx){let outcome="pending";await ctx.rpc.register(${JSON.stringify(rpc)},{async run(input,call){if(input.tool==="result")return outcome;const session=await ctx.session.get({sessionID:input.sessionID});const tool=(await ctx.tool.list()).find(tool=>tool.name===input.tool.replace(/^start-/,""));if(!tool)throw new Error("No tool");const execute=()=>tool.execute(input.input,{sessionID:input.sessionID,agent:session.agent||"build",messageID:"msg_file_permissions",id:"call_file_permissions",signal:new AbortController().signal,progress:async()=>{}});if(input.tool.startsWith("start-")){void execute().then(()=>{outcome="allowed"},()=>{outcome="rejected"});return "started";}return JSON.stringify(await execute())}})}});`);
    engine=await createManagedOpencodeServer({bin:process.env.LEGALWORK_TEST_OPENCODE_BIN,cwd:workspace,timeoutMs:30000,env:{HOME:join(root,"home"),USERPROFILE:join(root,"home"),XDG_CONFIG_HOME:join(root,"config"),XDG_DATA_HOME:join(root,"data"),XDG_STATE_HOME:join(root,"state"),XDG_CACHE_HOME:join(root,"cache"),OPENCODE_CONFIG_DIR:join(root,"config"),OPENCODE_DB:join(root,"engine.db"),OPENCODE_CONFIG_PROJECT_DISABLE:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",OPENCODE_DISABLE_MODELS_FETCH:"1",OPENCODE_CONFIG_CONTENT:JSON.stringify({update:"disable",warming:false,plugins:[join(root,"probe")],providers:{fixture:{package:"@opencode/ai/providers/openai-compatible",settings:{baseURL:"http://127.0.0.1:1/v1"},models:{fixture:{capabilities:{tools:true}}}}}})}});
    const client=OpenCode.make({baseUrl:engine.url,headers:{authorization:`Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`}}),location={directory:workspace};
    await client.model.list({location});
    const denied=await client.session.create({location,permissions:[{action:"*",resource:"*",effect:"allow"},{action:"external_directory",resource:"*",effect:"deny"}]});
    const invoke=(sessionID:string,tool:string,input:Record<string,JsonValue>)=>client.rpc.call({rpcID:rpc.id,method:"run",input:{sessionID,tool,input},location},{signal:AbortSignal.timeout(10000)});
    expect((await invoke(denied.id,"read",{path:inside})).output).toContain("inside");
    await expect(invoke(denied.id,"read",{path:outside})).rejects.toThrow();
    await expect(invoke(denied.id,"write",{path:outside,content:"escaped"})).rejects.toThrow();
    await expect(invoke(denied.id,"edit",{path:outside,oldString:"private",newString:"escaped"})).rejects.toThrow();
    expect(await readFile(outside,"utf8")).toBe("private-synthetic-content");
    const ask=await client.session.create({location,permissions:[{action:"*",resource:"*",effect:"allow"},{action:"external_directory",resource:"*",effect:"ask"}]});
    expect((await invoke(ask.id,"start-read",{path:outside})).output).toBe("started");
    let asked:Awaited<ReturnType<typeof client.permission.request.list>>["data"][number]|undefined;
    for(let attempt=0;attempt<200&&!asked;attempt++){asked=(await client.permission.request.list({location})).data.find(item=>item.sessionID===ask.id);if(!asked)await Bun.sleep(10);}
    if(!asked)throw new Error("The engine did not request outside-directory approval");
    expect(asked.action).toBe("external_directory");
    expect(asked?.resources).toEqual([join(root,"home","*")]);
    await client.permission.reply({sessionID:ask.id,requestID:asked.id,decision:"reject",message:"Private folder denied"});
    let outcome:unknown;
    for(let attempt=0;attempt<100;attempt++){outcome=(await invoke(ask.id,"result",{})).output;if(outcome!=="pending")break;await Bun.sleep(10);}
    expect(outcome).toBe("rejected");
    const readDeny=await client.session.create({location,permissions:[{action:"*",resource:"*",effect:"allow"},{action:"read",resource:outside,effect:"deny"}]});
    await expect(invoke(readDeny.id,"read",{path:outside})).rejects.toThrow();
  }finally{await engine?.close();await rm(root,{recursive:true,force:true});}
},60000);
