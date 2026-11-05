import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";
import { buildNativePluginFixture } from "./native-plugin-build.test-support.js";

test("packaged skill tools expose one native Plugin.define export and register JSON schemas",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"legalwork-skill-plugin-")),runtime=nativePluginTestRuntime(directory);
  try{
    // Bundling here verifies the module contract; real host identity is covered by
    // native-office-host.integration.test.ts with host-provided plugin/effect.
    const bundlePath=await buildNativePluginFixture(join(import.meta.dir,"legalwork-skill-tools.ts"),join(directory,"index.js"),{bundleRuntime:true});
    const module=await import(pathToFileURL(bundlePath).href);
    expect(Object.keys(module)).toEqual(["default"]);await runtime.start(module.default);
    expect([...runtime.tools.keys()]).toEqual(["legalwork_skill_load","legalwork_skill_read","legalwork_skill_create","legalwork_skill_list"]);
    for(const tool of runtime.tools.values())expect(tool.input).toMatchObject({type:"object"});
    const output:{system:Array<{type:"text";text:string}>}={system:[]};await runtime.hook("session","context",output);expect(output.system.map(item=>item.text).join("\n")).toContain("legalwork_skill_create");
  }finally{await runtime.close();await rm(directory,{recursive:true,force:true});}
});
