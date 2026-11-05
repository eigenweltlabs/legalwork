import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { prepareManagedOpencodeEngineDb, LEGACY_MANAGED_ENGINE_DB_FILENAME } from "./managed-opencode-db.js";
import type { ServerConfig,WorkspaceInfo } from "./types.js";
import { prepareSessionHistoryUndo,assertSessionHistoryReady } from "./session-history-undo.js";
import { readLegacyHistoryBackup } from "./history-v1-backup.js";
const nativeBinary=process.env.LEGALWORK_TEST_OPENCODE_BIN,legacyBinary=process.env.LEGALWORK_TEST_OPENCODE_V1_BIN;

/** Real released engines and local Git; no provider credentials or inference.
 * Thirty-second startup / sixty-second test watchdogs bound infrastructure only. */
test.skipIf(!nativeBinary || !legacyBinary)("released staged Undo: native chat cursor is restorable, partial/file Redo cannot be imported",async()=>{
  if(!nativeBinary || !legacyBinary)throw new Error("Both released binaries required");
  const root=await realpath(await mkdtemp(join(tmpdir(),"legalwork-undo-migration-")));
  for(const name of ["workspace","home","config","state","data","cache","tmp"])await mkdir(join(root,name));
  const workspace=join(root,"workspace"),source=join(root,"state",LEGACY_MANAGED_ENGINE_DB_FILENAME),file=join(workspace,"agreement.txt");
  const git=(...args:string[])=>execFileSync("git",args,{cwd:workspace,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  await writeFile(file,"BEFORE\n");git("init");git("add","agreement.txt");git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial");
  const password=randomBytes(32).toString("hex"),headers={authorization:`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,"content-type":"application/json"};
  const env={PATH:process.env.PATH,HOME:join(root,"home"),USERPROFILE:join(root,"home"),TMPDIR:join(root,"tmp"),XDG_CONFIG_HOME:join(root,"config"),XDG_DATA_HOME:join(root,"data"),XDG_CACHE_HOME:join(root,"cache"),XDG_STATE_HOME:join(root,"state"),OPENCODE_CONFIG_DIR:join(root,"config"),OPENCODE_DISABLE_MODELS_FETCH:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",OPENCODE_CONFIG_PROJECT_DISABLE:"1",OPENCODE_CONFIG_CONTENT:JSON.stringify({update:"disable"})};
  let legacy:ReturnType<typeof spawn>|undefined,native:Awaited<ReturnType<typeof createManagedOpencodeServer>>|undefined;
  const saved=new Map(["OPENCODE_DB","LEGALWORK_RUNTIME_DB","LEGALWORK_DEV_MODE","XDG_DATA_HOME"].map(key=>[key,process.env[key]]));
  async function start(){
    let output="";legacy=spawn(resolve(legacyBinary!),["serve","--hostname","127.0.0.1","--port","0"],{cwd:workspace,env:{...env,OPENCODE_DB:source,OPENCODE_SERVER_USERNAME:"opencode",OPENCODE_SERVER_PASSWORD:password},stdio:["ignore","pipe","pipe"]});
    legacy.stdout?.on("data",data=>output+=data);legacy.stderr?.on("data",data=>output+=data);
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){const url=/(?:opencode )?server listening on (https?:\/\/[^\s]+)/.exec(output)?.[1];if(url)return url;if(legacy.exitCode!==null)throw new Error("V1 fixture startup failed");await Bun.sleep(30);}throw new Error("V1 fixture startup watchdog expired");
  }
  async function stop(){if(legacy && legacy.exitCode===null){const done=new Promise(resolve=>legacy!.once("exit",resolve));legacy.kill("SIGTERM");await done;}legacy=undefined;}
  async function request(base:string,path:string,body?:unknown){const response=await fetch(`${base}${path}${path.includes("?")?"&":"?"}directory=${encodeURIComponent(workspace)}`,{method:body===undefined?"GET":"POST",headers,...(body===undefined?{}:{body:JSON.stringify(body)})});if(!response.ok)throw new Error(`V1 fixture ${path}: ${response.status}`);return response.json();}
  const sessions:Record<string,string>={};
  try{
    let base=await start();
    for(const kind of ["chat","partial","file"])sessions[kind]=String((await request(base,"/session",{title:`Undo ${kind}`})).id);
    await stop();
    const db=new Database(source);
    const message=db.prepare("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)"),part=db.prepare("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)");
    for(const [kind,id] of Object.entries(sessions)){
      for(const turn of [1,3])message.run(`msg_${kind}_${turn}`,id,turn*100,turn*100,JSON.stringify({role:"user",time:{created:turn*100},agent:"build",model:{providerID:"fixture",modelID:"fixture"}}));
      for(const turn of [2,4])message.run(`msg_${kind}_${turn}`,id,turn*100,turn*100+10,JSON.stringify({role:"assistant",time:{created:turn*100,completed:turn*100+10},parentID:`msg_${kind}_${turn-1}`,agent:"build",mode:"build",providerID:"fixture",modelID:"fixture",path:{cwd:workspace,root:workspace},cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}}}));
      for(const turn of [1,2,3,4])part.run(`prt_${kind}_${turn}_a`,`msg_${kind}_${turn}`,id,turn*100,turn*100,JSON.stringify({type:"text",text:`${kind.toUpperCase()}-TURN-${turn}`}));
      part.run(`prt_${kind}_4_b`,`msg_${kind}_4`,id,401,401,JSON.stringify({type:"text",text:"PARTIAL-SECOND-BLOCK"}));
    }
    db.close();base=await start();
    const chat=await request(base,`/session/${sessions.chat}/revert`,{messageID:"msg_chat_3"});
    expect(chat.revert.messageID).toBe("msg_chat_3");expect(chat.revert.diff).toBe("");
    const partial=await request(base,`/session/${sessions.partial}/revert`,{messageID:"msg_partial_4",partID:"prt_partial_4_b"});
    expect(partial.revert.partID).toBe("prt_partial_4_b");
    const beforeSnapshot=String(chat.revert.snapshot);expect(beforeSnapshot.length).toBeGreaterThan(0);
    await stop();
    const edit=new Database(source);edit.prepare("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)").run("prt_file_4_z","msg_file_4",sessions.file,402,402,JSON.stringify({type:"patch",hash:beforeSnapshot,files:[file]}));edit.close();
    await writeFile(file,"AFTER\n");base=await start();
    const revertedFile=await request(base,`/session/${sessions.file}/revert`,{messageID:"msg_file_3"});
    expect(await readFile(file,"utf8")).toBe("BEFORE\n");expect(revertedFile.revert.diff.length).toBeGreaterThan(0);
    await stop();
    delete process.env.OPENCODE_DB;delete process.env.LEGALWORK_DEV_MODE;process.env.LEGALWORK_RUNTIME_DB=join(root,"state","runtime.sqlite");process.env.XDG_DATA_HOME=join(root,"data");
    const config={configPath:join(root,"state","server.json")} as ServerConfig,prepared=await prepareManagedOpencodeEngineDb(config);
    if(!prepared)throw new Error("Managed copy required");
    native=await createManagedOpencodeServer({bin:resolve(nativeBinary),cwd:workspace,env:{...env,OPENCODE_DB:prepared.path},timeoutMs:30000,signal:AbortSignal.timeout(30000)});
    let client=OpenCode.make({baseUrl:native.url,headers:{authorization:`Basic ${Buffer.from(`${native.username}:${native.password}`).toString("base64")}`}});
    expect((await client.session.get({sessionID:sessions.chat})).revert).toBeUndefined();
    const workspaceInfo:WorkspaceInfo={id:"fixture",name:"Fixture",path:workspace,preset:"starter",workspaceType:"local"};
    const restored=await prepareSessionHistoryUndo(config,workspaceInfo,client,await client.session.get({sessionID:sessions.chat}));
    expect(restored.state?.status).toBe("restored");
    const staged=restored.session.revert;
    if(!staged)throw new Error("Native chat Undo state was not restored");
    expect(staged.messageID).toBe("msg_chat_3");expect(staged.files).toEqual([]);expect(staged.snapshot).toBe(beforeSnapshot);
    await native.close();native=await createManagedOpencodeServer({bin:resolve(nativeBinary),cwd:workspace,env:{...env,OPENCODE_DB:prepared.path},timeoutMs:30000,signal:AbortSignal.timeout(30000)});
    client=OpenCode.make({baseUrl:native.url,headers:{authorization:`Basic ${Buffer.from(`${native.username}:${native.password}`).toString("base64")}`}});
    expect((await client.session.get({sessionID:sessions.chat})).revert?.messageID).toBe("msg_chat_3");
    await client.session.revert.clear({sessionID:sessions.chat});
    expect((await prepareSessionHistoryUndo(config,workspaceInfo,client,await client.session.get({sessionID:sessions.chat}))).session.revert).toBeUndefined();
    expect(JSON.stringify(await client.session.context({sessionID:sessions.chat}))).toContain("CHAT-TURN-3");
    await client.session.revert.stage({sessionID:sessions.chat,messageID:"msg_chat_3",files:false});
    await client.session.revert.commit({sessionID:sessions.chat});
    expect(JSON.stringify(await client.session.context({sessionID:sessions.chat}))).not.toContain("CHAT-TURN-3");
    expect((await prepareSessionHistoryUndo(config,workspaceInfo,client,await client.session.get({sessionID:sessions.partial}))).state).toMatchObject({status:"unresolved",reason:"partial_part_revert_unsupported"});
    expect((await prepareSessionHistoryUndo(config,workspaceInfo,client,await client.session.get({sessionID:sessions.file}))).state).toMatchObject({status:"unresolved",reason:"file_redo_state_unsupported"});
    await expect(assertSessionHistoryReady(config,workspaceInfo,client,sessions.file)).rejects.toMatchObject({status:409,code:"history_undo_resolution_required"});
    expect((await client.session.get({sessionID:sessions.partial})).revert).toBeUndefined();
    // This deliberately demonstrates why cursor-only staging must not be
    // advertised as preservation of the old file Undo/Redo state.
    await client.session.revert.stage({sessionID:sessions.file,messageID:"msg_file_3",files:false});
    await client.session.revert.clear({sessionID:sessions.file});
    expect(await readFile(file,"utf8")).toBe("BEFORE\n");
    const exported=await client.session.export({sessionID:sessions.partial});
    const imported=await client.session.import({info:{...exported.info,id:"ses_undo_import_probe",revert:{messageID:"msg_partial_4",partID:"prt_partial_4_b",snapshot:beforeSnapshot,files:[]}},messages:[],location:exported.info.location});
    expect(imported.revert).toBeUndefined();
    const backup=await readLegacyHistoryBackup(config);
    if(!backup)throw new Error("Private original backup required");
    await chmod(backup.path,0o600);await writeFile(backup.path,"corrupted original fixture");
    expect((await prepareSessionHistoryUndo(config,workspaceInfo,client,await client.session.get({sessionID:sessions.chat}))).state).toMatchObject({status:"restored"});
    await expect(assertSessionHistoryReady(config,workspaceInfo,client,sessions.chat)).resolves.toBeDefined();
  }finally{await stop();await native?.close();for(const [key,value] of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});}
},60000);
