import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "../managed-opencode.js";
import { assertManagedCommandIntegration, interruptEngineSession } from "../native-command-control.js";

const catalogRpc = { id: "legalwork.sandbox-test", methods: { catalog: { input: { type: "object" }, output: { type: "array", items: { type: "string" } } } }, events: {} };

test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN).each(["build", "legalwork"])("released host sandbox preserves command delegation to %s and blocks unsafe host execution", async delegatedAgent => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-sandbox-")));
  const workspace = join(root, "workspace");
  await Promise.all(["workspace", "home", "config", "data", "state", "cache", "sandbox", "commands", "product", "probe"].map(name => mkdir(join(root, name), { recursive: true })));
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let deniedCommands = 0;
  let waitingCommand = false, commandCancelled = false;
  const completeOutput = "Complete command output: " + "§".repeat(600000) + "END-OF-OUTPUT";
  const relay = Bun.serve({ port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer command-fixture");
    const path = new URL(request.url).pathname;
    if (path === "/v1/responses") {
      const item = { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "Done" }], status: "completed" };
      const response = { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
      return new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: workspace }] });
    if (path.endsWith("/commands/definitions")) return Response.json({ commands: {
      escape: { template: "Show: !`touch command-escape.txt`" },
      complete: { template: "Show: !`allowed`", model: "fixture/fixture" },
      cancellable: { template: "Show: !`waiting`", model: "fixture/fixture" },
      delegated: { template: "Read the supplied attachment and reply Done.", subagent: true, agent: delegatedAgent, model: "fixture/fixture" },
    } });
    if (path.endsWith("/sandbox/command")) {
      const body: unknown = await request.json();
      if (body && typeof body === "object" && "command" in body && body.command === "waiting") {
        waitingCommand = true;
        await new Promise<void>(resolve => { const cancel = () => { commandCancelled = true; resolve(); }; request.signal.addEventListener("abort", cancel, { once: true }); if (request.signal.aborted) cancel(); });
        return Response.json({ output: "cancelled", exitCode: 1, truncated: false });
      }
      if (body && typeof body === "object" && "command" in body && body.command === "allowed") {
        expect(body).toMatchObject({ capture: "complete", timeoutMs: null, workdir: workspace });
        return Response.json({ output: completeOutput, exitCode: 0, truncated: false });
      }
      expect(body).toMatchObject({ sessionID: expect.any(String), agent: "build", command: "touch command-escape.txt", write: true, capture: "complete", timeoutMs: null });
      deniedCommands++;
      return new Response("Fixture shell denial", { status: 403 });
    }
    return new Response("Unknown relay route", { status: 404 });
  } });
  try {
    const entry = join(root, "probe.ts");
    await writeFile(entry, `import {Plugin} from "@opencode/plugin";export default Plugin.define({id:"legalwork.sandbox-test",async setup(ctx){await ctx.rpc.register(${JSON.stringify(catalogRpc)},{async catalog(){return (await ctx.tool.list()).map(tool=>tool.name)}})}});`);
    for (const [source, output] of [[resolve(import.meta.dir, "legalwork-sandbox.ts"), join(root, "sandbox")], [resolve(import.meta.dir, "legalwork-commands.ts"), join(root, "commands")], [resolve(import.meta.dir, "legalwork-product-scope.ts"), join(root, "product")], [entry, join(root, "probe")]]) {
      // Keep the bundler in a fresh process: Bun1.3.14 cannot reliably rebuild
      // a package already imported by another test in this test runner.
      const result = Bun.spawn([process.execPath, "build", source, "--outfile", join(output, "index.js"), "--target", "node", "--format", "esm",
        ...["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"].flatMap(name => ["--external", name])], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()]);
      if (exitCode !== 0) throw new Error("Native command fixture build failed:\n" + stdout + stderr);
    }
    engine = await createManagedOpencodeServer({ bin: process.env.LEGALWORK_TEST_OPENCODE_BIN, cwd: workspace, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      LEGALWORK_SERVER_URL: relay.url.origin, LEGALWORK_SERVER_TOKEN: "command-fixture",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins: [join(root, "sandbox"), join(root, "commands"), join(root, "product"), join(root, "probe"), "-opencode.config.command"],
        agents: { legalwork: { mode: "primary" } },
        commands: { escape: { template: "Show: !`touch command-escape.txt`" } },
        policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }],
        providers: { fixture: { package: "@opencode/ai/providers/openai", settings: { baseURL: relay.url.origin + "/v1", apiKey: "command-fixture" }, models: { fixture: { capabilities: { tools: true } } } } } }),
    } });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const location = { directory: workspace };
    await client.model.list({ location });
    await assertManagedCommandIntegration(client, location);
    const tools = (await client.rpc.call({ rpcID: catalogRpc.id, method: "catalog", input: {}, location })).output;
    expect(tools).toEqual(expect.arrayContaining(["legalwork_shell", "legalwork_webfetch", "legalwork_websearch"]));
    expect(tools).toEqual(expect.arrayContaining(["read", "write", "edit", "subagent"]));
    for (const coding of ["worktree_create", "worktree_list", "worktree_remove"]) expect(tools).not.toContain(coding);
    for (const unsafe of ["shell", "bash", "webfetch", "websearch", "codesearch"]) expect(tools).not.toContain(unsafe);
    await expect(client.shell.create({ location, command: "touch direct-escape.txt" })).rejects.toThrow();
    const session = await client.session.create({ location, title: "Shell guard smoke" });
    await expect(client.session.shell({ sessionID: session.id, command: "touch session-escape.txt" })).rejects.toThrow();
    expect((await client.command.list({ location })).data.some(command => command.name === "escape")).toBe(true);
    await expect(client.session.command({ sessionID: session.id, name: "escape", text: "" })).rejects.toThrow("Fixture shell denial");
    expect(deniedCommands).toBe(1);
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) });
    for (const file of ["direct-escape.txt", "session-escape.txt", "command-escape.txt"]) {
      expect(await readFile(join(workspace, file)).catch(() => null)).toBeNull();
    }
    expect((await client.shell.list({ location })).data).toEqual([]);
    await client.session.command({ sessionID: session.id, name: "complete", text: "" });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) });
    expect((await client.message.list({ sessionID: session.id })).data.some(message => message.type === "user" && message.text === "Show: " + completeOutput)).toBe(true);
    const delegated = await client.session.create({ location, title: "Delegation smoke", model: { providerID: "fixture", id: "fixture" } });
    await client.session.command({ sessionID: delegated.id, name: "delegated", text: "", files: [{ uri: "data:text/plain;base64," + Buffer.from("Read this complete source.").toString("base64"), name: "Source.txt" }] });
    const child = (await client.session.list({ parentID: delegated.id })).data[0];
    if (!child) throw new Error("Native command did not create a child session.");
    expect(child.location.directory).toBe(workspace);
    expect(child.agent).toBe(delegatedAgent);
    expect((await client.agent.list({ location })).data.some(agent => agent.id.startsWith("legalwork-command-"))).toBe(false);
    await client.session.wait({ sessionID: child.id }, { signal: AbortSignal.timeout(10_000) });
    const history = (await client.message.list({ sessionID: child.id })).data;
    expect(history.some(message => message.type === "user" && message.files?.some(file => file.name === "Source.txt"))).toBe(true);
    expect(history.some(message => message.type === "assistant" && message.content.some(part => part.type === "text" && part.text === "Done"))).toBe(true);
    const restricted = await client.session.create({ location, model: { providerID: "fixture", id: "fixture" }, permissions: [{ action: "subagent", resource: "*", effect: "deny" }] });
    await expect(client.session.command({ sessionID: restricted.id, name: "delegated", text: "" })).rejects.toThrow();
    expect((await client.session.list({ parentID: restricted.id })).data).toHaveLength(0);
    const exactDeny = await client.session.create({ location, model: { providerID: "fixture", id: "fixture" }, permissions: [{ action: "subagent", resource: delegatedAgent, effect: "deny" }] });
    await expect(client.session.command({ sessionID: exactDeny.id, name: "delegated", text: "" })).rejects.toThrow();
    expect((await client.session.list({ parentID: exactDeny.id })).data).toHaveLength(0);
    const exactAsk = await client.session.create({ location, model: { providerID: "fixture", id: "fixture" }, permissions: [{ action: "subagent", resource: delegatedAgent, effect: "ask" }] });
    const asking = client.session.command({ sessionID: exactAsk.id, name: "delegated", text: "" });
    void asking.catch(() => {});
    let permission = (await client.permission.list({ sessionID: exactAsk.id }))[0];
    while (!permission) { await Bun.sleep(5); permission = (await client.permission.list({ sessionID: exactAsk.id }))[0]; }
    expect(permission.action).toBe("subagent");
    expect(permission.resources).toEqual([delegatedAgent]);
    await client.permission.reply({ sessionID: exactAsk.id, requestID: permission.id, decision: "reject" });
    await expect(asking).rejects.toThrow();
    expect((await client.session.list({ parentID: exactAsk.id })).data).toHaveLength(0);
    const stopping = await client.session.create({ location, model: { providerID: "fixture", id: "fixture" } });
    const running = client.session.command({ sessionID: stopping.id, name: "cancellable", text: "" });
    void running.catch(() => {});
    while (!waitingCommand) await Bun.sleep(5);
    expect(await interruptEngineSession(client, stopping.id, { managedCommands: true })).toEqual({ interrupted: true });
    await expect(Promise.race([running, Bun.sleep(10_000).then(() => { throw new Error("Stop did not cancel command expansion"); })])).rejects.toThrow("cancelled");
    expect(commandCancelled).toBe(true);
  } finally {
    await engine?.close();
    relay.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
