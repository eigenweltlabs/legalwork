import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeDomainEngine } from "../src/opencode-plugins/native-domain-engine.test-support.js";
import { projectMessage } from "@legalwork/types/opencode-view";
import { z } from "zod";

const mode = z.enum(["fixed", "recover", "transport-fixed"]).parse(process.env.SUPPORT_AGENT_MODE ?? "fixed");
const toolCase = z.enum(["saved-output", "native", "mcp", "word"]).parse(process.env.SUPPORT_AGENT_CASE ?? "saved-output");
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
if (!binary) throw new Error("Set LEGALWORK_TEST_OPENCODE_BIN to the OpenCode binary to test.");
const output = process.env.SUPPORT_REPRO_DIR;
if (!output) throw new Error("Set SUPPORT_REPRO_DIR.");
const root = join(output, `agent-${mode}`);
await mkdir(root, { recursive: true });
const nested = process.env.SUPPORT_AGENT_CODEMODE === "1";
const message = z.object({ role: z.string(), content: z.unknown() }).passthrough();
const requestSchema = z.object({ messages: z.array(message), tools: z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough()).optional() }).passthrough();
const requests: { child: boolean; tools: string[]; step: number; recoveryWarning?: boolean; finalRecoveryWarning?: boolean }[] = [];
let invalidCalls = 0;
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const address = new URL(request.url);
  if (address.pathname === "/mcp") {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const rpc = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string() }).parse(await request.json());
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result = rpc.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : rpc.method === "tools/list" ? { tools: [{ name: "large_output", description: "Produce the synthetic saved output to inspect", inputSchema: { type: "object", properties: {} } }, { name: "validate", description: "Synthetic argument validation: supply an integer limit of at least 1.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1 } }, required: ["limit"] } }] }
      : toolCase === "mcp" ? { isError: true, content: [{ type: "text", text: "MCP error -32602: limit must be an integer of at least 1" }] } : { content: [{ type: "text", text: JSON.stringify({ padding: "a".repeat(80000), verification_marker: "SUPPORT_AGENT_TAIL_748261" }) }] };
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  }
  const input = requestSchema.parse(await request.json());
  if (mode.startsWith("transport")) { requests.push({child:false,tools:[],step:requests.length+1}); return Response.json({error:{code:requests.length>8?"fixture_stop":"request_too_large",message:"Request body too large",max_request_bytes:31457280}},{status:requests.length>8?400:413}); }
  const tools = input.tools?.map(tool => tool.function.name) ?? [];
  const child = input.messages.some(item => item.role === "user" && JSON.stringify(item.content).includes("CHILD_GUARD"));
  const recoveryWarning = input.messages.some(item => item.role === "tool" && JSON.stringify(item.content).includes("three further assistant steps"));
  const finalRecoveryWarning = input.messages.some(item => item.role === "tool" && JSON.stringify(item.content).includes("Final warning: one retry remains."));
  requests.push({ child, tools, step: requests.length + 1, recoveryWarning, finalRecoveryWarning });
  const results = input.messages.filter(item => item.role === "tool");
  const failing = child && invalidCalls < 12 && !(mode === "recover" && recoveryWarning);
  if (failing) invalidCalls++;
  const call = !tools.length ? undefined : failing
    ? toolCase === "word" ? { name: "inapp_docx_read_document", arguments: JSON.stringify({ path: "test-file.docx", view: "invalid-test-view" }) } : toolCase === "native" ? { name: "read", arguments: JSON.stringify({ path: 42 }) } : toolCase === "mcp" ? { name: "fixture_validate", arguments: JSON.stringify({ limit: 0 }) } : { name: "legalwork_tool_output_read", arguments: JSON.stringify({ outputPath: "" }) }
    : !child && tools.includes("subagent") && !results.length
      ? { name: "subagent", arguments: JSON.stringify({ description: "Check the argument-loop guard", agent: "general", background: false, prompt: "CHILD_GUARD: exercise the synthetic invalid-input tool fixture." }) } : undefined;
  const effectiveCall = nested && call && call.name !== "subagent"
    ? { name: "execute", arguments: JSON.stringify({ code: `return await tools.${call.name}(${call.arguments});` }) } : call;
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", ...(effectiveCall ? { tool_calls: [{ index: 0, id: `fixture_${requests.length}`, type: "function", function: effectiveCall }] } : { content: recoveryWarning ? "Fixture accepted correction guidance and changed approach." : "The child fixture has settled." }) }, null) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });
let host: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
try {
  host = await nativeDomainEngine({ binary, modelURL: fixture.url.origin + "/v1", directTools: !nested,
    plugins: [resolve(import.meta.dir, "../src/opencode-plugins/legalwork-tool-output.ts"),
      resolve(import.meta.dir, "../src/opencode-plugins/legalwork-tool-recovery.ts"),
      ...(toolCase === "word" ? [resolve(import.meta.dir, "../src/opencode-plugins/legalwork-extensions-preview.ts")] : []),
      ...(mode === "transport-fixed" ? [resolve(import.meta.dir, "../src/opencode-plugins/legalwork-openai-tool-call-ids.ts")] : [])],
    configuration: { agents: { build: { mode: "primary" }, general: { mode: "subagent" } },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      ...(toolCase === "mcp" ? { mcp: { servers: { fixture: { type: "remote", url: fixture.url.origin + "/mcp", oauth: false } } } } : {}),
    },
  });
  const session = await host.client.session.create({ location: host.location, agent: "build" });
  const started = performance.now();
  await host.client.session.prompt({ sessionID: session.id, text: "Delegate a general child to exercise the argument-loop guard. Report when the child finishes or is cancelled." });
  await host.client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(45000) });
  const children = (await host.client.session.list({ parentID: session.id })).data;
  const sessions = [];
  for (const id of [session.id, ...children.map(child => child.id)]) {
    await host.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(10000) });
    const history = await host.client.session.context({ sessionID: id });
    sessions.push({ id, metadata: (await host.client.session.get({ sessionID: id })).metadata, messages: history.flatMap(message => projectMessage(id, message)), history });
  }
  const report = { mode, toolCase, nested, elapsedMs: Math.round(performance.now() - started), invalidCalls, requests, sessions };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode, elapsedMs: report.elapsedMs, invalidCalls, modelRequests: requests.length, childSessions: children.length, report: join(root, "report.json") }));
} finally { await host?.close(); fixture.stop(true); }
