import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { approveEngineProject } from "./engine-project.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("passive global events keep an unapproved default inactive and stream only authorized public sessions", async () => {
  const root = await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/passive-native-events-"));
  const previous = { ...process.env };
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
  for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[name] = join(root, name);
  process.env.LEGALWORK_RUNTIME_DB = join(root, "private", "runtime.sqlite"); process.env.LEGALWORK_TOKEN_STORE = join(root, "private", "tokens.json");
  const a = join(root, "unapproved"), b = join(root, "approved"), outside = join(root, "outside"), plugin = join(a, "fixture-plugin");
  await Promise.all([a, b, outside, plugin, join(root, "config")].map(path => mkdir(path, { recursive: true })));
  const pluginMarker = join(root, "plugin-started"), mcpMarker = join(root, "mcp-started");
  await writeFile(join(plugin, "index.js"), `import{writeFileSync}from'node:fs';import{Plugin}from'@opencode/plugin';writeFileSync(${JSON.stringify(pluginMarker)},'activated');export default Plugin.define({id:'fixture.passive-event-marker',setup(){}});`);
  await writeFile(join(a, "opencode.jsonc"), JSON.stringify({ plugins: [plugin], mcp: { servers: { marker: { type: "local", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)},'activated')`] } } } }));
  engine = await createManagedOpencodeServer({ bin: binary, cwd: root, timeoutMs: 30_000, env: {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false }),
  } });
  const config: ServerConfig = { configPath: join(root, "private", "server.json"), host: "127.0.0.1", port: 0, token: "fixture-collaborator", hostToken: "fixture-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "a", name: "Unapproved", path: a, preset: "starter", workspaceType: "local" }, { id: "b", name: "Approved", path: b, preset: "starter", workspaceType: "local" }], authorizedRoots: [a, b], readOnly: true, engineProjectTrustRequired: true,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, opencodeBaseUrl: engine.url, opencodeUsername: engine.username, opencodePassword: engine.password };
  await approveEngineProject(config, config.workspaces[1]!, b, []);
  server = await startServer(config);
  const privateClient = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const response = await fetch(`http://127.0.0.1:${server.port}/w/a/opencode/api/event`, { headers: { authorization: `Bearer ${config.token}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Missing scoped event stream");
    reader = response.body.getReader(); const decoder = new TextDecoder(); let frames = "";
    const until = async (predicate: () => boolean) => {
      const timer = setTimeout(() => controller.abort(), 10_000);
      try { while (!predicate()) { const next = await reader!.read(); if (next.done) throw new Error("Event stream closed early"); frames += decoder.decode(next.value, { stream: true }); } }
      finally { clearTimeout(timer); }
    };
    await until(() => frames.includes("server.connected"));
    expect(existsSync(pluginMarker)).toBe(false); expect(existsSync(mcpMarker)).toBe(false);
    const hidden = await privateClient.session.create({ location: { directory: outside }, title: "Unregistered" });
    const internal = await privateClient.session.create({ location: { directory: b }, title: "Private operation", metadata: { legalworkInternal: "legalmemory" } });
    await privateClient.session.synthetic({ sessionID: internal.id, text: "private internal payload", resume: false });
    await privateClient.credential.create({ integrationID: "fixture", value: { type: "key", key: "synthetic-never-public" }, activate: true });
    const visible = await privateClient.session.create({ location: { directory: b }, title: "Approved project event" });
    await until(() => frames.includes(visible.id));
    expect(frames).toContain(visible.id); expect(frames).not.toContain(hidden.id); expect(frames).not.toContain(internal.id);
    expect(frames).not.toContain("private internal payload"); expect(frames).not.toContain("synthetic-never-public");
    expect(existsSync(pluginMarker)).toBe(false); expect(existsSync(mcpMarker)).toBe(false);
    const denied = await fetch(`http://127.0.0.1:${server.port}/w/a/opencode/api/model`, { headers: { authorization: `Bearer ${config.token}` } });
    expect(denied.status).toBe(409);
    await reader.cancel(); reader.releaseLock(); reader = undefined; controller.abort();
    // Positive control: raw trusted native activation runs these same valid
    // definitions, so passive subscription did not merely ignore a bad fixture.
    await privateClient.model.list({ location: { directory: a } });
    const deadline = Date.now() + 5000; while (!existsSync(mcpMarker) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(pluginMarker)).toBe(true); expect(existsSync(mcpMarker)).toBe(true);
  } finally {
    controller.abort(); await reader?.cancel().catch(() => undefined); reader?.releaseLock();
    await server?.stop(); await engine?.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
