import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { engineProjectStatus } from "./engine-project.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { startServer } from "./server.js";
import { legalworkMandatoryRuntimeConfigContent, legalworkRuntimeConfigFilePath, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { closeRuntimeOpencodeConfig, GLOBAL_MCP_ID, GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("one managed native engine serves fresh registered cases, shared library and per-project provider controls without folder discovery", async () => {
  const root = await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/managed-config-")), previous = { ...process.env };
  let server: Awaited<ReturnType<typeof startServer>> | undefined, engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  const a = join(root, "a"), b = join(root, "b"), outside = join(root, "outside"), library = join(root, "library", "opencode");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "private", "server.json"), token: "fixture", hostToken: "fixture-host", workspaces: [a,b].map((path,index) => ({ id: index === 0 ? "a" : "b", name: "Matter", path, preset: "starter", workspaceType: "local" })), authorizedRoots: [a,b], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, engineProjectTrustRequired: true, engineConfigurationMode: "managed", startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  try {
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json"); process.env.XDG_CONFIG_HOME = join(root, "library");
    for (const path of [a,b,outside,library,join(library,"skills","shared"),join(library,"commands"),join(library,"agents"),join(library,"plugins","shared-tool")]) await mkdir(path, { recursive: true });
    await writeFile(join(library,"skills","shared","SKILL.md"), "---\nname: shared\ndescription: Shared native skill\n---\nShared instructions.\n");
    await writeFile(join(library,"commands","shared.md"), "---\ndescription: Shared command\n---\nShared command text.\n");
    await writeFile(join(library,"agents","global-helper.md"), "---\ndescription: Global helper\nmode: subagent\n---\nGlobal helper instructions.\n");
    await writeFile(join(library,"plugins","shared-tool","index.js"), `import{Plugin}from'@opencode/plugin';export default Plugin.define({id:'fixture.shared-tool',async setup(ctx){await ctx.tool.transform(editor=>editor.add({name:'shared_tool',description:'Shared fixture',input:{type:'object'},output:{type:'string'},async execute(){return {content:'ok',output:'ok'}}}));await ctx.rpc.register({id:'fixture.probe',methods:{tools:{input:{type:'object'},output:{type:'array',items:{type:'string'}}}},events:{}},{async tools(){return(await ctx.tool.list()).map(tool=>tool.name)}})}});`);
    const markers = [join(root,"parent-plugin-started"),join(root,"case-plugin-started"),join(root,"parent-mcp-started"),join(root,"case-mcp-started")];
    for (const [directory,index] of [[root,0],[a,1]] satisfies Array<[string,number]>) {
      const plugin = join(directory,"untrusted-plugin"); await mkdir(plugin);
      await writeFile(join(plugin,"index.js"), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(markers[index])},'executed');export default{id:'fixture.untrusted',setup(){}};`);
      await writeFile(join(directory,"opencode.json"), JSON.stringify({ plugins:[plugin],mcp:{servers:{untrusted:{type:'local',command:[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(markers[index+2])},'executed')`]}}}}));
    }
    const model = { name: "Shared reasoning model", capabilities: { tools: true, reasoning: { supported: true, effort: ["low","high"] } }, variants: [{ id: "deep", settings: { reasoningEffort: "high" } }], limit: { context: 128000, output: 8192 } };
    for (const id of ["a","b"]) await writeRuntimeOpencodeConfig(config,id,() => ({ provider:{ fixture:{ package:"@opencode/ai/providers/openai-compatible", settings:{apiKey:"synthetic",baseURL:`http://127.0.0.1:${id === "a" ? 7 : 8}/v1`},models:{shared:{...model,name:id === "a" ? "Case A model" : "Case B model"}} }, ...(id === "a" ? { custom:{ package:"@opencode/ai/providers/openai-compatible",settings:{apiKey:"synthetic",baseURL:"http://127.0.0.1:9/v1"},models:{custom:{capabilities:{reasoning:{supported:true}},variants:[{id:"custom",body:{temperature:0.4}}]}} } } : {}) }, providerActivation: { fixture: id === "a" ? "allow" : "deny" }, permission:{external_directory:{[join(root,id+"-allowed","*")]:"allow"}} }));
    await writeRuntimeOpencodeConfig(config,GLOBAL_TOOL_PERMISSIONS_ID,() => ({permission:{shell:"ask",webfetch:"deny"}}));
    await writeRuntimeOpencodeConfig(config,GLOBAL_MCP_ID,() => ({mcp:{shared:{type:"remote",url:"http://127.0.0.1:7/mcp",enabled:false}}}));
    await writeLegalworkRuntimeConfigFile(config,"a");
    for (const workspace of config.workspaces) expect(await engineProjectStatus(config,workspace)).toMatchObject({state:"ready",required:false,plugins:[]});
    expect(await readFile(join(a,"opencode.json"),"utf8")).toContain("untrusted-plugin"); expect(existsSync(join(b,"opencode.json"))).toBe(false);
    server = await startServer(config);
    engine = await createManagedOpencodeServer({bin:binary,cwd:root,timeoutMs:30000,env:{HOME:join(root,"home"),USERPROFILE:join(root,"home"),XDG_CONFIG_HOME:join(root,"engine-config"),XDG_DATA_HOME:join(root,"data"),XDG_STATE_HOME:join(root,"state"),XDG_CACHE_HOME:join(root,"cache"),OPENCODE_CONFIG_DIR:orgPolicyEngineDir(config),OPENCODE_CONFIG:legalworkRuntimeConfigFilePath(config),OPENCODE_CONFIG_CONTENT:await legalworkMandatoryRuntimeConfigContent(config),OPENCODE_DB:join(root,"engine.db"),OPENCODE_CONFIG_PROJECT_DISABLE:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",OPENCODE_DISABLE_MODELS_FETCH:"1",LEGALWORK_SERVER_URL:`http://127.0.0.1:${server.port}`,LEGALWORK_SERVER_TOKEN:config.token}});
    config.opencodeBaseUrl=engine.url;config.opencodeUsername=engine.username;config.opencodePassword=engine.password;
    const client=OpenCode.make({baseUrl:engine.url,headers:{authorization:`Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`}});
    const locationA={directory:a},locationB={directory:b};
    const modelsA=await client.model.list({location:locationA}),modelsB=await client.model.list({location:locationB});
    const plugins=await client.plugin.list({location:locationA});
    expect(plugins.data.filter(plugin=>plugin.state.status==="failed").map(plugin=>({id:plugin.id,state:plugin.state}))).toEqual([]);
    expect(plugins.data.map(plugin=>({id:plugin.id,state:plugin.state}))).toContainEqual(expect.objectContaining({id:"fixture.shared-tool"}));
    expect(modelsA.data.find(model=>model.providerID==="fixture"&&model.id==="shared")).toMatchObject({name:"Case A model",settings:{baseURL:"http://127.0.0.1:7/v1"},variants:expect.arrayContaining([{id:"deep",settings:{reasoningEffort:"high"}}])});
    expect(modelsA.data.find(model=>model.providerID==="custom"&&model.id==="custom")).toMatchObject({variants:[{id:"custom",body:{temperature:0.4}}]});
    expect(modelsB.data.some(model=>["fixture","custom"].includes(model.providerID))).toBe(false);
    for (const location of [locationA,locationB]) {
      const skills = (await client.skill.list({location})).data;
      expect(skills.map(skill=>skill.id)).toEqual(expect.arrayContaining(["shared", "docx-edit", "pdf-tools", "legalwork-help", "author-review-prompts", "start-tabular-review", "benchmark-task"]));
      const docx = skills.find(skill=>skill.id==="docx-edit");
      if (!docx) throw new Error("Bundled Word capability is missing");
      expect(await readFile(join(docx.path,"../assets/docx-agent.mjs"),"utf8")).toContain("docx");
      expect(docx.path.startsWith(a) || docx.path.startsWith(b)).toBe(false);
      expect((await client.agent.list({location})).data.map(agent=>agent.id)).toEqual(expect.arrayContaining(["global-helper", "document-extractor", "fusion-candidate", "docx-redliner"]));
      expect((await client.command.list({location})).data.map(command=>command.name)).toEqual(expect.arrayContaining(["shared", "edit-docx", "open", "annotate", "fill-form", "sign"]));
      expect((await client.rpc.call({location,rpcID:"fixture.probe",method:"tools",input:{}})).output).toContain("shared_tool");
      const session=await client.session.create({location,title:"Fresh unapproved matter",agent:"legalwork"});
      expect(session.id).toBeDefined();
    }
    const appResponse=await fetch(`http://127.0.0.1:${server.port}/workspace/a/config`,{headers:{authorization:`Bearer ${config.token}`}});
    expect(appResponse.status).toBe(200);expect(await appResponse.json()).toMatchObject({providerDisplay:{fixture:{editable:true,hasCustomEndpoint:true}}});
    const unknown=await client.session.create({location:{directory:outside},agent:"legalwork"});
    await expect(client.session.prompt({sessionID:unknown.id,text:"must be rejected",resume:false})).rejects.toThrow();
    expect(markers.map(path=>existsSync(path))).toEqual([false,false,false,false]);
  } finally {
    await engine?.close();await server?.stop();await closeRuntimeOpencodeConfig(config);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env,previous);
    await rm(root,{recursive:true,force:true});
  }
},60000);
