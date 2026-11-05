import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { approveEngineProject } from "./engine-project.js";
import { createEngineClient } from "./engine-client.js";
import { createConfiguredManagedEngine, startManagedEngineLifecycle } from "./managed-engine-lifecycle.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("one released engine holds unapproved recovery, keeps healthy chats usable, and promotes only after current work finishes", async () => {
  const evidence = process.env.LEGALWORK_TEST_ENGINE_LIFECYCLE_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { mode: 0o700 });
  const root = await realpath(evidence ?? await mkdtemp(join(tmpdir(), "legalwork-recovery-coordinator-")));
  const snapshots: Array<{ phase: string; at: number; data: unknown }> = [];
  const snapshot = (phase: string, data: unknown) => snapshots.push({ phase, at: Date.now(), data });
  const wires: Array<{ url: string; method: string; headers: Record<string, string>; body: string; sent: string[]; closed: boolean; canceled: boolean }> = [];
  const first = join(root, "first"), second = join(root, "second"), home = join(root, "home");
  await Promise.all([first, second, home].map(directory => mkdir(directory)));
  const workspace: WorkspaceInfo = { id: "first", path: first, name: "First", workspaceType: "local", preset: "starter" };
  const healthy: WorkspaceInfo = { ...workspace, id: "second", path: second, name: "Second" };
  const config: ServerConfig = { configPath: join(root, "private", "server.json"), host: "127.0.0.1", port: 0,
    token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [workspace, healthy], authorizedRoots: [first, second], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, engineProjectTrustRequired: true };
  const until = async (condition: () => Promise<boolean>) => { const deadline = Date.now() + 20_000; while (!await condition()) { if (Date.now() > deadline) throw new Error("Native lifecycle fixture did not settle"); await Bun.sleep(20); } };
  let requests = 0;
  let finishHealthy: (() => void) | undefined;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.text(), call = ++requests, id = `resp_${call}`;
    const wire: typeof wires[number] = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body, sent: [], closed: false, canceled: false };
    wires.push(wire);
    const item = { type: "message", id: `msg_${call}`, role: "assistant", content: [{ type: "output_text", text: body.includes("Healthy hold") ? "Healthy done" : "Recovered old" }], status: "completed" };
    const tail = [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(new ReadableStream({ start(controller) {
      const send = (text: string) => { controller.enqueue(new TextEncoder().encode(text)); wire.sent.push(text); };
      const finish = () => { send(tail); controller.close(); wire.closed = true; };
      send(`data: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } })}\n\n`);
      if (call === 1) return;
      if (body.includes("Healthy hold")) { finishHealthy = finish; return; }
      finish();
    }, cancel() { wire.canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const database = join(root, "engine.db"), service = { configDirectory: join(root, "config"), stateDirectory: join(root, "state") };
  const options = { bin: binary, cwd: home, timeoutMs: 30_000, env: {
    HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: service.stateDirectory,
    OPENCODE_DB: database, OPENCODE_CONFIG_DIR: service.configDirectory, OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", model: "openai/fixture", providers: { openai: {
      settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", transport: "http" }, models: { fixture: { modelID: "fixture" } },
    } } }),
  } };
  let initial: Awaited<ReturnType<typeof startManagedEngineLifecycle>> | undefined;
  let lifecycle: Awaited<ReturnType<typeof startManagedEngineLifecycle>> | undefined;
  try {
    expect(await lstat(database).catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    })).toBeUndefined();
    snapshot("before-first-launch", { databaseExists: false });
    const create = (mode: "service" | "recovery", beforeSpawn?: () => Promise<void>) => createConfiguredManagedEngine(config, {
      ...options, beforeSpawn, ...(mode === "service" ? { service } : { parentLease: true }),
    });
    initial = await startManagedEngineLifecycle({ config, database, service, create });
    const original = initial.engine, initialAffinity = config.managedImageAffinity?.(workspace);
    expect(initialAffinity).toBeDefined();
    expect(config.managedImageAffinity?.(workspace)).toBe(initialAffinity);
    expect((await lstat(database)).isFile()).toBe(true);
    expect(config.managedEngineRecoveryState?.().mode).toBe("service");
    snapshot("fresh-managed-start", { pid: original.pid, storageNamespace: initialAffinity?.storageNamespace, mode: config.managedEngineRecoveryState?.().mode });
    const originalClient = OpenCode.make({ baseUrl: original.url, headers: { Authorization: `Basic ${Buffer.from(`${original.username}:${original.password}`).toString("base64")}` } });
    const old = await originalClient.session.create({ location: { directory: first }, title: "Interrupted old" });
    await originalClient.session.prompt({ sessionID: old.id, id: "msg_coordinator_old", text: "Interrupted old" });
    await until(async () => requests === 1);
    if (!original.pid) throw new Error("An engine PID is required");
    snapshot("before-interrupted-seed", { pid: original.pid, session: await originalClient.session.get({ sessionID: old.id }), history: await originalClient.session.context({ sessionID: old.id }), requests });
    process.kill(original.pid, "SIGKILL"); await until(async () => !original.running()); await initial.close(); initial = undefined;
    expect(config.managedImageAffinity).toBeUndefined();
    snapshot("initial-owner-closed", { pid: original.pid, running: original.running(), affinityRemoved: config.managedImageAffinity === undefined });
    await approveEngineProject(config, healthy, second, []);
    lifecycle = await startManagedEngineLifecycle({ config, database, service, create });
    const recoveryAffinity = config.managedImageAffinity?.(healthy);
    expect(recoveryAffinity).toBeDefined();
    expect(recoveryAffinity).not.toBe(initialAffinity);
    expect(recoveryAffinity?.storageNamespace).toBe(initialAffinity?.storageNamespace);
    expect(config.managedImageAffinity?.(healthy)).toBe(recoveryAffinity);
    expect(config.managedImageAffinity?.({ ...healthy, baseUrl: "http://127.0.0.1:1" })).toBeUndefined();
    expect(config.managedImageAffinity?.({ ...healthy, opencodePassword: "not-the-owned-password" })).toBeUndefined();
    expect(config.managedEngineRecoveryState?.().mode).toBe("recovery");
    expect(lifecycle.engine.execution.args).toContain("--stdio");
    expect(lifecycle.engine.execution.args).not.toContain("--service");
    expect(config.managedEngineRecoveryState?.().heldSessions.map(session => session.id)).toEqual([old.id]);
    expect(requests).toBe(1);
    snapshot("held-recovery", { pid: lifecycle.engine.pid, storageNamespace: recoveryAffinity?.storageNamespace, sameNamespace: recoveryAffinity?.storageNamespace === initialAffinity?.storageNamespace,
      newConnection: recoveryAffinity !== initialAffinity, state: config.managedEngineRecoveryState?.(), requests });
    const healthyClient = createEngineClient(config, healthy);
    const current = await healthyClient.session.create({ location: { directory: second }, title: "Healthy current" });
    await healthyClient.session.prompt({ sessionID: current.id, id: "msg_coordinator_healthy", text: "Healthy hold" });
    await until(async () => Boolean(finishHealthy));
    const plainPID = lifecycle.engine.pid;
    await approveEngineProject(config, workspace, first, []);
    await lifecycle.refresh();
    expect(config.managedEngineRecoveryState?.().mode).toBe("recovery");
    expect(lifecycle.engine.pid).toBe(plainPID);
    expect((await healthyClient.session.active())[current.id]).toBeDefined();
    expect(config.managedImageAffinity?.(healthy)).toBe(recoveryAffinity);
    await expect(createEngineClient(config, workspace).session.prompt({ sessionID: old.id, text: "Do not replay" })).rejects.toMatchObject({ cause: { code: "engine_recovery_held" } });
    finishHealthy?.();
    await until(async () => config.managedEngineRecoveryState?.().mode === "service");
    const serviceAffinity = config.managedImageAffinity?.(workspace);
    expect(serviceAffinity).toBeDefined();
    expect(serviceAffinity).not.toBe(recoveryAffinity);
    expect(serviceAffinity?.storageNamespace).toBe(recoveryAffinity?.storageNamespace);
    expect(config.managedImageAffinity?.(healthy)).toBe(serviceAffinity);
    const finalClient = createEngineClient(config, workspace);
    await until(async () => !(await finalClient.session.active())[old.id] && requests >= 3);
    const history = await finalClient.session.context({ sessionID: old.id });
    expect(history.filter(message => message.type === "user" && message.text === "Interrupted old")).toHaveLength(1);
    expect(JSON.stringify(history)).toContain("Recovered old");
    expect(config.managedEngineRecoveryState?.().heldSessions).toEqual([]);
    expect(lifecycle.engine.pid).not.toBe(plainPID);
    expect(JSON.stringify(await createEngineClient(config, healthy).session.context({ sessionID: current.id }))).toContain("Healthy done");
    snapshot("promoted-service", { pid: lifecycle.engine.pid, storageNamespace: serviceAffinity?.storageNamespace, sameNamespace: serviceAffinity?.storageNamespace === recoveryAffinity?.storageNamespace,
      newConnection: serviceAffinity !== recoveryAffinity, state: config.managedEngineRecoveryState?.(), requests, oldHistory: history,
      healthyHistory: await createEngineClient(config, healthy).session.context({ sessionID: current.id }) });
    await lifecycle.close();
    expect(config.managedImageAffinity).toBeUndefined();
    expect(lifecycle.engine.running()).toBe(false);
    snapshot("final-owner-closed", { pid: lifecycle.engine.pid, running: lifecycle.engine.running(), affinityRemoved: config.managedImageAffinity === undefined, requests });
  } catch (error) {
    snapshot("failure", { name: error instanceof Error ? error.name : "Unknown", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    try { await lifecycle?.close(); await initial?.close(); }
    finally {
      model.stop(true);
      if (evidence) {
        await writeFile(join(root, "lifecycle-snapshots.json"), JSON.stringify(snapshots, null, 2));
        await writeFile(join(root, "synthetic-provider-transport.json"), JSON.stringify(wires, null, 2));
        for (const [index, wire] of wires.entries()) {
          await writeFile(join(root, `provider-request-${index + 1}.json`), wire.body);
          await writeFile(join(root, `provider-sent-${index + 1}.sse`), wire.sent.join(""));
        }
      } else await rm(root, { recursive: true, force: true });
    }
  }
}, 45_000);
