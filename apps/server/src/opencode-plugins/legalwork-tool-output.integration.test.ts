import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { z } from "zod";
import { nativeChatResponse, nativeDomainEngine } from "./native-domain-engine.test-support.js";
import { waitForNativeFixture } from "../native-mcp.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
for (const denied of [false, true]) test.skipIf(!binary)(`project output uses native read, grep and shell; read denied=${denied}`, async () => {
  if (!binary) throw new Error("A released engine is required");
  const payload = { result: "requested section in the saved output", rows: Array.from({ length: 1100 }, (_, index) => index === 300 ? "evidence beyond the retention preview" : "a".repeat(80)) };
  const offered: string[][] = [], readResults: string[] = [], grepResults: string[] = [], shellResults: string[] = [];
  let savedPath = "", sequence = 0, otherChat = false;
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/mcp") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const rpc = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(await request.json());
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      const result = rpc.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : rpc.method === "tools/list" ? { tools: [{ name: "large_output", description: "Return synthetic oversized data", inputSchema: { type: "object", properties: {} } }] }
        : rpc.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify(payload) }] } : {};
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    }
    const input = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(await request.json());
    const names = input.tools?.map(t => t.function.name) ?? []; offered.push(names);
    const results = input.messages.filter(m => m.role === "tool");
    const producer = names.find(name => name.includes("fixture") && name.includes("large_output"));
    let call: { name: string; input: unknown } | undefined;
    if (otherChat) {
      if (!results.length) call = { name: "read", input: { path: savedPath } };
      else readResults.push(JSON.stringify(results.at(-1)?.content));
    } else if (results.length === 0 && producer) call = { name: producer, input: {} };
    else if (results.length === 1) {
      const raw = JSON.stringify(results[0].content);
      savedPath = raw.match(/full output saved to ([^\s\\"\]]+)/i)?.[1] ?? "";
      call = { name: "read", input: { path: savedPath } };
    } else if (results.length === 2) {
      readResults.push(JSON.stringify(results.at(-1)?.content));
      if (!denied) call = { name: "grep", input: { pattern: "requested section", path: savedPath } };
    } else if (results.length === 3) {
      grepResults.push(JSON.stringify(results.at(-1)?.content));
      call = { name: "shell", input: { command: `grep -n 'requested section' '${savedPath}'`, description: "Search retained output" } };
    } else if (results.length === 4) shellResults.push(JSON.stringify(results.at(-1)?.content));
    return nativeChatResponse(call, sequence++);
  } });
  let host: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    host = await nativeDomainEngine({ binary, plugins: [join(import.meta.dir, "legalwork-tool-output.ts")], modelURL: fixture.url.origin + "/v1", configuration: {
      mcp: { servers: { fixture: { type: "remote", url: fixture.url.origin + "/mcp", oauth: false, codemode: false } } },
      permissions: [{ action: "*", resource: "*", effect: "allow" }, ...(denied ? [{ action: "read", resource: "*", effect: "deny" }] : [])],
    } });
    await waitForNativeFixture(host.tools, value => z.array(z.string()).parse(value).some(name => name.includes("large_output")), "oversized-result producer");
    const chat = await host.appClient.session.create({ location: host.location, agent: "build" });
    await host.appClient.session.prompt({ sessionID: chat.id, text: "Read and search the retained synthetic output." });
    await host.client.session.wait({ sessionID: chat.id }, { signal: AbortSignal.timeout(60000) });
    expect(savedPath).toContain(join(host.directory, ".legalwork", "tool-output", chat.id));
    expect(JSON.parse(await readFile(savedPath, "utf8"))).toEqual(payload);
    expect(offered.flat().filter(name => name.startsWith("legalwork_tool_output_"))).toEqual([]);
    if (denied) {
      expect(readResults.join(" ")).not.toContain(payload.result);
      expect(readResults.join(" ").toLowerCase()).toMatch(/denied|permission|no tool named/);
    } else {
      expect(readResults.join(" ")).toContain(payload.result);
      expect(readResults.join(" ")).toContain("evidence beyond the retention preview");
      expect(readResults.join(" ")).not.toContain("Preview shortened");
      expect(grepResults.join(" ")).toContain(payload.result);
      expect(shellResults.join(" ")).toContain(payload.result);
      otherChat = true;
      const sibling = await host.appClient.session.create({ location: host.location, agent: "build" });
      await host.appClient.session.prompt({ sessionID: sibling.id, text: "Read the saved result from another chat in this project." });
      await host.client.session.wait({ sessionID: sibling.id }, { signal: AbortSignal.timeout(60000) });
      expect(readResults).toHaveLength(2);
      expect(readResults[1]).toContain(payload.result);
      expect(await readdir(join(host.directory, ".legalwork", "tool-output", chat.id))).toHaveLength(1);
    }
    expect(await readdir(join(host.root, "data", "opencode", "tool-output")).catch(() => [])).toEqual([]);
  } finally { await host?.close(); fixture.stop(true); }
}, 90000);

test.skipIf(!binary)("real Code Mode filters full connector intermediates without spilling them", async () => {
  if (!binary) throw new Error("A released engine is required");
  let sequence = 0, path = "", complete = 0;
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/mcp") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const rpc = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(await request.json());
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      const result = rpc.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : rpc.method === "tools/list" ? { tools: [{ name: "large_output", description: "Synthetic large output", inputSchema: { type: "object", properties: {} } }] }
        : rpc.method === "tools/call" ? { content: [{ type: "text", text: "x".repeat(100000) }] } : {};
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    }
    const input = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) }).parse(await request.json());
    const results = input.messages.filter(message => message.role === "tool");
    let call: { name: string; input: unknown } | undefined;
    if (results.length === 0) call = { name: "execute", input: { code: "return search({query:'large_output',limit:1});" } };
    else if (results.length === 1) {
      path = JSON.stringify(results[0].content).match(/tools\.[a-zA-Z0-9_.]*large_output/)?.[0] ?? "";
      call = { name: "execute", input: { code: `const r=await ${path}({});return {complete:JSON.stringify(r).length};` } };
    } else {
      const raw = JSON.stringify(results.at(-1)?.content).replaceAll('\\"','"');
      complete = Number(raw.match(/"complete"\s*:\s*(\d+)/)?.[1] ?? 0);
    }
    return nativeChatResponse(call, sequence++);
  } });
  let host: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    host = await nativeDomainEngine({ binary, directTools: false, plugins: [join(import.meta.dir, "legalwork-tool-output.ts")], modelURL: fixture.url.origin + "/v1", configuration: {
      mcp: { servers: { fixture: { type: "remote", url: fixture.url.origin + "/mcp", oauth: false } } }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
    } });
    await waitForNativeFixture(host.tools, value => z.array(z.string()).parse(value).some(name => name.includes("large_output")), "code mode connector");
    const chat = await host.appClient.session.create({ location: host.location, agent: "build" });
    await host.appClient.session.prompt({ sessionID: chat.id, text: "Filter a large intermediate result in code." });
    await host.client.session.wait({ sessionID: chat.id }, { signal: AbortSignal.timeout(60000) });
    expect(path).toContain("large_output"); expect(complete).toBeGreaterThanOrEqual(100000);
    expect(await readdir(join(host.directory, ".legalwork", "tool-output")).catch(() => [])).toEqual([]);
    expect(await readdir(join(host.root, "data", "opencode", "tool-output")).catch(() => [])).toEqual([]);
  } finally { await host?.close(); fixture.stop(true); }
}, 90000);
