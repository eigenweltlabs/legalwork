import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.OPENCODE_TEST_BINARY;

async function waitFor(check: () => Promise<boolean>, label: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

/** No provider account, credentials, or running app is used. Every engine file
 * and project belongs to this fixture; the provider only streams synthetic text.
 * Run explicitly with OPENCODE_TEST_BINARY pointing to the shipped sidecar. */
test.skipIf(!binary)("stopping a parent cancels its background child and leaves unrelated runs progressing", async () => {
  if (!binary) return;
  const version = object(JSON.parse(await readFile(join(import.meta.dir, "../../../constants.json"), "utf8"))).opencodeVersion;
  if (typeof version !== "string") throw new Error("constants.json has no engine version");
  const installed = Bun.spawnSync([binary, "--version"]);
  expect(installed.exitCode).toBe(0);
  expect(`v${installed.stdout.toString().trim()}`).toBe(version);
  const root = await realpath(await mkdtemp(join(tmpdir(), "session-stop-engine-")));
  const directories = [join(root, "project-a"), join(root, "project-b")];
  for (const directory of directories) {
    await mkdir(directory);
    const git = Bun.spawnSync(["git", "init", "--quiet", directory]);
    expect(git.exitCode).toBe(0);
  }
  const streams = new Map<string, { finish: () => void; count: number; closed: boolean }>();
  const encoder = new TextEncoder();
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = object(await request.json());
    if (!Array.isArray(input.messages)) return new Response("Missing messages", { status: 400 });
    const messages = input.messages.map(object);
    const prompt = JSON.stringify(messages.filter(message => message.role === "user"));
    const marker = ["fixture-child-a", "fixture-child-b", "fixture-a", "fixture-sibling", "fixture-b"].find(value => prompt.includes(value));
    if (!marker) return new Response("Unknown fixture prompt", { status: 400 });
    const chunk = (delta: unknown, finish_reason: string | null = null) => encoder.encode(`data: ${JSON.stringify({
      id: marker, object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if ((marker === "fixture-a" || marker === "fixture-b") && !messages.some(message => message.role === "tool")) {
      const args = { description: "Stream a background fixture", prompt: `Stream fixture-child-${marker.slice(-1)}`, subagent_type: "general", background: true };
      return new Response(new Blob([
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${marker}`, type: "function", function: { name: "task", arguments: JSON.stringify(args) } }] }),
        chunk({}, "tool_calls"), "data: [DONE]\n\n",
      ]), { headers: { "content-type": "text/event-stream" } });
    }
    // A child completion may wake its parent for a final acknowledgement.
    if (streams.get(marker)?.closed) return new Response(new Blob([
      chunk({ role: "assistant", content: "Fixture complete." }), chunk({}, "stop"), "data: [DONE]\n\n",
    ]), { headers: { "content-type": "text/event-stream" } });
    let timer: ReturnType<typeof setInterval>;
    const state = { count: 0, closed: false, finish: () => {} };
    streams.set(marker, state);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk({ role: "assistant" }));
        timer = setInterval(() => {
          state.count++;
          controller.enqueue(chunk({ content: ` ${marker}:${state.count}` }));
        }, 50);
        state.finish = () => {
          if (state.closed) return;
          state.closed = true;
          clearInterval(timer);
          controller.enqueue(chunk({}, "stop"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
      cancel() { state.closed = true; clearInterval(timer); },
    }), { headers: { "content-type": "text/event-stream" } });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    enabled_providers: ["fixture"], model: "fixture/fixture", small_model: "fixture/fixture",
    share: "disabled", autoupdate: false, lsp: false, formatter: false, permission: { "*": "allow" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: provider.url.origin + "/v1", apiKey: "fixture" },
      models: { fixture: { name: "Fixture", limit: { context: 100000, output: 4000 } } } } },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPENCODE_") && !name.startsWith("LEGALWORK_")));
  const engine = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directories[0], env: {
      ...env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG: config, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
    }, stdout: "pipe", stderr: "pipe",
  });
  const logs = new Response(engine.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  const request = async (directory: string, path: string, body?: unknown) => {
    const url = new URL(path, base);
    url.searchParams.set("directory", directory);
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
    const result: unknown = text ? JSON.parse(text) : null;
    return result;
  };
  try {
    await waitFor(async () => {
      if (engine.exitCode !== null) throw new Error(await logs);
      try { return (await fetch(base + "/global/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, "engine startup", 30000);
    const create = async (directory: string, title: string) => {
      const session = object(await request(directory, "/session", { title }));
      if (typeof session.id !== "string") throw new Error("Session has no ID");
      return { directory, id: session.id, marker: title };
    };
    const a = await create(directories[0], "fixture-a");
    const sibling = await create(directories[0], "fixture-sibling");
    const b = await create(directories[1], "fixture-b");
    const runs = [a, sibling, b];
    for (const run of runs) await request(run.directory, `/session/${run.id}/prompt_async`, {
      model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: `Stream ${run.marker}` }],
    });
    const markers = [...runs.map(run => run.marker), "fixture-child-a", "fixture-child-b"];
    await waitFor(async () => markers.every(marker => (streams.get(marker)?.count ?? 0) >= 3), "all parent and background streams");
    const childOf = async (parent: typeof a, marker: string) => {
      const children = await request(parent.directory, `/session/${parent.id}/children`);
      if (!Array.isArray(children) || children.length !== 1) throw new Error("Expected one background child");
      const child = object(children[0]);
      if (typeof child.id !== "string") throw new Error("Child has no ID");
      return { directory: parent.directory, id: child.id, marker };
    };
    const childA = await childOf(a, "fixture-child-a"), childB = await childOf(b, "fixture-child-b");
    const messages = async (run: typeof a) => JSON.stringify(await request(run.directory, `/session/${run.id}/message`));
    expect(await request(a.directory, `/session/${a.id}/abort`, {})).toBe(true);
    await waitFor(async () => {
      const statuses = object(await request(a.directory, "/session/status"));
      return [a, childA].every(run => statuses[run.id] === undefined || object(statuses[run.id]).type === "idle");
    }, "stopped parent and its background child idle");
    expect(streams.get(a.marker)?.closed).toBe(true);
    expect(streams.get(childA.marker)?.closed).toBe(true);
    const survivors = [sibling, b, childB];
    const afterStop = new Map(survivors.map(run => [run.marker, streams.get(run.marker)?.count ?? 0]));
    await waitFor(async () => survivors.every(run => (streams.get(run.marker)?.count ?? 0) >= (afterStop.get(run.marker) ?? 0) + 3), "unrelated streams continue after stop");
    for (const run of survivors) {
      expect(object(object(await request(run.directory, "/session/status"))[run.id]).type).toBe("busy");
      expect(streams.get(run.marker)?.closed).toBe(false);
      streams.get(run.marker)?.finish();
    }
    await waitFor(async () => (await Promise.all(survivors.map(async run => {
      const status = object(await request(run.directory, "/session/status"))[run.id];
      return status === undefined || object(status).type === "idle";
    }))).every(Boolean), "unrelated runs finish normally");
    // Streaming text is buffered in the engine. Confirm persisted transcripts
    // include text produced after the abort, not merely an open HTTP socket.
    for (const run of survivors) expect(await messages(run)).toContain(`${run.marker}:${(afterStop.get(run.marker) ?? 0) + 3}`);
  } finally {
    for (const stream of streams.values()) stream.finish();
    engine.kill("SIGKILL"); await engine.exited;
    provider.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
