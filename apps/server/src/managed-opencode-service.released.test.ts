import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { expectedOpencodeServiceFilename } from "@legalwork/opencode-release/candidate";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { stopManagedOpencodeService } from "./managed-opencode-service.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("released service uses private authenticated registration and replaces only its verified predecessor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-service-")));
  const home = join(root, "home"), configDirectory = join(root, "config"), stateDirectory = join(root, "state");
  await mkdir(home);
  const options = { bin: binary, cwd: root, timeoutMs: 30_000, service: { configDirectory, stateDirectory }, env: {
    HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
  } };
  const first = await createManagedOpencodeServer(options);
  let second: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    const filename = await expectedOpencodeServiceFilename(binary!);
    const registration = JSON.parse(await readFile(join(stateDirectory, "opencode", filename), "utf8"));
    expect(registration.pid).toBe(first.pid);
    expect(registration.password).toBe(first.password);
    expect(first.execution.args).toContain("--service");
    expect(first.execution.env.some(entry => entry.name === "OPENCODE_PASSWORD")).toBe(false);
    const client = OpenCode.make({ baseUrl: first.url, headers: { Authorization: `Basic ${Buffer.from(`${first.username}:${first.password}`).toString("base64")}` } });
    expect(first.pid).toBe((await client.server.info()).pid);
    let predecessorExited = false;
    second = await createManagedOpencodeServer({ ...options, beforeSpawn: async () => { predecessorExited = !first.running(); } });
    expect(predecessorExited).toBe(true);
    expect(first.running()).toBe(false);
    expect(second.pid).not.toBe(first.pid);
    expect(JSON.parse(await readFile(join(stateDirectory, "opencode", filename), "utf8")).pid).toBe(second.pid);
    expect(second.running()).toBe(true);
    // The lifecycle coordinator's ordinary private stop must also find a
    // verified custom-channel predecessor, without an arbitrary file input.
    await stopManagedOpencodeService({ configDirectory, stateDirectory });
    expect(second.running()).toBe(false);
  } finally { await second?.close(); await first.close(); await rm(root, { recursive: true, force: true }); }
}, 45_000);

test.skipIf(!binary)("released service resumes an interrupted native turn and its durable inbox without client replay", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-recovery-")));
  const home = join(root, "home"), directory = join(root, "project"); await Promise.all([home, directory].map(path => mkdir(path)));
  let requests = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    await request.json(); const call = ++requests, id = `resp_${call}`;
    if (call === 1) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } })}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } });
    const item = { type: "message", id: `msg_${call}`, role: "assistant", content: [{ type: "output_text", text: `Recovered ${call}` }], status: "completed" };
    return new Response([
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const options = { bin: binary, cwd: root, timeoutMs: 30_000, service: { configDirectory: join(root, "config"), stateDirectory: join(root, "state") }, env: {
    HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", model: "openai/fixture", providers: { openai: {
      settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", transport: "http" }, models: { fixture: { modelID: "fixture" } },
    } } }),
  } };
  let engine = await createManagedOpencodeServer(options);
  const clientFor = () => OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
  const until = async (condition: () => Promise<boolean>) => { const deadline = Date.now() + 20_000; while (!await condition()) { if (Date.now() > deadline) throw new Error("Native recovery fixture did not settle"); await Bun.sleep(20); } };
  try {
    let client = clientFor();
    const session = await client.session.create({ location: { directory }, title: "Durable native inbox fixture" });
    await client.session.prompt({ sessionID: session.id, id: "msg_restart_first", text: "First durable turn" });
    await until(async () => requests === 1);
    await client.session.prompt({ sessionID: session.id, id: "msg_restart_second", text: "Second durable turn", delivery: "queue" });
    expect((await client.session.inbox.list({ sessionID: session.id })).length).toBeGreaterThan(0);
    if (!engine.pid) throw new Error("A released engine process is required");
    process.kill(engine.pid, "SIGKILL");
    await until(async () => !engine.running());
    await engine.close();
    engine = await createManagedOpencodeServer(options);
    client = clientFor();
    try { await until(async () => requests >= 2 && (await client.session.inbox.list({ sessionID: session.id })).length === 0 && !(await client.session.active())[session.id]); }
    catch (error) { throw new Error(JSON.stringify({ requests, active: await client.session.active(), inbox: await client.session.inbox.list({ sessionID: session.id }), history: await client.session.context({ sessionID: session.id }) }), { cause: error }); }
    const history = await client.session.context({ sessionID: session.id });
    const text = JSON.stringify(history);
    expect(text).toContain("First durable turn");
    expect(text).toContain("Second durable turn");
    expect(text).toContain("Recovered");
    expect(history.filter(message => message.type === "user" && message.text === "First durable turn")).toHaveLength(1);
    expect(history.filter(message => message.type === "user" && message.text === "Second durable turn")).toHaveLength(1);
    expect(requests).toBeGreaterThanOrEqual(2);
  } finally { await engine.close(); model.stop(true); await rm(root, { recursive: true, force: true }); }
}, 45_000);
