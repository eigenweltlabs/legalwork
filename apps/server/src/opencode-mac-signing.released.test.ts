import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { buildNativePluginFixture } from "./opencode-plugins/native-plugin-build.test-support.js";

const evidence = process.env.LEGALWORK_MAC_SIGNED_ACCEPTANCE_DIR;
// Only the manual signing job supplies this gate after independent native
// signature/certificate verification. Ordinary suites do not claim signed proof.
test.skipIf(!evidence)("signed engine executes optimizing JIT and an existing native N-API addon in its own process", async () => {
  if (!evidence || !process.env.LEGALWORK_TEST_OPENCODE_BIN) throw new Error("Verified signed engine and a fresh evidence directory are required");
  expect(process.platform).toBe("darwin");
  const output = join(evidence, "jit-native"); await mkdir(output);
  const canvas = createRequire(import.meta.url).resolve("@napi-rs/canvas");
  const engine = await nativeMcpEngine(async root => {
    const plugin = join(root, "plugin"), source = join(root, "probe.ts"); await mkdir(plugin);
    // Public Bun diagnostics: optimizeNextInvocation is asynchronous; the
    // documented counter is the readiness barrier, not a sleep. 1000000 means
    // JIT disabled and must not count as successful compilation.
    await writeFile(source, `import{Plugin}from'@opencode/plugin';import{optimizeNextInvocation,numberOfDFGCompiles}from'bun:jsc';
      export default Plugin.define({id:'fixture.signed-runtime',async setup(ctx){
        await ctx.rpc.register({id:'fixture.signed-runtime',methods:{probe:{input:{type:'object'},output:{type:'object',additionalProperties:true}}},events:{}},{async probe(){
          function add(a,b){return a+b}let value=0,calls=0;
          for(let i=0;i<10000;i++){value=add(value,1);calls++}
          optimizeNextInvocation(add);
          while(numberOfDFGCompiles(add)===0){value=add(value,1);calls++}
          const compiles=numberOfDFGCompiles(add);
          process.env.DISABLE_SYSTEM_FONTS_LOAD='1';
          async function loadInstalledNative(specifier){return import(specifier)}
          const{createCanvas}=await loadInstalledNative(${JSON.stringify(canvas)}),surface=createCanvas(1,1),context=surface.getContext('2d');
          context.fillStyle='#123456';context.fillRect(0,0,1,1);
          return{pid:process.pid,arch:process.arch,bun:process.versions.bun,compiles,value,calls,pixel:Array.from(context.getImageData(0,0,1,1).data)};
        }});
      }});`);
    await buildNativePluginFixture(source, join(plugin, "index.js"));
    return { plugins: [plugin] };
  });
  try {
    const client = engine.client(); await client.model.list({ location: engine.location });
    const info = await client.server.info();
    const result = (await client.rpc.call({ location: engine.location, rpcID: "fixture.signed-runtime", method: "probe", input: {} })).output;
    await writeFile(join(output, "result.json"), JSON.stringify({ info, result }, null, 2) + "\n");
    const probe = z.object({ pid: z.number(), arch: z.string(), bun: z.string(), compiles: z.number(), value: z.number(), calls: z.number(), pixel: z.array(z.number()) }).parse(result);
    expect(probe.pid).toBe(info.pid); expect(probe.arch).toBe(process.arch); expect(probe.bun).toBe("1.4.4");
    expect(probe.compiles).not.toBe(1000000); expect(probe.compiles).toBeGreaterThan(0);
    expect(probe.value).toBe(probe.calls); expect(probe.pixel).toEqual([18, 52, 86, 255]);
  } finally { await engine.close(); }
}, 60_000);
