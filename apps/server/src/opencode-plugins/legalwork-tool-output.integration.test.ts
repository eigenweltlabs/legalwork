import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { listEngineMessages, listEngineSessions } from "../engine-client.js";
import { waitForNativeFixture } from "../native-mcp.test-support.js";
import { nativeChatResponse, nativeDomainEngine } from "./native-domain-engine.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const cases = [
  { name: "allowed", denied: [], available: true, permitted: true },
  { name: "read denied", denied: ["read"], available: true, permitted: false },
  { name: "tool denied", denied: ["legalwork_tool_output_read"], available: false, permitted: false },
  { name: "wildcard denied", denied: ["*"], available: false, permitted: false },
];

for (const scenario of cases) test.skipIf(!binary)(`bundled saved-output retrieval through a native explore child: ${scenario.name}`, async () => {
  if (!binary) throw new Error("A released engine is required");
  const offered: string[][] = [], childTools: string[][] = [], recovered: string[] = [];
  const payload = JSON.stringify({ padding: "a".repeat(80000), result: "requested section beyond the long line" });
  const evidence = process.env.LEGALWORK_TEST_TOOL_OUTPUT_EVIDENCE_DIRECTORY
    ? join(process.env.LEGALWORK_TEST_TOOL_OUTPUT_EVIDENCE_DIRECTORY, scenario.name.replaceAll(" ", "-")) : undefined;
  if (evidence) await mkdir(evidence, { recursive: true, mode: 0o700 });
  let savedPath = "", sequence = 0, wireSequence = 0, sessionID: string | undefined;
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = Buffer.from(await request.arrayBuffer());
    const wire = evidence ? join(evidence, `controlled-wire-${String(++wireSequence).padStart(4, "0")}`) : undefined;
    if (wire) await writeFile(`${wire}.request.raw`, body);
    const respond = async (response: Response) => {
      if (wire) {
        await writeFile(`${wire}.response.raw`, Buffer.from(await response.clone().arrayBuffer()));
        await writeFile(`${wire}.json`, JSON.stringify({ method: request.method, url: request.url, status: response.status,
          requestHeaders: [...request.headers].filter(([name]) => !["authorization", "cookie", "x-api-key"].includes(name)),
          responseHeaders: [...response.headers],
        }, null, 2));
      }
      return response;
    };
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return respond(new Response(null, { status: 405 }));
      const rpc = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(JSON.parse(body.toString("utf8")));
      if (rpc.id === undefined) return respond(new Response(null, { status: 202 }));
      const result = rpc.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : rpc.method === "tools/list" ? { tools: [{ name: "large_output", description: "Return a synthetic large output", inputSchema: { type: "object", properties: {} } }] }
        : rpc.method === "tools/call" ? { content: [{ type: "text", text: payload }] } : {};
      return respond(Response.json({ jsonrpc: "2.0", id: rpc.id, result }));
    }
    const input = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(JSON.parse(body.toString("utf8")));
    const names = input.tools?.map(tool => tool.function.name) ?? [];
    if (names.length) offered.push(names);
    const toolResults = input.messages.filter(message => message.role === "tool");
    const isExplore = input.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Inspect saved response marker"));
    if (isExplore) childTools.push(names);
    const producer = names.find(name => name.includes("fixture") && name.includes("large_output"));
    let call: { name: string; input: unknown } | undefined;
    if (!isExplore && producer && toolResults.length === 0) call = { name: producer, input: {} };
    else if (!isExplore && producer && toolResults.length === 1) {
      const output = JSON.stringify(toolResults[0]?.content);
      savedPath = output.match(/full output saved to:? ([^\s\\"\]]+)/i)?.[1] ?? "";
      call = { name: "subagent", input: { description: "Inspect saved response", agent: "explore", prompt: `Inspect saved response marker. Use legalwork_tool_output_read to search the saved output at ${savedPath} for requested section.` } };
    } else if (isExplore && names.includes("legalwork_tool_output_read") && toolResults.length === 0) {
      call = { name: "legalwork_tool_output_read", input: { outputPath: savedPath, query: "requested section" } };
    } else if (isExplore && toolResults.length) recovered.push(JSON.stringify(toolResults));
    return respond(nativeChatResponse(call, sequence++));
  } });
  let engine: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    engine = await nativeDomainEngine({ binary, scopedRuntime: true, evidenceDirectory: evidence,
      plugins: [join(import.meta.dir, "legalwork-tool-output.ts")], modelURL: fixture.url.origin + "/v1", configuration: {
      mcp: { servers: { fixture: { type: "remote", url: fixture.url.origin + "/mcp", oauth: false, codemode: false } } },
      // Native config appends these to Explore's own deny-* boundary, matching
      // LegalWork's saved-output default and preserving explicit later denials.
      permissions: [
        ...["legalwork_tool_output_read", "read", "subagent"].map(action => ({ action, resource: "*", effect: "allow" })),
        ...scenario.denied.map(action => ({ action, resource: "*", effect: "deny" })),
      ],
      agents: { build: { permissions: [{ action: "*large_output*", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "allow" }] } },
    } });
    const { client, appClient, location } = engine;
    // Observe the actual native catalog, rather than masking the independently
    // tracked upstream first-turn MCP reconciliation race with a sleep.
    await waitForNativeFixture(engine.tools, value => z.array(z.string()).parse(value).some(name => name.includes("fixture") && name.includes("large_output")), "initial oversized-result producer");
    const session = await appClient.session.create({ location, agent: "build" });
    sessionID = session.id;
    await appClient.session.prompt({ sessionID: session.id, text: "Inspect the synthetic oversized connector result through a child agent." });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
    const history = await client.session.context({ sessionID: session.id });
    expect(savedPath, JSON.stringify(history)).toContain("tool-output");
    expect(offered.some(names => names.some(name => name.includes("fixture") && name.includes("large_output")))).toBe(true);
    expect(childTools.length).toBeGreaterThan(0);
    expect(childTools.some(names => names.includes("legalwork_tool_output_read"))).toBe(scenario.available);
    const children = (await listEngineSessions(client, { directory: location.directory })).filter(child => child.parentID === session.id);
    expect(children).toHaveLength(1); expect(children[0].agent).toBe("explore"); expect(children[0].location.directory).toBe(location.directory);
    if (scenario.permitted) {
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toContain("requested section beyond the long line");
      expect(recovered[0]).toContain('\\"found\\":true');
    } else {
      expect(recovered.join(" ")).not.toContain("requested section beyond the long line");
      if (scenario.available) { expect(recovered).toHaveLength(1); expect(recovered[0].toLowerCase()).toMatch(/permission|denied/); }
    }
  } finally {
    try {
      if (engine && evidence) {
        const sessions = await listEngineSessions(engine.client, { directory: engine.directory });
        await writeFile(join(evidence, "sessions.json"), JSON.stringify(sessions, null, 2));
        for (const session of sessions) await writeFile(join(evidence, `history-${session.id}.json`), JSON.stringify(await listEngineMessages(engine.client, session.id), null, 2));
        await writeFile(join(evidence, "scenario.json"), JSON.stringify({ scenario, sessionID, savedPath, offered, childTools, recovered }, null, 2));
      }
    } finally { await engine?.close(); fixture.stop(true); }
  }
}, 90_000);
