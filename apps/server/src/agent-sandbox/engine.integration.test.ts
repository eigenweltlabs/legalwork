import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { VmSandbox } from "./vm.js";
import { sandboxEngineAgents, sandboxEnginePermissions } from "./engine-policy.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary || process.env.LEGALWORK_SANDBOX_INTEGRATION !== "1")("the shipped engine calls the protected tool with identity and cannot run host bash", async () => {
  if (!binary) return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-engine-")));
  const folder = join(root, "matter"); await mkdir(folder);
  const sandbox = new VmSandbox();
  const offered: string[][] = [];
  const calls: { agent: string; sessionID: string }[] = [];
  const fixture = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: folder }] });
    if (path === "/workspace/matter/sandbox/execute") {
      const command = z.object({ command: z.string(), write: z.boolean(), agent: z.string(), sessionID: z.string() }).parse(await request.json());
      calls.push(command);
      return Response.json(await sandbox.run({ command: command.command, cwd: "/workspace", mounts: [{ source: folder, target: "/workspace", writable: command.write }],
        timeoutMs: 10000, signal: request.signal, authorizeNetwork: async () => false }));
    }
    const input = z.object({ messages: z.array(z.object({ role: z.string() })), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(await request.json());
    const tools = input.tools?.map(tool => tool.function.name) ?? [];
    if (tools.length) offered.push(tools);
    const invoke = tools.includes("legalwork_shell") && !input.messages.some(message => message.role === "tool");
    const delta = invoke ? { tool_calls: [{ index: 0, id: "call_protected", type: "function", function: { name: "legalwork_shell",
      arguments: JSON.stringify({ command: "python3 -c 'open(\"proof.txt\", \"w\").write(\"inside VM\")'", description: "Write isolation proof", write: true }) } }] } : { content: "Checked." };
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, invoke ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() }), port = reservation.port;
  reservation.stop(true);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ enabled_providers: ["fixture"], model: "fixture/fixture", small_model: "fixture/fixture", share: "disabled", autoupdate: false,
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: fixture.url.origin + "/v1", apiKey: "fixture" }, models: { fixture: { name: "Fixture", limit: { context: 100000, output: 4000 } } } } },
    plugin: [pathToFileURL(join(import.meta.dir, "../../dist/opencode-plugins/legalwork-sandbox.js")).href],
    permission: sandboxEnginePermissions({ "*": "allow" }), agent: sandboxEngineAgents({}), lsp: false, formatter: false,
  }));
  const engine = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: folder, env: {
    ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_TEST_HOME: root, OPENCODE_CONFIG: config, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    LEGALWORK_SERVER_URL: fixture.url.origin, LEGALWORK_SERVER_TOKEN: "fixture",
  }, stdout: "pipe", stderr: "pipe" });
  const logs = new Response(engine.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(base + "/global/health")).ok; } catch { /* Startup. */ }
      if (ready || engine.exitCode !== null) break;
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("Engine did not start: " + (engine.exitCode !== null ? await logs : "timed out"));
    const session = z.object({ id: z.string() }).parse(await (await fetch(base + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json());
    const response = await fetch(`${base}/session/${session.id}/message`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Run the isolation proof." }] }), signal: AbortSignal.timeout(60000) });
    const result = await response.text();
    expect(response.status, result).toBe(200);
    expect(offered.length).toBeGreaterThan(0);
    for (const tools of offered) { expect(tools).not.toContain("bash"); expect(tools).toContain("legalwork_shell"); }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agent: "build", sessionID: session.id });
    expect(await readFile(join(folder, "proof.txt"), "utf8")).toBe("inside VM");
    const direct = await fetch(`${base}/session/${session.id}/shell`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", command: "echo escaped > host-escape.txt" }), signal: AbortSignal.timeout(10000) });
    expect(direct.ok).toBe(false);
    expect(await readFile(join(folder, "host-escape.txt")).catch(() => null)).toBeNull();
  } finally { engine.kill(); await engine.exited; fixture.stop(true); await rm(root, { recursive: true, force: true }); }
}, 120000);
