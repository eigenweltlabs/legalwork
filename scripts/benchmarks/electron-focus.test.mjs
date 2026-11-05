import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBenchmarkFocus } from "./electron-focus.mjs";

test("isolated focus authenticates and touches only the owned renderer's exact tab UI",async()=> {
  const root=await mkdtemp(join(tmpdir(),"legalwork-benchmark-focus-"));
  const app=new EventEmitter();let calls=0;let expression;
  const BrowserWindow={getAllWindows:()=>[
    {isDestroyed:()=>false,webContents:{getURL:()=>"",executeJavaScript:()=>{throw new Error("blank window");}}},
    {isDestroyed:()=>false,webContents:{getURL:()=>"http://127.0.0.1:9999",executeJavaScript:()=>{throw new Error("other renderer");}}},
    {isDestroyed:()=>false,webContents:{getURL:()=>"http://127.0.0.1:5373/workspace/test",executeJavaScript:code=>{calls++;expression=code;return true;}}},
  ]};
  await startBenchmarkFocus({app,BrowserWindow,root,rendererOrigin:"http://127.0.0.1:5373"});
  const path=join(root,"electron/legalwork-benchmark-ui-control.json");
  const connection=JSON.parse(await readFile(path,"utf8"));
  try {
    assert.equal((await stat(path)).mode&0o077,0);
    const request=(path,token,body)=>fetch(`${connection.baseUrl}${path}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
    assert.equal((await request("/focus-chat","wrong",{sessionID:"session"})).status,401);
    assert.equal(calls,0);
    assert.equal((await request("/arbitrary",connection.token,{sessionID:"session"})).status,404);
    assert.equal(calls,0);
    const sessionID='session-with-"-quotes';
    const response=await request("/focus-chat",connection.token,{sessionID});
    assert.deepEqual(await response.json(),{focused:true,mechanism:"actual-chat-tab-dom-click",inferenceCalls:0});
    assert.equal(calls,1);
    assert.ok(expression.includes(JSON.stringify(`chat:${sessionID}`)));
    assert.ok(expression.includes('button[aria-pressed]'));
    assert.ok(expression.includes("tab.click()"));
    assert.ok(!expression.includes("composer.send"));
    const args=["","benchmark-portable-renewal-review",[{path:"SKILL.md",contentBase64:"c2tpbGw=",executable:false},{path:"resources/renewal-archive.md",contentBase64:"cmVzb3VyY2U=",executable:false}],{overwrite:false}];
    assert.equal((await request("/install-skill-files",connection.token,{args})).status,200);
    assert.ok(expression.includes('invokeDesktop("installSkillFiles"'));
    assert.equal((await request("/install-skill-files",connection.token,{args:["/host/project",...args.slice(1)]})).status,400);
    assert.equal((await request("/install-skill-files",connection.token,{args:[...args.slice(0,3),{overwrite:true}]})).status,400);
    assert.equal((await request("/install-skill-files",connection.token,{args:["","other-skill",...args.slice(2)]})).status,400);
    assert.equal((await request("/install-skill-files",connection.token,{args:["",args[1],[{...args[2][0],path:"../private"},args[2][1]],args[3]]})).status,400);
  } finally {app.emit("will-quit");await rm(root,{recursive:true,force:true});}
});
