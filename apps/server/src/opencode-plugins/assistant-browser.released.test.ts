import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { nativeChatResponse, nativeDomainEngine } from "./native-domain-engine.test-support.js";
import { ASSISTANT_BROWSER_AGENT, ASSISTANT_BROWSER_WORKER_INSTRUCTIONS } from "../assistant-browser.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "../eigenwelt-auth.js";

// The controlled model deliberately requests the cheap model and foreground
// browsing. Exercise native subagent execution and nested Code Mode tool hooks.
for (const browser of [
  { providerID: "eigenwelt", id: "Eigenwelt Europe GPT Terra", name: "GPT-6.1 Terra (EU)" },
  { providerID: "eigenwelt", id: "Eigenwelt Europe Claude Sonnet", name: "Claude Sonnet 5.5 (EU)" },
  { providerID: "eigenwelt", id: "Eigenwelt Europe Gemini", name: "Gemini 3.8 Flash (EU)" },
]) test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)(`released engine selects available ${browser.name} and keeps worker tabs in the background`, async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-browser-fixture-"));
  const source = join(root, "fixture.ts");
  await writeFile(source, `import {Plugin} from "@opencode/plugin";
const opened=[];
export default Plugin.define({id:"browser-fixture",async setup(ctx){
await ctx.tool.transform(editor=>{
editor.add({name:"legalwork_browser_open_url",options:{codemode:true},description:"Open a browser tab",input:{type:"object",properties:{show:{type:"boolean"}}},output:{type:"object",additionalProperties:true},async execute(input,context){opened.push({input,sessionID:context.sessionID});return{output:{tabID:"actual-worker-tab"},content:"Opened"}}});
});
await ctx.rpc.register({id:"browser-fixture",methods:{opened:{input:{type:"object"},output:{type:"array",items:{type:"object",additionalProperties:true}}}},events:{}},{async opened(){return opened}});
}});`);
  const calls = new Map<string, number>();
  let directAttempt = false;
  const model = Bun.serve({ port: 0, async fetch(request) {
    const body = z.object({ model: z.string(), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).default([]) }).parse(await request.json());
    if (!body.tools.length) return nativeChatResponse(undefined, 0);
    const index = calls.get(body.model) ?? 0; calls.set(body.model, index + 1);
    const first = body.model === "fixture" && !directAttempt ? { name: "subagent", input: { agent: ASSISTANT_BROWSER_AGENT, description: "Read website", prompt: "Read the supplied website in the background", model: "fixture/fixture", background: false } }
      : { name: "execute", input: { code: "return await tools.legalwork_browser_open_url({show:true});" } };
    return nativeChatResponse(index === 0 ? first : undefined, index + 1);
  } });
  let host: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    host = await nativeDomainEngine({ binary: process.env.LEGALWORK_TEST_OPENCODE_BIN!, modelURL: model.url.origin + "/v1", directTools: false,
      plugins: [resolve(import.meta.dir, "legalwork-assistant-tools.ts"), source],
      configuration: {
        agents: { legalwork: { mode: "primary" }, [ASSISTANT_BROWSER_AGENT]: { mode: "subagent", system: ASSISTANT_BROWSER_WORKER_INSTRUCTIONS } },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: model.url.origin + "/v1", apiKey: "synthetic-fixture" }, models: {
          fixture: { limit: { context: 128000, output: 4096 }, capabilities: { tools: true } },
        } }, [browser.providerID]: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: model.url.origin + "/v1", apiKey: "synthetic-fixture" }, models: {
          [browser.id]: { name: browser.name, limit: { context: 128000, output: 4096 }, capabilities: { tools: true } },
        } } },
        policies: [{ action: "provider.use", resource: "*", effect: "deny" }, ...["fixture", browser.providerID].map(resource => ({ action: "provider.use", resource, effect: "allow" }))],
      },
      setup: async config => {
        config.workspaces[0].preset = "main-assistant";
        await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active" }) });
      },
    });
    const parent = await host.appClient.session.create({ location: host.location, agent: "legalwork", model: { providerID: "fixture", id: "fixture" } });
    await host.appClient.session.prompt({ sessionID: parent.id, text: "Read this website." });
    await host.appClient.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(20000) });
    const children = (await host.appClient.session.list({ parentID: parent.id })).data;
    expect(children).toHaveLength(1);
    const child = children[0];
    expect(child.agent).toBe(ASSISTANT_BROWSER_AGENT);
    expect(child.model).toMatchObject({ providerID: browser.providerID, id: browser.id });
    await host.appClient.session.wait({ sessionID: child.id }, { signal: AbortSignal.timeout(20000) });
    expect(calls.get(browser.id)).toBeGreaterThanOrEqual(2);
    const opened = await host.client.rpc.call({ location: host.location, rpcID: "browser-fixture", method: "opened", input: {} });
    expect(opened.output).toEqual([{ input: { show: false }, sessionID: child.id }]);
    // The same browser tool cannot run from the coordinator, even via Code Mode.
    directAttempt = true;
    calls.set("fixture", 0);
    await host.appClient.session.prompt({ sessionID: parent.id, text: "Try direct browser work" });
    await host.appClient.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(20000) });
    expect((await host.client.rpc.call({ location: host.location, rpcID: "browser-fixture", method: "opened", input: {} })).output).toEqual(opened.output);
    expect(JSON.stringify(await host.appClient.session.context({ sessionID: parent.id }))).toContain("Delegate browser work");
    const unavailable = await fetch(`${host.serverURL}/assistant/settings`, { method: "PATCH", headers: { authorization: `Bearer ${host.config.token}`, "x-legalwork-host-token": host.config.hostToken, "content-type": "application/json" }, body: JSON.stringify({ systemPromptAddition: "", resourceIds: [], projectAccess: { mode: "all", projectIds: [] }, browserModel: { providerID: "missing", modelID: "capable-model" } }) });
    expect(unavailable.ok).toBe(true);
    directAttempt = false; calls.set("fixture", 0);
    await host.appClient.session.prompt({ sessionID: parent.id, text: "Browse with the newly selected model" });
    await host.appClient.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(20000) });
    expect((await host.appClient.session.list({ parentID: parent.id })).data).toHaveLength(1);
    expect(JSON.stringify(await host.appClient.session.context({ sessionID: parent.id }))).toContain("selected browser model is unavailable");
  } finally { await host?.close(); model.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60000);
