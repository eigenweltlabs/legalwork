// Real OpenCode + a local MCP fixture; the model responses are deterministic.
// No provider key, network storage or firm data is used. Build legalwork-server first.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedOpencodeServer } from "../../apps/server/src/managed-opencode.ts";

const root = await mkdtemp(join(tmpdir(), "legalwork-mcp-live-"));
let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
let calls = 0;
let step = 0;
let outputPath = "";
let grepPassed = false;
let blocked = false;
const page = {
  results: Array.from({ length: 100 }, (_, i) => ({
    id: `matter-${i}`,
    title: i === 5 ? "MAT-00005" : `matter-${i}`,
    summary: "Synthetic fixture text. ".repeat(80),
  })),
  page: { total: 100 },
};
const mcp = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const v = await req.json();
    if (!("id" in v)) return new Response(null, { status: 202 });
    let result: unknown;
    if (v.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Synthetic memory", version: "1" },
      };
    else if (v.method === "tools/list")
      result = {
        tools: [
          {
            name: "list_matters",
            description: "List synthetic matters",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    else if (v.method === "tools/call") {
      calls++;
      result = { content: [{ type: "text", text: JSON.stringify(page) }] };
    } else result = {};
    return Response.json({ jsonrpc: "2.0", id: v.id, result });
  },
});
async function api(path: string, method = "GET", body?: unknown) {
  if (!engine) throw new Error("Engine not ready");
  const r = await fetch(engine.url + path, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(engine.username + ":" + engine.password).toString("base64"),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(`Engine ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") return Response.json({});
    const body = await req.json();
    let delta: Record<string, unknown> = { role: "assistant", content: "Complete." };
    let finish = "stop";
    if (body.tools?.length) {
      step++;
      const text = JSON.stringify(body.messages);
      let name = "";
      let args: unknown = {};
      if (step === 1) name = "legalmemory_list_matters";
      else if (step === 2) {
        outputPath = text.match(/\/[^"\\\s<>]*\/tool-output\/tool_[A-Za-z0-9]+/)?.[0] ?? "";
        if (!outputPath) throw new Error("Missing spilled output path");
        name = "grep";
        args = { path: outputPath, pattern: "MAT-00005" };
      } else if (step === 3) {
        grepPassed = text.includes("Found 1 matches") && !text.includes("JSON record exceeded");
        await api("/mcp/legalmemory/disconnect?directory=" + encodeURIComponent(root), "POST");
        name = "legalmemory_list_matters";
      } else {
        const lastTool = body.messages.findLast((message: { role: string }) => message.role === "tool");
        blocked = JSON.stringify(lastTool?.content).includes("LegalMemory is disconnected");
      }
      if (name) {
        delta = {
          role: "assistant",
          tool_calls: [
            { index: 0, id: `call_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        };
        finish = "tool_calls";
      }
    }
    const completion = {
      id: "fixture",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, message: delta, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    if (!body.stream) return Response.json(completion);
    return new Response(
      "data: " +
        JSON.stringify({
          ...completion,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        "\n\ndata: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
try {
  await mkdir(join(root, "config"), { recursive: true });
  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: "allow",
    plugin: [
      new URL("../../apps/server/dist/opencode-plugins/legalwork-legalmemory-knowledge.js", import.meta.url).href,
    ],
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Fixture",
        options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
        models: { fixture: { name: "Fixture", limit: { context: 100000, output: 4096 } } },
      },
    },
    mcp: { legalmemory: { type: "remote", url: `http://127.0.0.1:${mcp.port}/mcp`, oauth: false, enabled: true } },
  };
  await writeFile(join(root, "opencode.json"), JSON.stringify(config));
  engine = await createManagedOpencodeServer({
    bin: process.env.LEGALWORK_OPENCODE_BIN || "opencode",
    cwd: root,
    timeoutMs: 30000,
    env: {
      OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG: join(root, "opencode.json"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
    },
  });
  const session = await api("/session?directory=" + encodeURIComponent(root), "POST", {});
  await api("/session/" + session.id + "/message?directory=" + encodeURIComponent(root), "POST", {
    model: { providerID: "fixture", modelID: "fixture" },
    parts: [{ type: "text", text: "Check the synthetic memory fixture and its spilled output." }],
  });
  const spilled = outputPath ? await readFile(outputPath, "utf8") : "";
  const result = {
    calls,
    step,
    grepPassed,
    blocked,
    outputRecords: spilled ? JSON.parse(spilled).results.length : 0,
    maxOutputLine: Math.max(...spilled.split("\n").map((line) => Buffer.byteLength(line))),
  };
  console.log(JSON.stringify(result));
  if (calls !== 1 || !grepPassed || !blocked) throw new Error("Live engine check failed");
} finally {
  await engine?.close();
  mcp.stop(true);
  provider.stop(true);
  await rm(root, { recursive: true, force: true });
}
