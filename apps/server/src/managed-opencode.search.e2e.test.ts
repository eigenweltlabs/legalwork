import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { listEngineMessages } from "./engine-client.js";
import { z } from "zod";
import { createManagedOpencodeServer } from "./managed-opencode.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;

test.skipIf(!binary)("filename mentions and agent file tools work without FFF in the shipped engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-search-engine-"));
  const directory = join(root, "matter");
  const contract = join(directory, "Matter-A", "contract.txt");
  const tools = [
    { name: "glob", args: { pattern: "Matter-A/*.txt", path: directory } },
    { name: "grep", args: { pattern: "fixture-clause", path: directory, include: "Matter-A/*.txt" } },
    { name: "read", args: { path: contract } },
  ];
  let nextTool = 0;
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(await request.json());
    const selected = input.tools?.length ? tools[nextTool] : undefined;
    if (selected) {
      expect(input.tools?.some(tool => tool.function.name === selected.name)).toBe(true);
      nextTool += 1;
    }
    const delta = selected ? { tool_calls: [{ index: 0, id: `fixture-${nextTool}`, type: "function", function: {
      name: selected.name, arguments: JSON.stringify(selected.args),
    } }] } : { content: "Search check complete." };
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`;
    return new Response(chunk({ role: "assistant", ...delta }, null)
      + chunk({}, selected ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  } });
  try {
    await mkdir(join(directory, "Matter-A"), { recursive: true });
    await writeFile(contract, "The fixture-clause permits assignment.\n");
    const config = join(root, "opencode.json");
    await writeFile(config, JSON.stringify({
      plugins: [], permissions: [{ action: "*", resource: "*", effect: "allow" }],
      policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }],
      providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", name: "Fixture", settings: {
        baseURL: model.url.origin + "/v1", apiKey: "fixture",
      }, models: { fixture: { modelID: "fixture", name: "Fixture", capabilities: { tools: true }, limit: { context: 128000, output: 4096 } } } } },
      model: "fixture/fixture", update: "disable", lsp: false, formatter: false,
    }));
    engine = await createManagedOpencodeServer({ bin: binary, cwd: directory, env: {
      OPENCODE_CONFIG: config, OPENCODE_CONFIG_CONTENT: "", OPENCODE_CONFIG_DIR: join(root, "policy"),
      OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "engine.db"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    } });
    const client = OpenCode.make({ baseUrl: engine.url,
      headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` },
    });
    // The filename index fills in the background; use the same SDK call as the composer.
    let matches: string[] = [];
    for (let attempt = 0; attempt < 100 && !matches.length; attempt += 1) {
      const result = await client.file.find({ location: { directory }, query: "contract", limit: 50 });
      matches = result.data.map(entry => entry.path);
      if (!matches.length) await Bun.sleep(50);
    }
    expect(matches.map(path => path.replaceAll("\\", "/"))).toContain("Matter-A/contract.txt");
    const folders = await client.file.find({ location: { directory }, query: "Matter-A", type: "directory", limit: 50 });
    expect(folders.data.map(entry => entry.path.replaceAll("\\", "/").replace(/\/$/, ""))).toContain("Matter-A");

    const session = await client.session.create({ location: { directory }, title: "Search fallback check" });
    await client.session.prompt({ sessionID: session.id, text: "Find the contract and read its assignment clause." });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
    expect((await client.session.get({ sessionID: session.id })).outcome).toBe("succeeded");
    const history = await listEngineMessages(client, session.id);
    const calls = history.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool") : []);
    expect(nextTool).toBe(3);
    expect(calls.map(call => call.name)).toEqual(["glob", "grep", "read"]);
    for (const call of calls) {
      expect(call.state.status).toBe("completed");
      if (call.state.status === "completed") expect(JSON.stringify(call.state.content)).toContain(call.name === "glob" ? "contract.txt" : "fixture-clause");
    }
  } finally {
    await engine?.close();
    model.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
