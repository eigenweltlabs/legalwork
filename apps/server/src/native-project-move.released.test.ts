import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("real Code Mode preserves approved chat moves and rejects unapproved canonical destinations before activation", async () => {
  const root = await realpath(await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/native-chat-move-")));
  const source = join(root, "source"), target = join(root, "target"), unapproved = join(root, "unapproved"), guard = join(root, "guard");
  const registryPath = join(root, "projects.json"), marker = join(root, "unapproved-mcp-started");
  const rounds = new Map<string, number>();
  const destinations = { blocked: unapproved, alias: join(source, "outside-alias"), allowed: target };
  let modelCalls = 0;
  let auxiliaryCalls = 0;
  let moveRequests = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const payload: { tools?: { name?: string }[] } = await request.json();
    const text = JSON.stringify(payload);
    const primary = payload.tools?.some(tool => tool.name === "execute") === true;
    const name = primary ? Object.keys(destinations).find(name => text.includes(`fixture-${name}`)) : undefined;
    if (primary && (!name || !(name in destinations))) return new Response("Unknown fixture", { status: 400 });
    const destination = Object.entries(destinations).find(([key]) => key === name)?.[1];
    let round = 0;
    if (primary && name) { round = rounds.get(name) ?? 0; rounds.set(name, round + 1); modelCalls++; }
    else auxiliaryCalls++;
    const call = primary && round === 0, sequence = primary ? `primary_${modelCalls}` : `auxiliary_${auxiliaryCalls}`, id = `response_${sequence}`;
    if (call && !destination) throw new Error("Missing fixture destination");
    if (call) moveRequests++;
    const item = call
      ? { type: "function_call", id: `function_${sequence}`, call_id: `call_${sequence}`, name: "execute", arguments: JSON.stringify({ code: `await tools.opencode.session_move({directory:${JSON.stringify(destination)}}); return "moved";` }), status: "completed" }
      : { type: "message", id: `message_${sequence}`, role: "assistant", content: [{ type: "output_text", text: primary ? "Done" : "Fixture chat move" }], status: "completed" };
    const events = [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: call ? { ...item, arguments: "" } : item },
      ...(call ? [{ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments }, { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments }] : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    // Native title/summary requests can arrive before the primary turn. Force
    // that order once without consuming any scenario's first execute response.
    const auxiliary = await fetch(model.url, { method: "POST", body: JSON.stringify({ input: "fixture-blocked", tools: [] }) });
    expect(await auxiliary.text()).not.toContain('"function_call"');
    expect(modelCalls).toBe(0); expect(moveRequests).toBe(0);
    await Promise.all([source, target, unapproved, guard, ...["home", "config", "data", "state", "cache"].map(name => join(root, name))].map(path => mkdir(path, { recursive: true })));
    await symlink(unapproved, destinations.alias, "dir");
    await writeFile(registryPath, JSON.stringify({ version: 1, projects: [{ directory: source, approved: true }, { directory: target, approved: true }, { directory: unapproved, approved: false }] }));
    await writeFile(join(unapproved, "opencode.json"), JSON.stringify({ mcp: { servers: { marker: { type: "local", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] } } } }));
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "opencode-plugins/legalwork-project-admission.ts")], outdir: guard, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
    if (!build.success) throw new AggregateError(build.logs, "Native admission fixture must build");
    engine = await createManagedOpencodeServer({ bin: binary, cwd: source, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "0",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", plugins: [{ package: guard, options: { registryPath } }], model: "openai/fixture", permissions: [{ action: "*", resource: "*", effect: "allow" }], providers: { openai: { settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "synthetic", transport: "http" }, models: { fixture: { modelID: "fixture", limit: { context: 128000, output: 4096 }, capabilities: { tools: true } } } } } }),
    } });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    await client.model.list({ location: { directory: source } });
    for (const name of Object.keys(destinations)) {
      const session = await client.session.create({ location: { directory: source }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
      await client.session.prompt({ sessionID: session.id, text: `fixture-${name}` });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) });
      const saved = await client.session.get({ sessionID: session.id });
      const context = JSON.stringify((await client.message.list({ sessionID: session.id })).data);
      expect(saved.location.directory, context).toBe(name === "allowed" ? target : source);
      expect(context).toContain(name === "allowed" ? "moved" : "Open the destination project in LegalWork");
      expect(existsSync(marker)).toBe(false);
    }
    expect(moveRequests).toBe(3);
    expect(modelCalls).toBeGreaterThanOrEqual(6);
    expect(await client.session.active()).toEqual({});
  } finally { await engine?.close(); model.stop(true); await rm(root, { recursive: true, force: true }); }
}, 90_000);
