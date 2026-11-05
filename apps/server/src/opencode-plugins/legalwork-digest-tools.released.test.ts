import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { contentDigestInput, contentDigestOutput } from "../content-digest.js";
import { nativeMcpEngine } from "../native-mcp-engine.test-support.js";
import { nativeChatResponse } from "./native-domain-engine.test-support.js";
import { buildNativePluginFixture } from "./native-plugin-build.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const prefix = "ORIGINAL-SOURCE-🦉\r\n", tail = "DECISIVE-TAIL-Ω";
const code = "const original = await tools.fixture_content({}); const digest = await tools.legalwork_content_digest({data: original.data}); const otherAlgorithms = await Promise.allSettled(['sha384','sha512'].map(algorithm => tools.legalwork_content_digest({data: 'abc', algorithm}))); return {digest, otherAlgorithms};";

const scenarios = [{ denied: false, bodyBytes: 6 * 1024 * 1024 }, { denied: false, bodyBytes: 18 * 1024 * 1024 }, { denied: true, bodyBytes: 6 * 1024 * 1024 }];
for (const { denied, bodyBytes } of scenarios) test.skipIf(!binary)(`real native Code Mode digest preserves full bytes and provider context: ${denied ? "denied" : "allowed"} ${bodyBytes} bytes`, async () => {
  if (!binary) throw new Error("A released engine is required");
  const payload = prefix + "x".repeat(bodyBytes) + tail;
  const expected = createHash("sha256").update(payload).digest("hex");
  const wires: string[] = [], primaryWires: string[] = [];
  let sequence = 0, primaryCalls = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text(); wires.push(raw);
    const input = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(JSON.parse(raw));
    const primary = input.tools?.some(tool => tool.function.name === "execute") === true;
    if (primary) primaryWires.push(raw);
    return nativeChatResponse(primary && primaryCalls++ === 0 ? { name: "execute", input: { code } } : undefined, sequence++);
  } });
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  let fullObservations: unknown;
  let fullHistory: unknown;
  try {
    engine = await nativeMcpEngine(async root => {
      const plugin = join(root, "digest-plugin"), fixture = join(root, "fixture-plugin");
      await mkdir(plugin); await mkdir(fixture);
      await buildNativePluginFixture(join(import.meta.dir, "legalwork-digest-tools.ts"), join(plugin, "index.js"));
      const source = join(root, "fixture.ts");
      await writeFile(source, `import {Plugin} from "@opencode/plugin";
const source=${JSON.stringify(prefix)}+"x".repeat(${bodyBytes})+${JSON.stringify(tail)};
const observations=[];
export default Plugin.define({id:"digest-fixture",async setup(ctx){
await ctx.tool.transform(editor=>editor.add({name:"fixture_content",description:"Return the complete synthetic source",input:{type:"object",properties:{}},output:{type:"object",properties:{data:{type:"string"}},required:["data"]},async execute(){return{output:{data:source},content:"Complete structured source supplied to Code Mode."}}}));
await ctx.tool.hook("execute.after",event=>{if(event.tool==="legalwork_content_digest")observations.push(event)});
await ctx.rpc.register({id:"digest-fixture",methods:{observations:{input:{type:"object"},output:{type:"array",items:{type:"object",additionalProperties:true}}}},events:{}},{async observations(){return observations}});
}});`);
      await buildNativePluginFixture(source, join(fixture, "index.js"));
      return {
        plugins: [plugin, fixture], model: "fixture/fixture",
        permissions: [{ action: "*", resource: "*", effect: "allow" },
          ...(denied ? [{ action: "legalwork_content_digest", resource: "*", effect: "deny" }] : [])],
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: model.url.origin + "/v1", apiKey: "synthetic-fixture" },
          models: { fixture: { limit: { context: 128000, output: 4096 }, capabilities: { tools: true } } } } },
      };
    });
    const client = engine.client();
    await client.model.list({ location: engine.location });
    expect((await client.rpc.call({ location: engine.location, rpcID: "digest-fixture", method: "observations", input: {} })).output).toEqual([]);
    const session = await client.session.create({ location: engine.location, agent: "build" });
    await client.session.prompt({ sessionID: session.id, text: "Check the supplied synthetic content's exact checksum." });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
    const history = await client.session.context({ sessionID: session.id }); fullHistory = history;
    fullObservations = (await client.rpc.call({ location: engine.location, rpcID: "digest-fixture", method: "observations", input: {} })).output;
    const observations = z.array(z.object({ tool: z.string(), status: z.string(), input: contentDigestInput,
      result: z.object({ output: contentDigestOutput }).optional(),
    }).passthrough()).parse(fullObservations);
    const executed = history.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool").filter(part => part.name === "execute") : []);
    expect(executed).toHaveLength(1);
    expect(executed[0].state.status).toBe("completed");
    if (executed[0].state.status !== "completed") throw new Error("Controlled native execution did not settle");
    const text = executed[0].state.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    expect(primaryWires).toHaveLength(2);
    const systems = primaryWires.map(raw => z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
      .parse(JSON.parse(raw)).messages.filter(message => message.role === "system"));
    expect(systems[0].length).toBeGreaterThan(0);
    expect(systems[0]).toEqual(systems[1]);
    expect(JSON.stringify(systems[0])).toContain("legalwork_content_digest");
    expect(primaryWires.join("")).not.toContain(prefix);
    expect(primaryWires.join("")).not.toContain("x".repeat(1000));
    if (denied) {
      expect(observations.filter(event => event.status === "completed")).toHaveLength(0);
      expect(text).not.toContain(expected);
      expect(text.toLowerCase()).toMatch(/denied|permission|not available|unknown tool|not found/);
    } else {
      expect(observations).toHaveLength(3);
      const full = observations.find(event => event.input.data === payload);
      expect(full?.status).toBe("completed");
      expect(full?.result?.output).toEqual({ algorithm: "sha256", encoding: "utf8", bytes: Buffer.byteLength(payload), hex: expected });
      const otherAlgorithms: Array<"sha384" | "sha512"> = ["sha384", "sha512"];
      for (const algorithm of otherAlgorithms) {
        const small = observations.find(event => event.input.algorithm === algorithm);
        expect(small?.status).toBe("completed");
        expect(small?.input.data).toBe("abc");
        expect(small?.result?.output).toEqual({ algorithm, encoding: "utf8", bytes: 3, hex: createHash(algorithm).update("abc").digest("hex") });
      }
      expect(text).toContain(expected);
      expect(primaryWires[1]).toContain(expected);
    }
  } finally {
    const evidenceRoot = process.env.LEGALWORK_TEST_EVIDENCE_DIR;
    if (evidenceRoot) {
      const directory = join(evidenceRoot, `${denied ? "denied" : "allowed"}-${bodyBytes}`); await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "complete-provider-requests.json"), JSON.stringify(wires, null, 2), { mode: 0o600 });
      await writeFile(join(directory, "complete-native-observations.json"), JSON.stringify(fullObservations ?? null, null, 2), { mode: 0o600 });
      await writeFile(join(directory, "complete-public-history.json"), JSON.stringify(fullHistory ?? null, null, 2), { mode: 0o600 });
    }
    await engine?.close(); model.stop(true);
  }
}, 90_000);
