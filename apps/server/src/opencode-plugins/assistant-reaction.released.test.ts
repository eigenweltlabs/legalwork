import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";
import { nativeChatResponse, nativeDomainEngine } from "./native-domain-engine.test-support.js";
import { ASSISTANT_REACTION_POLICY } from "./legalwork-assistant-tools.js";
import { codeModeWidgetResults } from "@legalwork/types/chat-tool-results";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "../eigenwelt-auth.js";
import { assistantEngineClient } from "../assistant-engine.js";

const scenarios = [
  { code: 'return await tools.legalwork_assistant_react({emoji:"❤️"});', reaction: true },
  { code: 'await tools.legalwork_assistant_react({emoji:"❤️"}); return "done";', reaction: true },
  { code: 'await tools.legalwork_assistant_react({emoji:"❤️"}); throw new Error("later script failure");', reaction: true },
  { code: 'await tools.legalwork_assistant_projects({}); return await tools.legalwork_assistant_react({emoji:"❤️"});', reaction: false, error: "first action" },
  { code: 'return await tools.legalwork_assistant_react({emoji:"❤️"});', reaction: false, deny: true },
  { code: 'return await Promise.allSettled([tools.legalwork_assistant_delegate({projectId:"missing",title:"Review",prompt:"Review for provider",scope:"Provider review",conversationLanguage:"en"}), tools.legalwork_assistant_attention_present({workspaceId:"matter",sessionId:"missing",id:"question",revision:"1",title:"Choose",description:"Choose the review perspective"}), tools.legalwork_assistant_attention_answer({workspaceId:"matter",sessionId:"missing",id:"question",revision:"1",answers:[["Provider"]]})]);', reaction: false,
    tools: ["legalwork_assistant_delegate", "legalwork_assistant_attention_present", "legalwork_assistant_attention_answer"] },
];
for (const scenario of scenarios)
test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)(`native Code Mode reaction: ${JSON.stringify(scenario)}`, async () => {
  const requests: string[][] = [];
  const prompts: string[] = [];
  const model = Bun.serve({ port: 0, async fetch(request) {
    const body = z.object({ messages: z.array(z.unknown()), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).default([]) }).parse(await request.json());
    if (!body.tools.length) return nativeChatResponse(undefined, 0);
    requests.push(body.tools.map(tool => tool.function.name));
    prompts.push(JSON.stringify(body.messages));
    return nativeChatResponse(requests.length === 1 ? { name: "execute", input: { code: scenario.code } } : undefined, requests.length);
  } });
  let host: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    host = await nativeDomainEngine({ binary: process.env.LEGALWORK_TEST_OPENCODE_BIN!, modelURL: model.url.origin + "/v1", directTools: false,
      plugins: [resolve(import.meta.dir, "legalwork-assistant-tools.ts")],
      configuration: { agents: { legalwork: { mode: "primary" } }, permissions: [{ action: "*", resource: "*", effect: "allow" }, ...(scenario.deny ? [{ action: "legalwork_assistant_react", resource: "*", effect: "deny" }] : [])] },
      setup: async config => { config.workspaces[0].preset = "main-assistant"; await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active" }) }); },
    });
    const session = await host.appClient.session.create({ location: host.location, agent: "legalwork", model: { providerID: "fixture", id: "fixture" } });
    const admission = await host.appClient.session.prompt({ sessionID: session.id, text: "Hi, good morning!" });
    await host.appClient.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20000) });
    expect(requests[0]).toContain("execute");
    expect(prompts[0]).toContain("legalwork_assistant_react");
    expect(prompts[0]).toContain(JSON.stringify(ASSISTANT_REACTION_POLICY).slice(1, -1));
    const history = await assistantEngineClient(host.appClient, host.directory).session.messages({ sessionID: session.id });
    const reaction = history.data?.flatMap(message => message.parts).find(part => part.type === "tool" && part.tool === "execute");
    if (reaction?.type !== "tool" || reaction.state.status !== "completed") throw new Error("Reaction did not complete");
    const widgets = codeModeWidgetResults(reaction.callID, reaction.state.metadata, reaction.state.output);
    if (scenario.reaction) expect(widgets, reaction.state.output).toMatchObject([{ tool: "legalwork_assistant_react", output: { ok: true, reaction: { emoji: "❤️", messageId: admission.id } } }]);
    else expect(widgets, reaction.state.output).toEqual([]);
    if (scenario.error) expect(reaction.state.output).toContain(scenario.error);
    if (!scenario.deny) expect(reaction.state.output).not.toContain("Unknown tool");
    const calls = z.array(z.object({ tool: z.string(), status: z.string() })).parse(reaction.state.metadata.toolCalls);
    // Native policy intentionally removes denied tools from the Code Mode inventory.
    if (scenario.deny) { expect(calls).toEqual([]); expect(reaction.state.output).toContain("Unknown tool"); }
    if (scenario.tools) expect(calls.map(call => call.tool)).toEqual(scenario.tools);
  } finally { await host?.close(); model.stop(true); }
}, 60000);

for (const directTools of [false, true])
test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN)(`ordinary project sessions never expose Assistant reactions (directTools=${directTools})`, async () => {
  const prompts: string[] = [];
  const requests: string[][] = [];
  const model = Bun.serve({ port: 0, async fetch(request) {
    const body = z.object({ messages: z.array(z.unknown()), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).default([]) }).parse(await request.json());
    if (!body.tools.length) return nativeChatResponse(undefined, 0);
    prompts.push(JSON.stringify(body.messages));
    requests.push(body.tools.map(tool => tool.function.name));
    return nativeChatResponse(!directTools && requests.length === 1
      ? { name: "execute", input: { code: 'return await tools.legalwork_assistant_react({emoji:"❤️"});' } }
      : undefined, requests.length);
  } });
  let host: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    host = await nativeDomainEngine({ binary: process.env.LEGALWORK_TEST_OPENCODE_BIN!, modelURL: model.url.origin + "/v1", directTools,
      plugins: [resolve(import.meta.dir, "legalwork-assistant-tools.ts")],
      configuration: { agents: { legalwork: { mode: "primary" } }, permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    });
    const session = await host.appClient.session.create({ location: host.location, agent: "legalwork", model: { providerID: "fixture", id: "fixture" } });
    await host.appClient.session.prompt({ sessionID: session.id, text: "Hello, hello." });
    await host.appClient.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20000) });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).not.toContain("legalwork_assistant_");
    expect(prompts[0]).not.toContain("main LegalWork assistant");
    expect(requests[0].some(name => name.startsWith("legalwork_assistant_"))).toBe(false);
    if (!directTools) {
      const history = await assistantEngineClient(host.appClient, host.directory).session.messages({ sessionID: session.id });
      const call = history.data?.flatMap(message => message.parts).find(part => part.type === "tool" && part.tool === "execute");
      if (call?.type !== "tool" || call.state.status !== "completed") throw new Error("Code Mode probe did not complete");
      expect(call.state.output).toContain("Unknown tool");
      expect(codeModeWidgetResults(call.callID, call.state.metadata, call.state.output)).toEqual([]);
      expect(call.state.metadata?.toolCalls).toEqual([]);
    }
  } finally { await host?.close(); model.stop(true); }
}, 60000);
