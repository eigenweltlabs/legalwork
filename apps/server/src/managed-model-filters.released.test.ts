import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { bootstrapRuntimeOpencodeConfig, closeRuntimeOpencodeConfig, readRuntimeConfigUpgradeBackups, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import type { ServerConfig } from "./types.js";

// Unknown upstream whitelist fields are not a migration strategy. The app
// imports selections explicitly; provider-selection.released.test covers chats.
test.skipIf(!nativeMcpBinary)("parked finite model policy limitation: a whitelist inside native providers is ignored, so forwarding it cannot preserve a restriction", async () => {
  const calls: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { model } = z.object({ model: z.string() }).parse(await request.json()); calls.push(model);
    const chunk = (delta: { role?: string; content?: string }, finish_reason: string | null) => `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "native gap control" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    engine = await nativeMcpEngine({ providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.url.origin + "/v1", apiKey: "synthetic" }, whitelist: ["allowed"], models: { allowed: {}, blocked: {} } } } });
    const models = (await engine.client().model.list({ location: engine.location })).data.filter(model => model.providerID === "fixture");
    expect(models.map(model => model.id).sort()).toEqual(["allowed", "blocked"]);
    const result = await engine.client().generate.text({ model: { providerID: "fixture", id: "blocked" }, prompt: "Synthetic negative control documenting missing native whitelist enforcement" });
    expect(result.text).toBe("native gap control");
    expect(calls).toEqual(["blocked"]);
  } finally { await engine?.close(); provider.stop(true); }
}, 45_000);

test.skipIf(!nativeMcpBinary)("v1 model selections no longer block publication and exact original settings survive reopen and engine restart", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-model-policy-held-")));
  const previous = { ...process.env }, path = join(root, "runtime.sqlite"), workspace = join(root, "project");
  process.env.LEGALWORK_RUNTIME_DB = path; process.env.XDG_CONFIG_HOME = join(root, "private-config");
  let calls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("No model request is authorized in this fixture", { status: 500 }); } });
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "project", name: "Project", path: workspace, workspaceType: "local", preset: "starter" }], authorizedRoots: [workspace], engineConfigurationMode: "native-project", readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const original = '{\n "provider": {"fixture": {"npm":"@ai-sdk/openai-compatible","whitelist":["allowed"],"options":{"apiKey":"synthetic-private-key"}}}\n}';
  const source = () => { const db = new Database(path, { readonly: true }); try { return db.query<{ config_json: string }, []>("SELECT config_json FROM runtime_opencode_configs WHERE workspace_id = 'project'").get()?.config_json; } finally { db.close(); } };
  try {
    await mkdir(workspace);
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    legacy.query("INSERT INTO runtime_opencode_configs VALUES (?, ?, 1)").run("project", original); legacy.close();
    await bootstrapRuntimeOpencodeConfig(config);
    engine = await nativeMcpEngine({ providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.url.origin + "/v1", apiKey: "synthetic" }, models: { allowed: {}, blocked: {} } } } });
    const connection = engine.connection(); config.opencodeBaseUrl = connection.url; config.opencodeUsername = connection.username; config.opencodePassword = connection.password;
    for (const cycle of ["initial", "reopened"]) {
      if (cycle === "reopened") { await closeRuntimeOpencodeConfig(config); await engine.restart(); }
      expect((await readRuntimeOpencodeConfig(config, "project")).providerModelSelection).toEqual({ fixture: ["allowed"] });
      await writeLegalworkRuntimeConfigFile(config, "project");
      expect(source()).toBe(original);
      expect((await readRuntimeConfigUpgradeBackups(config, "project"))[0]?.configJson).toBe(original);
      expect(await readFile(join(workspace, ".opencode", "opencode.json"), "utf8")).toContain("Generated by LegalWork");
      expect(calls).toBe(0);
    }
  } finally { await engine?.close(); provider.stop(true); await closeRuntimeOpencodeConfig(config); for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); await rm(root, { recursive: true, force: true }); }
}, 45_000);
